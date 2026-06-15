import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { config } from '../config.js';
import { atomicWriteFileSync } from '../utils/atomic-write.js';
import { withFileLock } from '../utils/file-lock.js';
import { logger } from '../utils/logger.js';
import type { LarkAttachment, LarkMention } from '../types.js';

export type CoordinationRoutingDisposition =
  | 'new_reservation'
  | 'existing_new_revision'
  | 'exact_duplicate';

export type CoordinationLedgerStatus = 'open' | 'skipped';
export type CoordinationPromptStatus = 'new' | 'merged' | 'duplicate';
export type CoordinationSourceType = 'human' | 'bot';
export type HandoffContractStatus = 'present' | 'missing' | 'not_required';

export interface CoordinationSourceMessage {
  messageId: string;
  contentPreview: string;
  inputRevisionHash: string;
  sourceType: CoordinationSourceType;
  sourceBotName?: string;
  createdAt: number;
}

export interface CoordinationPromptContext {
  coordinationId: string;
  taskId: string;
  parentTaskId?: string;
  taskKey: string;
  inputRevisionHash: string;
  inputRevisionHashes: string[];
  routingDisposition: CoordinationRoutingDisposition;
  ledgerStatus: CoordinationLedgerStatus;
  promptStatus: CoordinationPromptStatus;
  sourceType: CoordinationSourceType;
  sourceBotName?: string;
  assigneeLarkAppId: string;
  assigneeName?: string;
  objective: string;
  expectedOutput?: string;
  completionStandard?: string;
  constraints?: string[];
  handoffSummary?: string;
  handoffContract: HandoffContractStatus;
  sourceMessageIds: string[];
  sourceMessages: CoordinationSourceMessage[];
  idempotencyKey: string;
}

export interface CoordinationLedgerEvent {
  action: 'created' | 'merged' | 'duplicate' | 'skipped';
  messageId?: string;
  sourceType?: CoordinationSourceType;
  sourceBotName?: string;
  routingDisposition?: CoordinationRoutingDisposition;
  promptStatus?: CoordinationPromptStatus;
  inputRevisionHash?: string;
  reason?: string;
  createdAt: number;
}

export interface CoordinationLedgerEntry {
  id: string;
  parentTaskId?: string;
  coordinationId: string;
  taskKey: string;
  latestInputRevisionHash: string;
  inputRevisionHashes: string[];
  idempotencyKey: string;
  assigneeLarkAppId: string;
  assigneeName?: string;
  status: CoordinationLedgerStatus;
  sourceType: CoordinationSourceType;
  sourceBotName?: string;
  sourceOpenId?: string;
  sourceMessageIds: string[];
  sourceMessages: CoordinationSourceMessage[];
  objective: string;
  expectedOutput?: string;
  completionStandard?: string;
  constraints?: string[];
  handoffSummary?: string;
  handoffContract: HandoffContractStatus;
  events: CoordinationLedgerEvent[];
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
}

interface CoordinationLedgerFile {
  version: 2;
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
  attachments?: LarkAttachment[];
  sourceType: CoordinationSourceType;
  sourceOpenId?: string;
  sourceBotName?: string;
  now?: number;
  dataDir?: string;
}

const LEDGER_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_LEDGER_ENTRIES = 2_000;
const MAX_ENTRY_EVENTS = 80;
const MAX_SOURCE_MESSAGES = 5;
const MAX_SOURCE_PREVIEW_CHARS = 300;

function ledgerPath(dataDir = config.session.dataDir): string {
  return join(dataDir, 'coordination-ledger.json');
}

function readLedger(dataDir?: string): CoordinationLedgerFile {
  const fp = ledgerPath(dataDir);
  if (!existsSync(fp)) return { version: 2, entries: [] };
  try {
    const parsed = JSON.parse(readFileSync(fp, 'utf-8')) as { entries?: unknown[] };
    const entries = Array.isArray(parsed.entries)
      ? parsed.entries.map(normalizeLedgerEntry).filter((e): e is CoordinationLedgerEntry => !!e)
      : [];
    return { version: 2, entries };
  } catch (err) {
    logger.warn(`[coordination] failed to read ledger ${fp}: ${err}`);
    return { version: 2, entries: [] };
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

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function stripMentionNames(content: string, mentions?: LarkMention[]): string {
  let out = content;
  for (const m of mentions ?? []) {
    if (!m.name) continue;
    out = out.replace(new RegExp(`@${escapeRegExp(m.name)}`, 'g'), ' ');
  }
  return out
    .replace(/\[[^\]]*?@mention[^\]]*?\]/gi, ' ')
    .replace(/@\S+/g, ' ');
}

function stripXmlTags(text: string): string {
  return text.replace(/<[^>]+>/g, ' ');
}

function normalizeText(text: string): string {
  return stripXmlTags(text)
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function previewContent(content: string): string {
  return content.replace(/\s+/g, ' ').trim().slice(0, MAX_SOURCE_PREVIEW_CHARS);
}

function extractTagValues(content: string, tagNames: string[]): string[] {
  const values: string[] = [];
  for (const tag of tagNames) {
    const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'gi');
    let match: RegExpExecArray | null;
    while ((match = re.exec(content)) !== null) {
      const value = normalizeText(match[1] ?? '');
      if (value) values.push(value);
    }
  }
  return [...new Set(values)];
}

function removeHandoffBlocks(content: string): string {
  return content.replace(/<handoff\b[^>]*>[\s\S]*?<\/handoff>/gi, ' ');
}

function splitConstraintText(text: string): string[] {
  return text
    .split(/\n|;|；|、|,/)
    .map(normalizeText)
    .filter(Boolean);
}

function extractInlineConstraints(content: string): string[] {
  const constraints: string[] = [];
  const re = /(?:^|\n)\s*(?:约束|限制|constraints?)\s*[:：]\s*([^\n]+)/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(content)) !== null) {
    constraints.push(...splitConstraintText(match[1] ?? ''));
  }
  return [...new Set(constraints)];
}

function extractReferences(content: string): string[] {
  const refs = new Set<string>();
  const re = /\b(?:om|msg|thread)_[A-Za-z0-9_-]+\b/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(content)) !== null) refs.add(match[0]);
  return [...refs].sort();
}

function attachmentRefs(attachments?: LarkAttachment[]): string[] {
  return (attachments ?? [])
    .map(a => `${a.type}:${a.name}:${a.path}`)
    .map(normalizeText)
    .filter(Boolean)
    .sort();
}

function hasStructuredReworkSignal(content: string): boolean {
  return /<\s*(?:rework|retry_or_rework|retry)\b/i.test(content) ||
    /<handoff\b[^>]*(?:kind|type)\s*=\s*["'](?:rework|retry_or_rework|retry)["']/i.test(content);
}

interface TaskDescriptor {
  taskKey: string;
  inputRevisionHash: string;
  normalizedObjective: string;
  normalizedExpectedOutput: string;
  objective: string;
  expectedOutput?: string;
  completionStandard?: string;
  constraints: string[];
  references: string[];
  attachmentRefs: string[];
  explicitReworkSignal: boolean;
  handoffSummary?: string;
  handoffContract: HandoffContractStatus;
}

function buildTaskKey(
  coordinationId: string,
  assigneeLarkAppId: string,
  normalizedObjective: string,
  normalizedExpectedOutput: string,
): string {
  return [
    `coord:${hashText(coordinationId)}`,
    `assignee:${hashText(assigneeLarkAppId)}`,
    `objective:${hashText(normalizedObjective)}`,
    `expected:${hashText(normalizedExpectedOutput)}`,
  ].join('|');
}

function describeTask(input: CoordinationInput, coordinationId: string): TaskDescriptor {
  const content = input.content ?? '';
  const summary = extractTagValues(content, ['summary'])[0];
  const objectiveTag = extractTagValues(content, ['objective', 'task_objective'])[0];
  const expectedOutput = extractTagValues(content, ['expected_output', 'expectedOutput'])[0];
  const completionStandard = extractTagValues(content, ['completion_standard', 'completionStandard'])[0];
  const tagConstraints = extractTagValues(content, ['constraints', 'constraint']).flatMap(splitConstraintText);
  const constraints = [...new Set([...tagConstraints, ...extractInlineConstraints(content)])];
  const refs = extractReferences(content);
  const attachments = attachmentRefs(input.attachments);
  const explicitReworkSignal = hasStructuredReworkSignal(content);
  const hasContract = /<handoff\b[^>]*>/i.test(content) ||
    !!(summary || objectiveTag || expectedOutput || completionStandard || tagConstraints.length > 0);
  const fallbackObjective = normalizeText(removeHandoffBlocks(stripMentionNames(content, input.mentions)));
  const objective = objectiveTag || fallbackObjective || expectedOutput || (attachments.length > 0 ? 'attachment input' : '');
  const normalizedObjective = normalizeText(objective);
  const normalizedExpectedOutput = normalizeText(expectedOutput ?? '');
  const revisionPayload = JSON.stringify({
    handoffSummary: summary ?? '',
    constraints: constraints.map(normalizeText).sort(),
    completionStandard: completionStandard ? normalizeText(completionStandard) : '',
    references: refs,
    attachments,
    explicitReworkSignal,
  });
  return {
    taskKey: buildTaskKey(coordinationId, input.larkAppId, normalizedObjective, normalizedExpectedOutput),
    inputRevisionHash: hashText(revisionPayload),
    normalizedObjective,
    normalizedExpectedOutput,
    objective: normalizedObjective.slice(0, 500),
    expectedOutput: normalizedExpectedOutput || undefined,
    completionStandard: completionStandard ? normalizeText(completionStandard).slice(0, 500) : undefined,
    constraints,
    references: refs,
    attachmentRefs: attachments,
    explicitReworkSignal,
    handoffSummary: summary,
    handoffContract: hasContract ? 'present' : 'missing',
  };
}

function normalizeLedgerEntry(raw: unknown): CoordinationLedgerEntry | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const e = raw as Partial<CoordinationLedgerEntry> & { inputHash?: string };
  if (!e.coordinationId || !e.taskKey || !e.assigneeLarkAppId) return undefined;
  const latestInputRevisionHash = typeof e.latestInputRevisionHash === 'string'
    ? e.latestInputRevisionHash
    : typeof e.inputHash === 'string'
      ? e.inputHash
      : hashText(String(e.objective ?? ''));
  const inputRevisionHashes = Array.isArray(e.inputRevisionHashes) && e.inputRevisionHashes.length > 0
    ? [...new Set(e.inputRevisionHashes.filter((v): v is string => typeof v === 'string'))]
    : [latestInputRevisionHash];
  if (!inputRevisionHashes.includes(latestInputRevisionHash)) inputRevisionHashes.push(latestInputRevisionHash);
  return {
    id: typeof e.id === 'string' ? e.id : randomUUID(),
    parentTaskId: e.parentTaskId,
    coordinationId: e.coordinationId,
    taskKey: e.taskKey,
    latestInputRevisionHash,
    inputRevisionHashes,
    idempotencyKey: typeof e.idempotencyKey === 'string' ? e.idempotencyKey : e.taskKey,
    assigneeLarkAppId: e.assigneeLarkAppId,
    assigneeName: e.assigneeName,
    status: isLedgerStatus(e.status) ? e.status : 'open',
    sourceType: e.sourceType === 'human' ? 'human' : 'bot',
    sourceBotName: e.sourceBotName,
    sourceOpenId: e.sourceOpenId,
    sourceMessageIds: Array.isArray(e.sourceMessageIds) ? e.sourceMessageIds.filter((v): v is string => typeof v === 'string') : [],
    sourceMessages: Array.isArray(e.sourceMessages) ? e.sourceMessages.filter(isSourceMessage).slice(-MAX_SOURCE_MESSAGES) : [],
    objective: typeof e.objective === 'string' ? e.objective : '',
    expectedOutput: e.expectedOutput,
    completionStandard: e.completionStandard,
    constraints: Array.isArray(e.constraints) ? e.constraints.filter((v): v is string => typeof v === 'string') : undefined,
    handoffSummary: e.handoffSummary,
    handoffContract: isHandoffStatus(e.handoffContract) ? e.handoffContract : 'missing',
    events: Array.isArray(e.events) ? e.events.filter(isLedgerEvent).slice(-MAX_ENTRY_EVENTS) : [],
    createdAt: typeof e.createdAt === 'number' ? e.createdAt : Date.now(),
    updatedAt: typeof e.updatedAt === 'number' ? e.updatedAt : Date.now(),
    expiresAt: typeof e.expiresAt === 'number' ? e.expiresAt : Date.now() + LEDGER_TTL_MS,
  };
}

function isSourceMessage(message: unknown): message is CoordinationSourceMessage {
  if (!message || typeof message !== 'object') return false;
  const m = message as Partial<CoordinationSourceMessage>;
  return typeof m.messageId === 'string' &&
    typeof m.contentPreview === 'string' &&
    typeof m.inputRevisionHash === 'string' &&
    typeof m.createdAt === 'number' &&
    (m.sourceType === 'human' || m.sourceType === 'bot');
}

function isLedgerStatus(status: unknown): status is CoordinationLedgerStatus {
  return status === 'open' || status === 'skipped';
}

function isHandoffStatus(status: unknown): status is HandoffContractStatus {
  return status === 'present' || status === 'missing' || status === 'not_required';
}

function isLedgerEvent(event: unknown): event is CoordinationLedgerEvent {
  if (!event || typeof event !== 'object') return false;
  const e = event as Partial<CoordinationLedgerEvent>;
  return typeof e.createdAt === 'number' &&
    (e.action === 'created' || e.action === 'merged' || e.action === 'duplicate' || e.action === 'skipped');
}

function pruneEntries(entries: CoordinationLedgerEntry[], now: number): CoordinationLedgerEntry[] {
  return entries
    .filter(e => !e.expiresAt || e.expiresAt > now)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, MAX_LEDGER_ENTRIES);
}

function appendEvent(
  entry: CoordinationLedgerEntry,
  event: Omit<CoordinationLedgerEvent, 'createdAt'>,
  now: number,
): void {
  entry.events.push({ ...event, createdAt: now });
  if (entry.events.length > MAX_ENTRY_EVENTS) {
    entry.events.splice(0, entry.events.length - MAX_ENTRY_EVENTS);
  }
}

function mergeDescriptor(entry: CoordinationLedgerEntry, descriptor: TaskDescriptor): void {
  if (descriptor.inputRevisionHash) {
    entry.latestInputRevisionHash = descriptor.inputRevisionHash;
    if (!entry.inputRevisionHashes.includes(descriptor.inputRevisionHash)) {
      entry.inputRevisionHashes.push(descriptor.inputRevisionHash);
    }
  }
  if (descriptor.objective) entry.objective = descriptor.objective;
  if (descriptor.expectedOutput) entry.expectedOutput = descriptor.expectedOutput;
  if (descriptor.completionStandard) entry.completionStandard = descriptor.completionStandard;
  if (descriptor.constraints.length > 0) {
    entry.constraints = [...new Set([...(entry.constraints ?? []), ...descriptor.constraints])];
  }
  if (descriptor.handoffSummary) entry.handoffSummary = descriptor.handoffSummary;
  if (descriptor.handoffContract === 'present') entry.handoffContract = 'present';
}

function makeSourceMessage(input: CoordinationInput, descriptor: TaskDescriptor, now: number): CoordinationSourceMessage {
  return {
    messageId: input.messageId,
    contentPreview: previewContent(input.content),
    inputRevisionHash: descriptor.inputRevisionHash,
    sourceType: input.sourceType,
    sourceBotName: input.sourceBotName,
    createdAt: now,
  };
}

function toPromptContext(
  entry: CoordinationLedgerEntry,
  routingDisposition: CoordinationRoutingDisposition,
  promptStatus: CoordinationPromptStatus,
  current?: {
    sourceType?: CoordinationSourceType;
    sourceBotName?: string;
    objective?: string;
    inputRevisionHash?: string;
  },
): CoordinationPromptContext {
  return {
    coordinationId: entry.coordinationId,
    taskId: entry.id,
    parentTaskId: entry.parentTaskId,
    taskKey: entry.taskKey,
    inputRevisionHash: current?.inputRevisionHash ?? entry.latestInputRevisionHash,
    inputRevisionHashes: entry.inputRevisionHashes,
    routingDisposition,
    ledgerStatus: entry.status,
    promptStatus,
    sourceType: current?.sourceType ?? entry.sourceType,
    sourceBotName: current && 'sourceBotName' in current ? current.sourceBotName : entry.sourceBotName,
    assigneeLarkAppId: entry.assigneeLarkAppId,
    assigneeName: entry.assigneeName,
    objective: current?.objective ?? entry.objective,
    expectedOutput: entry.expectedOutput,
    completionStandard: entry.completionStandard,
    constraints: entry.constraints,
    handoffSummary: entry.handoffSummary,
    handoffContract: entry.handoffContract,
    sourceMessageIds: entry.sourceMessageIds,
    sourceMessages: entry.sourceMessages,
    idempotencyKey: entry.idempotencyKey,
  };
}

function routingDispositionForExisting(
  descriptor: TaskDescriptor,
  existing: CoordinationLedgerEntry,
): CoordinationRoutingDisposition {
  return existing.inputRevisionHashes.includes(descriptor.inputRevisionHash)
    ? 'exact_duplicate'
    : 'existing_new_revision';
}

function promptStatusFor(disposition: CoordinationRoutingDisposition): CoordinationPromptStatus {
  switch (disposition) {
    case 'new_reservation':
      return 'new';
    case 'existing_new_revision':
      return 'merged';
    case 'exact_duplicate':
      return 'duplicate';
  }
}

function reasonFor(disposition: CoordinationRoutingDisposition, sourceType: CoordinationSourceType): string {
  if (sourceType === 'human') {
    return disposition === 'exact_duplicate' ? 'human-exact-duplicate-visible' : 'human-revision-visible';
  }
  switch (disposition) {
    case 'existing_new_revision':
      return 'bot-new-revision-visible';
    case 'exact_duplicate':
      return 'exact-duplicate-bot-mention';
    case 'new_reservation':
      return 'accepted-new-task';
  }
}

function appendSourceMessage(
  entry: CoordinationLedgerEntry,
  input: CoordinationInput,
  descriptor: TaskDescriptor,
  now: number,
): void {
  if (!entry.sourceMessageIds.includes(input.messageId)) entry.sourceMessageIds.push(input.messageId);
  if (!entry.sourceMessages.some(m => m.messageId === input.messageId)) {
    entry.sourceMessages.push(makeSourceMessage(input, descriptor, now));
    if (entry.sourceMessages.length > MAX_SOURCE_MESSAGES) {
      entry.sourceMessages.splice(0, entry.sourceMessages.length - MAX_SOURCE_MESSAGES);
    }
  }
}

function createEntry(args: {
  input: CoordinationInput;
  descriptor: TaskDescriptor;
  coordinationId: string;
  status: CoordinationLedgerStatus;
  now: number;
  parentTaskId?: string;
}): CoordinationLedgerEntry {
  const { input, descriptor, coordinationId, status, now, parentTaskId } = args;
  return {
    id: randomUUID(),
    parentTaskId,
    coordinationId,
    taskKey: descriptor.taskKey,
    latestInputRevisionHash: descriptor.inputRevisionHash,
    inputRevisionHashes: [descriptor.inputRevisionHash],
    idempotencyKey: parentTaskId
      ? `${descriptor.taskKey}:child:${descriptor.inputRevisionHash}`
      : descriptor.taskKey,
    assigneeLarkAppId: input.larkAppId,
    assigneeName: input.assigneeName,
    status,
    sourceType: input.sourceType,
    sourceBotName: input.sourceBotName,
    sourceOpenId: input.sourceOpenId,
    sourceMessageIds: [input.messageId],
    sourceMessages: [makeSourceMessage(input, descriptor, now)],
    objective: descriptor.objective,
    expectedOutput: descriptor.expectedOutput,
    completionStandard: descriptor.completionStandard,
    constraints: descriptor.constraints.length > 0 ? descriptor.constraints : undefined,
    handoffSummary: descriptor.handoffSummary,
    handoffContract: descriptor.handoffContract,
    events: [],
    createdAt: now,
    updatedAt: now,
    expiresAt: now + LEDGER_TTL_MS,
  };
}

function evaluateCoordinationLocked(input: CoordinationInput): CoordinationDecision | undefined {
  if (!input.chatId || !input.anchor || !input.messageId || !input.larkAppId) return undefined;
  const now = input.now ?? Date.now();
  const coordinationId = `${input.chatId}:${input.anchor}`;
  const file = readLedger(input.dataDir);
  const entries = pruneEntries(file.entries, now);
  let descriptor = describeTask(input, coordinationId);

  let existing = entries.find(e =>
    e.coordinationId === coordinationId &&
    e.assigneeLarkAppId === input.larkAppId &&
    e.taskKey === descriptor.taskKey);

  if (existing) {
    const disposition = routingDispositionForExisting(descriptor, existing);
    const promptStatus = promptStatusFor(disposition);
    const reason = reasonFor(disposition, input.sourceType);
    appendSourceMessage(existing, input, descriptor, now);
    if (disposition === 'existing_new_revision') {
      mergeDescriptor(existing, descriptor);
    }
    existing.updatedAt = now;
    appendEvent(existing, {
      action: disposition === 'exact_duplicate' ? 'duplicate' : 'merged',
      messageId: input.messageId,
      sourceType: input.sourceType,
      sourceBotName: input.sourceBotName,
      routingDisposition: disposition,
      promptStatus,
      inputRevisionHash: descriptor.inputRevisionHash,
      reason,
    }, now);
    writeLedger({ version: 2, entries }, input.dataDir);

    const shouldSkip = input.sourceType === 'bot' && (
      disposition === 'exact_duplicate'
    );
    return {
      action: shouldSkip ? 'skip' : 'accept',
      reason,
      context: toPromptContext(existing, disposition, promptStatus, {
        sourceType: input.sourceType,
        sourceBotName: input.sourceBotName,
        objective: descriptor.objective || existing.objective,
        inputRevisionHash: descriptor.inputRevisionHash,
      }),
      entry: existing,
    };
  }

  if (!descriptor.normalizedObjective && !descriptor.normalizedExpectedOutput) return undefined;
  const disposition: CoordinationRoutingDisposition = 'new_reservation';
  const promptStatus = promptStatusFor(disposition);
  const status: CoordinationLedgerStatus = 'open';
  const entry = createEntry({
    input,
    descriptor,
    coordinationId,
    status,
    now,
  });
  appendEvent(entry, {
    action: 'created',
    messageId: input.messageId,
    sourceType: input.sourceType,
    sourceBotName: input.sourceBotName,
    routingDisposition: disposition,
    promptStatus,
    inputRevisionHash: descriptor.inputRevisionHash,
    reason: reasonFor(disposition, input.sourceType),
  }, now);
  entries.unshift(entry);
  writeLedger({ version: 2, entries }, input.dataDir);
  return {
    action: 'accept',
    context: toPromptContext(entry, disposition, promptStatus),
    entry,
  };
}

export async function evaluateCoordination(input: CoordinationInput): Promise<CoordinationDecision | undefined> {
  const fp = ledgerPath(input.dataDir);
  mkdirSync(dirname(fp), { recursive: true });
  return withFileLock(fp, async () => evaluateCoordinationLocked(input));
}
