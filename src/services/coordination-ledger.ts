import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { config } from '../config.js';
import { atomicWriteFileSync } from '../utils/atomic-write.js';
import { withFileLock } from '../utils/file-lock.js';
import { logger } from '../utils/logger.js';
import type { LarkMention } from '../types.js';

export type CoordinationLedgerStatus = 'new' | 'duplicate' | 'followup';
export type CoordinationSourceType = 'human' | 'bot';

export interface CoordinationPromptContext {
  coordinationId: string;
  taskKey: string;
  ledgerStatus: CoordinationLedgerStatus;
  sourceType: CoordinationSourceType;
  sourceBotName?: string;
  assigneeLarkAppId: string;
  assigneeName?: string;
  objective: string;
  sourceMessageIds: string[];
  idempotencyKey: string;
}

interface CoordinationLedgerEntry {
  id: string;
  coordinationId: string;
  taskKey: string;
  inputHash: string;
  idempotencyKey: string;
  assigneeLarkAppId: string;
  assigneeName?: string;
  sourceType: CoordinationSourceType;
  sourceBotName?: string;
  sourceOpenId?: string;
  sourceMessageIds: string[];
  objective: string;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
}

interface CoordinationLedgerFile {
  version: 1;
  entries: CoordinationLedgerEntry[];
}

export interface CoordinationDecision {
  action: 'accept' | 'skip';
  reason?: string;
  context: CoordinationPromptContext;
  entry: CoordinationLedgerEntry;
}

export interface CoordinationInput {
  larkAppId: string;
  assigneeName?: string;
  chatId: string;
  anchor: string;
  messageId: string;
  content: string;
  mentions?: LarkMention[];
  sourceType: CoordinationSourceType;
  sourceOpenId?: string;
  sourceBotName?: string;
  now?: number;
  dataDir?: string;
}

const LEDGER_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_LEDGER_ENTRIES = 2_000;

function ledgerPath(dataDir = config.session.dataDir): string {
  return join(dataDir, 'coordination-ledger.json');
}

function readLedger(dataDir?: string): CoordinationLedgerFile {
  const fp = ledgerPath(dataDir);
  if (!existsSync(fp)) return { version: 1, entries: [] };
  try {
    const parsed = JSON.parse(readFileSync(fp, 'utf-8')) as Partial<CoordinationLedgerFile>;
    return {
      version: 1,
      entries: Array.isArray(parsed.entries) ? parsed.entries as CoordinationLedgerEntry[] : [],
    };
  } catch (err) {
    logger.warn(`[coordination] failed to read ledger ${fp}: ${err}`);
    return { version: 1, entries: [] };
  }
}

function writeLedger(file: CoordinationLedgerFile, dataDir?: string): void {
  const fp = ledgerPath(dataDir);
  mkdirSync(dirname(fp), { recursive: true });
  atomicWriteFileSync(fp, JSON.stringify(file, null, 2), { mode: 0o600 });
}

function hashText(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}

function stripMentionNames(content: string, mentions?: LarkMention[]): string {
  let out = content;
  for (const m of mentions ?? []) {
    if (!m.name) continue;
    out = out.replace(new RegExp(`@${escapeRegExp(m.name)}`, 'g'), ' ');
  }
  return out.replace(/@\S+/g, ' ');
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeObjective(content: string, mentions?: LarkMention[]): string {
  return stripMentionNames(content, mentions)
    .replace(/\[[^\]]*?@mention[^\]]*?\]/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function isIntroLike(normalized: string, hasMention: boolean): boolean {
  if (!normalized) return false;
  if (/(自我介绍|介绍一下|介绍下|介绍团队|团队成员|成员介绍|介绍.*(团队|成员|自己|职责)|introduce|introduction|team member|who are you)/i.test(normalized)) {
    return true;
  }
  if (!hasMention) return false;
  return /(继续介绍|你也介绍|也介绍一下|轮到你.*介绍|请.*介绍|please introduce|your turn.*introduc)/i.test(normalized);
}

function taskKeyFor(content: string, mentions?: LarkMention[]): { taskKey: string; inputHash: string; normalized: string } {
  const normalized = normalizeObjective(content, mentions);
  const inputHash = hashText(normalized);
  const hasMention = (mentions?.length ?? 0) > 0;
  if (isIntroLike(normalized, hasMention)) {
    return { taskKey: 'intro', inputHash, normalized };
  }
  return { taskKey: `task:${inputHash}`, inputHash, normalized };
}

function pruneEntries(entries: CoordinationLedgerEntry[], now: number): CoordinationLedgerEntry[] {
  return entries
    .filter(e => !e.expiresAt || e.expiresAt > now)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, MAX_LEDGER_ENTRIES);
}

function toPromptContext(
  entry: CoordinationLedgerEntry,
  status: CoordinationLedgerStatus,
  current?: {
    sourceType?: CoordinationSourceType;
    sourceBotName?: string;
    objective?: string;
  },
): CoordinationPromptContext {
  return {
    coordinationId: entry.coordinationId,
    taskKey: entry.taskKey,
    ledgerStatus: status,
    sourceType: current?.sourceType ?? entry.sourceType,
    sourceBotName: current && 'sourceBotName' in current ? current.sourceBotName : entry.sourceBotName,
    assigneeLarkAppId: entry.assigneeLarkAppId,
    assigneeName: entry.assigneeName,
    objective: current?.objective ?? entry.objective,
    sourceMessageIds: entry.sourceMessageIds,
    idempotencyKey: entry.idempotencyKey,
  };
}

function evaluateCoordinationLocked(input: CoordinationInput): CoordinationDecision | undefined {
  if (!input.chatId || !input.anchor || !input.messageId || !input.larkAppId) return undefined;
  const now = input.now ?? Date.now();
  const coordinationId = `${input.chatId}:${input.anchor}`;
  const { taskKey, inputHash, normalized } = taskKeyFor(input.content, input.mentions);
  if (!normalized && taskKey !== 'intro') return undefined;

  const idempotencyKey = `${coordinationId}:${input.larkAppId}:${taskKey}`;
  const file = readLedger(input.dataDir);
  const entries = pruneEntries(file.entries, now);
  const existing = entries.find(e =>
    e.coordinationId === coordinationId &&
    e.assigneeLarkAppId === input.larkAppId &&
    e.taskKey === taskKey);

  if (existing) {
    if (!existing.sourceMessageIds.includes(input.messageId)) {
      existing.sourceMessageIds.push(input.messageId);
    }
    existing.updatedAt = now;
    writeLedger({ version: 1, entries }, input.dataDir);
    const status: CoordinationLedgerStatus = input.sourceType === 'bot' ? 'duplicate' : 'followup';
    return {
      action: input.sourceType === 'bot' ? 'skip' : 'accept',
      reason: input.sourceType === 'bot' ? 'duplicate-bot-mention' : 'human-followup',
      context: toPromptContext(existing, status, {
        sourceType: input.sourceType,
        sourceBotName: input.sourceBotName,
        objective: normalized.slice(0, 500) || existing.objective,
      }),
      entry: existing,
    };
  }

  const entry: CoordinationLedgerEntry = {
    id: randomUUID(),
    coordinationId,
    taskKey,
    inputHash,
    idempotencyKey,
    assigneeLarkAppId: input.larkAppId,
    assigneeName: input.assigneeName,
    sourceType: input.sourceType,
    sourceBotName: input.sourceBotName,
    sourceOpenId: input.sourceOpenId,
    sourceMessageIds: [input.messageId],
    objective: normalized.slice(0, 500),
    createdAt: now,
    updatedAt: now,
    expiresAt: now + LEDGER_TTL_MS,
  };
  entries.unshift(entry);
  writeLedger({ version: 1, entries }, input.dataDir);
  return {
    action: 'accept',
    context: toPromptContext(entry, 'new'),
    entry,
  };
}

export async function evaluateCoordination(input: CoordinationInput): Promise<CoordinationDecision | undefined> {
  const fp = ledgerPath(input.dataDir);
  mkdirSync(dirname(fp), { recursive: true });
  return withFileLock(fp, async () => evaluateCoordinationLocked(input));
}
