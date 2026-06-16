/**
 * Unit tests for the shared fold-back turn anchoring helpers:
 * fallbackTurnId + its composition with resolveSessionReplyTarget.
 *
 * Reproduces the dispatch-into-shared-bot leak: a shared (chat-scope) session
 * triggered from inside a Lark thread anchors its USER-FACING replies into the
 * thread (turnId gate matches), but daemon-side messages that carried no
 * turnId — the worker's first streaming card, the /repo "已选择" confirmation —
 * fell through to a plain top-level sendMessage. fallbackTurnId closes that
 * gap for callers that have no turn context of their own, without weakening
 * the stale-turn gate for callers that DO pass an explicit turnId.
 *
 * Run:  pnpm vitest run test/reply-target-fallback.test.ts
 */
import { describe, it, expect } from 'vitest';
import { beginReplyTargetTurn, fallbackTurnId, resolveSessionReplyTarget } from '../src/core/reply-target.js';
import { sessionAnchorId, type DaemonSession } from '../src/core/types.js';
import { effectiveSessionScope } from '../src/types.js';

const NOW = new Date().toISOString();

function makeDs(overrides: Partial<DaemonSession> = {}): Pick<
  DaemonSession,
  'scope' | 'chatId' | 'session' | 'currentReplyTarget' | 'replyTurnTargets'
> & Partial<DaemonSession> {
  return {
    scope: 'chat',
    chatId: 'oc_chat',
    session: {
      sessionId: 'sess-1',
      chatId: 'oc_chat',
      rootMessageId: 'oc_chat',
      title: 't',
      status: 'active',
      createdAt: NOW,
    } as DaemonSession['session'],
    currentReplyTarget: undefined,
    ...overrides,
  };
}

describe('fallbackTurnId', () => {
  it('an explicit turnId always wins over the session anchor', () => {
    const ds = makeDs({
      currentReplyTarget: { rootMessageId: 'om_topic', turnId: 'turn-1', updatedAt: NOW },
    });
    expect(fallbackTurnId(ds as DaemonSession, 'turn-2')).toBe('turn-2');
  });

  it('no turn context → falls back to ds.currentReplyTarget.turnId', () => {
    const ds = makeDs({
      currentReplyTarget: { rootMessageId: 'om_topic', turnId: 'turn-1', updatedAt: NOW },
    });
    expect(fallbackTurnId(ds as DaemonSession, undefined)).toBe('turn-1');
  });

  it('falls back to the persisted session.currentReplyTarget when the in-memory one is absent (post-restart restore)', () => {
    const ds = makeDs();
    ds.session.currentReplyTarget = { rootMessageId: 'om_topic', turnId: 'turn-9', updatedAt: NOW };
    expect(fallbackTurnId(ds as DaemonSession, undefined)).toBe('turn-9');
  });

  it('no anchor anywhere → undefined (plain chat reply, unchanged behavior)', () => {
    expect(fallbackTurnId(makeDs() as DaemonSession, undefined)).toBeUndefined();
  });
});

describe('fallbackTurnId × resolveSessionReplyTarget (the leak fix)', () => {
  it('daemon-side message with NO turn context anchors into the shared fold-back topic instead of leaking top-level', () => {
    const ds = makeDs({
      currentReplyTarget: { rootMessageId: 'om_topic', turnId: 'turn-1', updatedAt: NOW },
    });
    // Pre-fix: resolveSessionReplyTarget(ds, undefined) → plain → top-level leak.
    const target = resolveSessionReplyTarget(ds, fallbackTurnId(ds as DaemonSession, undefined));
    expect(target).toEqual({ mode: 'thread', rootMessageId: 'om_topic' });
  });

  it('an explicit STALE turnId is still gated to plain — fallback must not weaken the cross-turn hijack guard', () => {
    const ds = makeDs({
      currentReplyTarget: { rootMessageId: 'om_topic', turnId: 'turn-1', updatedAt: NOW },
    });
    const target = resolveSessionReplyTarget(ds, fallbackTurnId(ds as DaemonSession, 'turn-2'));
    expect(target).toEqual({ mode: 'plain', chatId: 'oc_chat' });
  });

  it('an explicit old turnId with a recorded topic target routes back to its original topic', () => {
    const ds = makeDs({
      currentReplyTarget: { rootMessageId: 'om_topic_new', turnId: 'turn-new', updatedAt: NOW },
      replyTurnTargets: {
        'turn-old': { rootMessageId: 'om_topic_old', updatedAt: NOW },
      },
    });
    const target = resolveSessionReplyTarget(ds, fallbackTurnId(ds as DaemonSession, 'turn-old'));
    expect(target).toEqual({ mode: 'thread', rootMessageId: 'om_topic_old' });
  });

  it('uses persisted per-turn targets after restore', () => {
    const ds = makeDs({
      currentReplyTarget: { rootMessageId: 'om_topic_new', turnId: 'turn-new', updatedAt: NOW },
    });
    ds.session.replyTurnTargets = {
      'turn-old': { rootMessageId: 'om_topic_old', updatedAt: NOW },
    };
    const target = resolveSessionReplyTarget(ds, fallbackTurnId(ds as DaemonSession, 'turn-old'));
    expect(target).toEqual({ mode: 'thread', rootMessageId: 'om_topic_old' });
  });

  it('thread-scope sessions are unaffected: always reply into their own thread', () => {
    const ds = makeDs({ scope: 'thread' });
    ds.session.rootMessageId = 'om_root';
    const target = resolveSessionReplyTarget(ds, fallbackTurnId(ds as DaemonSession, undefined));
    expect(target).toEqual({ mode: 'thread', rootMessageId: 'om_root' });
  });

  it('plain chat session without any fold-back anchor keeps replying flat to the chat', () => {
    const ds = makeDs();
    const target = resolveSessionReplyTarget(ds, fallbackTurnId(ds as DaemonSession, undefined));
    expect(target).toEqual({ mode: 'plain', chatId: 'oc_chat' });
  });
});

describe('beginReplyTargetTurn', () => {
  it('records the topic target for the inbound turn in memory and persisted session state', () => {
    const ds = makeDs() as DaemonSession;

    beginReplyTargetTurn(ds, 'om_topic', 'turn-1', NOW);

    expect(ds.replyTurnTargets?.['turn-1']).toEqual({ rootMessageId: 'om_topic', updatedAt: NOW });
    expect(ds.session.replyTurnTargets?.['turn-1']).toEqual({ rootMessageId: 'om_topic', updatedAt: NOW });
  });

  it('records topic aliases after legacy oc-root sessions are restored as chat-scope', () => {
    const ds = makeDs({
      scope: 'chat',
      session: {
        sessionId: 'sess-legacy',
        chatId: 'oc_chat',
        rootMessageId: 'oc_chat',
        title: 'legacy',
        status: 'active',
        createdAt: NOW,
      } as DaemonSession['session'],
    }) as DaemonSession;

    beginReplyTargetTurn(ds, 'om_topic', 'turn-legacy', NOW);

    expect(ds.currentReplyTarget).toEqual({ rootMessageId: 'om_topic', turnId: 'turn-legacy', updatedAt: NOW });
    expect(resolveSessionReplyTarget(ds, 'turn-legacy')).toEqual({ mode: 'thread', rootMessageId: 'om_topic' });
  });
});

describe('legacy chat-scope inference', () => {
  it('treats missing-scope oc-root sessions as chat-scope', () => {
    expect(effectiveSessionScope({
      sessionId: 's',
      chatId: 'oc_chat',
      rootMessageId: 'oc_chat',
      title: 'legacy',
      status: 'active',
      createdAt: NOW,
    })).toBe('chat');
  });

  it('uses chatId as the active-session anchor after legacy oc-root sessions are restored', () => {
    const ds = makeDs({
      scope: 'chat',
      session: {
        sessionId: 'sess-legacy',
        chatId: 'oc_chat',
        rootMessageId: 'oc_chat',
        title: 'legacy',
        status: 'active',
        createdAt: NOW,
      } as DaemonSession['session'],
    }) as DaemonSession;

    expect(sessionAnchorId(ds)).toBe('oc_chat');
  });
});
