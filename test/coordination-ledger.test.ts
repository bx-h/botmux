import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { evaluateCoordination } from '../src/services/coordination-ledger.js';

function tempDataDir(): string {
  return mkdtempSync(join(tmpdir(), 'botmux-coordination-'));
}

function handoff(constraint?: string): string {
  const constraintBlock = constraint ? `\n  <constraints>${constraint}</constraints>` : '';
  return [
    '@Jennie',
    '<handoff>',
    '  <objective>review duplicate mention handling</objective>',
    '  <expected_output>risk summary</expected_output>',
    '  <completion_standard>cite ledger evidence</completion_standard>',
    constraintBlock,
    '</handoff>',
  ].join('\n');
}

function readLedger(dataDir: string): any {
  return JSON.parse(readFileSync(join(dataDir, 'coordination-ledger.json'), 'utf-8'));
}

describe('coordination ledger', () => {
  it('suppresses exact duplicate bot mentions without business-specific task keys', async () => {
    const dataDir = tempDataDir();
    try {
      const first = await evaluateCoordination({
        dataDir,
        larkAppId: 'app_jennie',
        assigneeName: 'Jennie',
        chatId: 'oc_team',
        anchor: 'om_root',
        messageId: 'om_elon_1',
        sourceType: 'bot',
        sourceBotName: 'Elon',
        content: handoff(),
        mentions: [{ key: '@_jennie', name: 'Jennie', openId: 'ou_jennie' }],
      });
      expect(first?.action).toBe('accept');
      expect(first?.context.routingDisposition).toBe('new_reservation');
      expect(first?.context.ledgerStatus).toBe('open');
      expect(first?.context.promptStatus).toBe('new');
      expect(first?.context.taskKey).not.toBe('intro');

      const duplicate = await evaluateCoordination({
        dataDir,
        larkAppId: 'app_jennie',
        assigneeName: 'Jennie',
        chatId: 'oc_team',
        anchor: 'om_root',
        messageId: 'om_elon_2',
        sourceType: 'bot',
        sourceBotName: 'Elon',
        content: handoff(),
        mentions: [{ key: '@_jennie', name: 'Jennie', openId: 'ou_jennie' }],
      });
      expect(duplicate?.action).toBe('skip');
      expect(duplicate?.reason).toBe('exact-duplicate-bot-mention');
      expect(duplicate?.context.routingDisposition).toBe('exact_duplicate');
      expect(duplicate?.context.promptStatus).toBe('duplicate');
      expect(duplicate?.entry.sourceMessageIds).toEqual(['om_elon_1', 'om_elon_2']);
      expect(duplicate?.entry.events.at(-1)?.action).toBe('duplicate');
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('records a new revision under the same task without treating it as an exact duplicate', async () => {
    const dataDir = tempDataDir();
    try {
      const first = await evaluateCoordination({
        dataDir,
        larkAppId: 'app_jennie',
        assigneeName: 'Jennie',
        chatId: 'oc_team',
        anchor: 'om_root',
        messageId: 'om_1',
        sourceType: 'bot',
        sourceBotName: 'Elon',
        content: handoff('cover quote replies'),
        mentions: [{ key: '@_jennie', name: 'Jennie', openId: 'ou_jennie' }],
      });
      const followup = await evaluateCoordination({
        dataDir,
        larkAppId: 'app_jennie',
        assigneeName: 'Jennie',
        chatId: 'oc_team',
        anchor: 'om_root',
        messageId: 'om_2',
        sourceType: 'bot',
        sourceBotName: 'Trae',
        content: handoff('cover quote replies; include attachments'),
        mentions: [{ key: '@_jennie', name: 'Jennie', openId: 'ou_jennie' }],
      });

      expect(first?.context.taskKey).toBe(followup?.context.taskKey);
      expect(first?.context.inputRevisionHash).not.toBe(followup?.context.inputRevisionHash);
      expect(followup?.action).toBe('accept');
      expect(followup?.reason).toBe('bot-new-revision-visible');
      expect(followup?.context.routingDisposition).toBe('existing_new_revision');
      expect(followup?.context.promptStatus).toBe('merged');
      expect(followup?.context.inputRevisionHashes).toHaveLength(2);
      expect(followup?.context.sourceMessages).toHaveLength(2);
      expect(followup?.context.sourceMessages[1].contentPreview).toContain('include attachments');
      expect(followup?.entry.inputRevisionHashes).toHaveLength(2);
      expect(followup?.entry.sourceMessageIds).toEqual(['om_1', 'om_2']);
      expect(followup?.entry.sourceMessages).toHaveLength(2);
      expect(followup?.entry.sourceMessages[1].contentPreview).toContain('include attachments');
      expect(followup?.entry.events.at(-1)?.action).toBe('merged');
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('delivers a new revision to an already active session when explicitly allowed', async () => {
    const dataDir = tempDataDir();
    try {
      await evaluateCoordination({
        dataDir,
        larkAppId: 'app_jennie',
        chatId: 'oc_team',
        anchor: 'om_root',
        messageId: 'om_1',
        sourceType: 'bot',
        sourceBotName: 'Elon',
        content: handoff('cover first path'),
        mentions: [{ key: '@_jennie', name: 'Jennie', openId: 'ou_jennie' }],
      });
      const followup = await evaluateCoordination({
        dataDir,
        larkAppId: 'app_jennie',
        chatId: 'oc_team',
        anchor: 'om_root',
        messageId: 'om_2',
        sourceType: 'bot',
        sourceBotName: 'Trae',
        content: handoff('cover first path; cover second path'),
        mentions: [{ key: '@_jennie', name: 'Jennie', openId: 'ou_jennie' }],
      });
      expect(followup?.action).toBe('accept');
      expect(followup?.context.routingDisposition).toBe('existing_new_revision');
      expect(followup?.context.inputRevisionHashes).toHaveLength(2);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('does not merge a different objective just because only one task exists', async () => {
    const dataDir = tempDataDir();
    try {
      const first = await evaluateCoordination({
        dataDir,
        larkAppId: 'app_jennie',
        chatId: 'oc_team',
        anchor: 'om_root',
        messageId: 'om_1',
        sourceType: 'bot',
        sourceBotName: 'Elon',
        content: handoff('cover initial scope'),
        mentions: [{ key: '@_jennie', name: 'Jennie', openId: 'ou_jennie' }],
      });
      const second = await evaluateCoordination({
        dataDir,
        larkAppId: 'app_jennie',
        chatId: 'oc_team',
        anchor: 'om_root',
        messageId: 'om_2',
        sourceType: 'bot',
        sourceBotName: 'Trae',
        content: [
          '@Jennie',
          '<handoff>',
          '  <objective>prepare release notes</objective>',
          '  <expected_output>markdown changelog</expected_output>',
          '  <constraints>include attachments</constraints>',
          '</handoff>',
        ].join('\n'),
        mentions: [{ key: '@_jennie', name: 'Jennie', openId: 'ou_jennie' }],
      });
      expect(second?.action).toBe('accept');
      expect(second?.context.routingDisposition).toBe('new_reservation');
      expect(second?.context.taskKey).not.toBe(first?.context.taskKey);
      expect(readLedger(dataDir).entries).toHaveLength(2);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('keeps human follow-ups visible even when they are exact duplicates', async () => {
    const dataDir = tempDataDir();
    try {
      await evaluateCoordination({
        dataDir,
        larkAppId: 'app_jennie',
        chatId: 'oc_team',
        anchor: 'om_root',
        messageId: 'om_1',
        sourceType: 'human',
        content: '@Jennie 请总结当前风险',
        mentions: [{ key: '@_jennie', name: 'Jennie', openId: 'ou_jennie' }],
      });
      const followup = await evaluateCoordination({
        dataDir,
        larkAppId: 'app_jennie',
        chatId: 'oc_team',
        anchor: 'om_root',
        messageId: 'om_2',
        sourceType: 'human',
        content: '@Jennie 请总结当前风险',
        mentions: [{ key: '@_jennie', name: 'Jennie', openId: 'ou_jennie' }],
      });
      expect(followup?.action).toBe('accept');
      expect(followup?.context.routingDisposition).toBe('exact_duplicate');
      expect(followup?.context.sourceType).toBe('human');
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('treats ordinary natural-language tasks as generic reservations', async () => {
    const dataDir = tempDataDir();
    try {
      const task = await evaluateCoordination({
        dataDir,
        larkAppId: 'app_trae',
        assigneeName: 'Trae',
        chatId: 'oc_team',
        anchor: 'om_root',
        messageId: 'om_1',
        sourceType: 'bot',
        sourceBotName: 'Elon',
        content: '@Trae 接下来请实现接口修复',
        mentions: [{ key: '@_trae', name: 'Trae', openId: 'ou_trae' }],
      });
      expect(task?.action).toBe('accept');
      expect(task?.context.routingDisposition).toBe('new_reservation');
      expect(task?.context.taskKey).not.toBe('intro');
      expect(readLedger(dataDir).entries[0].events[0].routingDisposition).toBe('new_reservation');
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
