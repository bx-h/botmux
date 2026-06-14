import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { evaluateCoordination } from '../src/services/coordination-ledger.js';

function tempDataDir(): string {
  return mkdtempSync(join(tmpdir(), 'botmux-coordination-'));
}

describe('coordination ledger', () => {
  it('lets each mentioned bot accept one intro task, then skips bot duplicate handoffs', async () => {
    const dataDir = tempDataDir();
    try {
      const first = await evaluateCoordination({
        dataDir,
        larkAppId: 'app_trae',
        assigneeName: 'Trae',
        chatId: 'oc_team',
        anchor: 'om_root',
        messageId: 'om_elon_1',
        sourceType: 'bot',
        sourceBotName: 'Elon',
        content: '@Trae @Jennie 介绍一下团队成员',
        mentions: [
          { key: '@_trae', name: 'Trae', openId: 'ou_trae' },
          { key: '@_jennie', name: 'Jennie', openId: 'ou_jennie' },
        ],
      });
      expect(first?.action).toBe('accept');
      expect(first?.context.taskKey).toBe('intro');
      expect(first?.context.ledgerStatus).toBe('new');

      const peer = await evaluateCoordination({
        dataDir,
        larkAppId: 'app_jennie',
        assigneeName: 'Jennie',
        chatId: 'oc_team',
        anchor: 'om_root',
        messageId: 'om_elon_1',
        sourceType: 'bot',
        sourceBotName: 'Elon',
        content: '@Trae @Jennie 介绍一下团队成员',
        mentions: [
          { key: '@_trae', name: 'Trae', openId: 'ou_trae' },
          { key: '@_jennie', name: 'Jennie', openId: 'ou_jennie' },
        ],
      });
      expect(peer?.action).toBe('accept');

      const duplicate = await evaluateCoordination({
        dataDir,
        larkAppId: 'app_trae',
        assigneeName: 'Trae',
        chatId: 'oc_team',
        anchor: 'om_root',
        messageId: 'om_jennie_2',
        sourceType: 'bot',
        sourceBotName: 'Jennie',
        content: '我是测试 Jennie，@Trae 你也继续介绍一下',
        mentions: [{ key: '@_trae', name: 'Trae', openId: 'ou_trae' }],
      });
      expect(duplicate?.action).toBe('skip');
      expect(duplicate?.reason).toBe('duplicate-bot-mention');
      expect(duplicate?.context.ledgerStatus).toBe('duplicate');
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('does not block a bot handoff when the new message has a different task fingerprint', async () => {
    const dataDir = tempDataDir();
    try {
      expect((await evaluateCoordination({
        dataDir,
        larkAppId: 'app_jennie',
        chatId: 'oc_team',
        anchor: 'om_root',
        messageId: 'om_1',
        sourceType: 'bot',
        sourceBotName: 'Trae',
        content: '@Jennie 请做测试计划',
        mentions: [{ key: '@_jennie', name: 'Jennie', openId: 'ou_jennie' }],
      }))?.action).toBe('accept');

      expect((await evaluateCoordination({
        dataDir,
        larkAppId: 'app_jennie',
        chatId: 'oc_team',
        anchor: 'om_root',
        messageId: 'om_2',
        sourceType: 'bot',
        sourceBotName: 'Trae',
        content: '@Jennie 请补充边界用例',
        mentions: [{ key: '@_jennie', name: 'Jennie', openId: 'ou_jennie' }],
      }))?.action).toBe('accept');
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('does not classify ordinary implementation handoffs as intro duplicates', async () => {
    const dataDir = tempDataDir();
    try {
      expect((await evaluateCoordination({
        dataDir,
        larkAppId: 'app_trae',
        assigneeName: 'Trae',
        chatId: 'oc_team',
        anchor: 'om_root',
        messageId: 'om_elon_1',
        sourceType: 'bot',
        sourceBotName: 'Elon',
        content: '@Trae 介绍一下团队成员',
        mentions: [{ key: '@_trae', name: 'Trae', openId: 'ou_trae' }],
      }))?.context.taskKey).toBe('intro');

      const handoff = await evaluateCoordination({
        dataDir,
        larkAppId: 'app_trae',
        assigneeName: 'Trae',
        chatId: 'oc_team',
        anchor: 'om_root',
        messageId: 'om_jennie_2',
        sourceType: 'bot',
        sourceBotName: 'Jennie',
        content: '我负责验收范围，@Trae 接下来请实现接口修复',
        mentions: [{ key: '@_trae', name: 'Trae', openId: 'ou_trae' }],
      });
      expect(handoff?.action).toBe('accept');
      expect(handoff?.context.taskKey).toMatch(/^task:/);
      expect(handoff?.context.ledgerStatus).toBe('new');
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('keeps human follow-ups visible instead of skipping them', async () => {
    const dataDir = tempDataDir();
    try {
      expect((await evaluateCoordination({
        dataDir,
        larkAppId: 'app_jennie',
        chatId: 'oc_team',
        anchor: 'om_root',
        messageId: 'om_1',
        sourceType: 'human',
        content: '@Jennie 介绍一下你自己',
        mentions: [{ key: '@_jennie', name: 'Jennie', openId: 'ou_jennie' }],
      }))?.action).toBe('accept');

      const followup = await evaluateCoordination({
        dataDir,
        larkAppId: 'app_jennie',
        chatId: 'oc_team',
        anchor: 'om_root',
        messageId: 'om_2',
        sourceType: 'human',
        content: '@Jennie 再介绍一下你自己',
        mentions: [{ key: '@_jennie', name: 'Jennie', openId: 'ou_jennie' }],
      });
      expect(followup?.action).toBe('accept');
      expect(followup?.context.ledgerStatus).toBe('followup');
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('labels a human follow-up with the current human source even after a bot kickoff', async () => {
    const dataDir = tempDataDir();
    try {
      expect((await evaluateCoordination({
        dataDir,
        larkAppId: 'app_jennie',
        chatId: 'oc_team',
        anchor: 'om_root',
        messageId: 'om_elon_1',
        sourceType: 'bot',
        sourceBotName: 'Elon',
        content: '@Jennie 介绍一下团队成员',
        mentions: [{ key: '@_jennie', name: 'Jennie', openId: 'ou_jennie' }],
      }))?.action).toBe('accept');

      const followup = await evaluateCoordination({
        dataDir,
        larkAppId: 'app_jennie',
        chatId: 'oc_team',
        anchor: 'om_root',
        messageId: 'om_human_2',
        sourceType: 'human',
        content: '@Jennie 再介绍一下你自己',
        mentions: [{ key: '@_jennie', name: 'Jennie', openId: 'ou_jennie' }],
      });
      expect(followup?.action).toBe('accept');
      expect(followup?.context.ledgerStatus).toBe('followup');
      expect(followup?.context.sourceType).toBe('human');
      expect(followup?.context.sourceBotName).toBeUndefined();
      expect(followup?.context.objective).toBe('再介绍一下你自己');
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('serializes concurrent writes from different assignees without losing either entry', async () => {
    const dataDir = tempDataDir();
    try {
      const shared = {
        dataDir,
        chatId: 'oc_team',
        anchor: 'om_root',
        messageId: 'om_elon_1',
        sourceType: 'bot' as const,
        sourceBotName: 'Elon',
        content: '@Trae @Jennie 介绍一下团队成员',
        mentions: [
          { key: '@_trae', name: 'Trae', openId: 'ou_trae' },
          { key: '@_jennie', name: 'Jennie', openId: 'ou_jennie' },
        ],
      };
      const [trae, jennie] = await Promise.all([
        evaluateCoordination({ ...shared, larkAppId: 'app_trae', assigneeName: 'Trae' }),
        evaluateCoordination({ ...shared, larkAppId: 'app_jennie', assigneeName: 'Jennie' }),
      ]);
      expect(trae?.action).toBe('accept');
      expect(jennie?.action).toBe('accept');

      const duplicateTrae = await evaluateCoordination({
        dataDir,
        larkAppId: 'app_trae',
        assigneeName: 'Trae',
        chatId: 'oc_team',
        anchor: 'om_root',
        messageId: 'om_jennie_2',
        sourceType: 'bot',
        sourceBotName: 'Jennie',
        content: '@Trae 你也继续介绍一下',
        mentions: [{ key: '@_trae', name: 'Trae', openId: 'ou_trae' }],
      });
      const duplicateJennie = await evaluateCoordination({
        dataDir,
        larkAppId: 'app_jennie',
        assigneeName: 'Jennie',
        chatId: 'oc_team',
        anchor: 'om_root',
        messageId: 'om_trae_2',
        sourceType: 'bot',
        sourceBotName: 'Trae',
        content: '@Jennie 你也继续介绍一下',
        mentions: [{ key: '@_jennie', name: 'Jennie', openId: 'ou_jennie' }],
      });
      expect(duplicateTrae?.action).toBe('skip');
      expect(duplicateJennie?.action).toBe('skip');
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
