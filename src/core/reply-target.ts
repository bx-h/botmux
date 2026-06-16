import { effectiveDaemonSessionScope, type DaemonSession } from './types.js';
import type { Session } from '../types.js';

export type SessionReplyTarget =
  | { mode: 'plain'; chatId: string }
  | { mode: 'thread'; rootMessageId: string };

const MAX_REPLY_TURN_TARGETS = 100;

function pruneReplyTurnTargets(
  targets: NonNullable<Session['replyTurnTargets']>,
): NonNullable<Session['replyTurnTargets']> {
  const entries = Object.entries(targets);
  if (entries.length <= MAX_REPLY_TURN_TARGETS) return targets;
  entries.sort((a, b) => a[1].updatedAt.localeCompare(b[1].updatedAt));
  return Object.fromEntries(entries.slice(-MAX_REPLY_TURN_TARGETS));
}

export function resolveSessionReplyTarget(
  ds: Pick<DaemonSession, 'scope' | 'chatId' | 'session' | 'currentReplyTarget' | 'replyTurnTargets'>,
  turnId?: string,
): SessionReplyTarget {
  const target = ds.currentReplyTarget ?? ds.session.currentReplyTarget;
  const turnTarget = turnId ? (ds.replyTurnTargets ?? ds.session.replyTurnTargets)?.[turnId] : undefined;
  if (effectiveDaemonSessionScope(ds) === 'chat') {
    if (turnTarget?.rootMessageId) return { mode: 'thread', rootMessageId: turnTarget.rootMessageId };
    if (target?.rootMessageId && !!turnId && target.turnId === turnId) {
      return { mode: 'thread', rootMessageId: target.rootMessageId };
    }
    return { mode: 'plain', chatId: ds.chatId };
  }
  return { mode: 'thread', rootMessageId: ds.session.rootMessageId };
}

export function resolveSendTarget(opts: {
  into?: string;
  topLevel: boolean;
  chatScope: boolean;
  chatId: string;
  rootMessageId: string;
  replyTargetRootId?: string;
  replyTargetTurnId?: string;
  replyTurnTargetRootId?: string;
  currentTurnId?: string;
}): SessionReplyTarget {
  if (opts.into) return { mode: 'thread', rootMessageId: opts.into };
  if (opts.topLevel) return { mode: 'plain', chatId: opts.chatId };
  if (opts.chatScope) {
    if (opts.currentTurnId && opts.replyTurnTargetRootId) {
      return { mode: 'thread', rootMessageId: opts.replyTurnTargetRootId };
    }
    return opts.replyTargetRootId && opts.replyTargetTurnId && opts.replyTargetTurnId === opts.currentTurnId
      ? { mode: 'thread', rootMessageId: opts.replyTargetRootId }
      : { mode: 'plain', chatId: opts.chatId };
  }
  return { mode: 'thread', rootMessageId: opts.rootMessageId };
}

export function beginReplyTargetTurn(
  ds: DaemonSession,
  replyRootId: string | undefined,
  turnId: string,
  nowIso = new Date().toISOString(),
): void {
  if (effectiveDaemonSessionScope(ds) !== 'chat') return;
  if (replyRootId) {
    const aliases = { ...(ds.replyThreadAliases ?? ds.session.replyThreadAliases ?? {}) };
    aliases[replyRootId] = {
      createdAt: aliases[replyRootId]?.createdAt ?? nowIso,
      lastUsedAt: nowIso,
    };
    const turnTargets = { ...(ds.replyTurnTargets ?? ds.session.replyTurnTargets ?? {}) };
    turnTargets[turnId] = { rootMessageId: replyRootId, updatedAt: nowIso };
    const prunedTurnTargets = pruneReplyTurnTargets(turnTargets);
    const target = { rootMessageId: replyRootId, turnId, updatedAt: nowIso };
    ds.replyThreadAliases = aliases;
    ds.replyTurnTargets = prunedTurnTargets;
    ds.currentReplyTarget = target;
    ds.session.replyThreadAliases = aliases;
    ds.session.replyTurnTargets = prunedTurnTargets;
    ds.session.currentReplyTarget = target;
    return;
  }
  ds.currentReplyTarget = undefined;
  ds.session.currentReplyTarget = undefined;
}

/**
 * Effective turnId for a daemon-side message. Callers that know their turn
 * (worker final_output, placeholder cards) pass it explicitly and the
 * stale-turn gate in resolveSessionReplyTarget stays authoritative. Callers
 * with NO turn context of their own (the worker's first streaming card,
 * crash notices) fall back to the session's current reply-target turn — in a
 * shared fold-back topic they then follow the conversation into the thread
 * instead of leaking to the chat top level.
 */
export function fallbackTurnId(
  ds: Pick<DaemonSession, 'session' | 'currentReplyTarget'>,
  turnId: string | undefined,
): string | undefined {
  return turnId ?? (ds.currentReplyTarget ?? ds.session.currentReplyTarget)?.turnId;
}

export function syncReplyTargetState(ds: DaemonSession, s?: Session): void {
  const source = s ?? ds.session;
  ds.replyThreadAliases = source.replyThreadAliases;
  ds.replyTurnTargets = source.replyTurnTargets;
  ds.currentReplyTarget = source.currentReplyTarget;
}
