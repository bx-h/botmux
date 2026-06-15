# 2026-06-15 Fork 相对 upstream/master 的 PR 拆分说明

状态：draft / PR planning

## 基准

- 真实 upstream：`deepcoldy/botmux`
- 当前核对 upstream：`upstream/master` = `b39cec51`
- 本地 fork：`bx-h/botmux`
- 本地 HEAD / origin/master：以当前 `master` 最新提交为准（本文档自身可能继续小幅修订）
- upstream merge commit：`b0edfca9`
- 本地分叉点：`4260691f`（v2.75.0）

当前 fork 已合入 `upstream/master`，消除了 upstream 新提交缺失造成的假 diff。后续给 upstream 提 PR 时，不应直接提交当前 merge commit；应从 `upstream/master` 新建分支，按下方拆分顺序 cherry-pick / 重做最小改动。

## 功能矩阵

| 项目 | upstream/master 已有 | fork 已落地 | fork 未落地 / 路线 | PR 处理 |
|---|---:|---:|---:|---|
| `/role`、默认角色、dashboard role、capability label | 是 | 不应重复 | 无 | 排除 |
| `botmux dispatch/report` 多话题派活和回报 | 是 | 不应替代 | 无 | 排除 |
| `available_bots` 按 `larkAppId` 排除自身 | 是 | 本地可保留回归 | 无 | 不作为卖点 |
| `SOUL.md` / `soulPath` / `<bot_persona>` | upstream 无，但已有 role 等价能力 | 已清理 | 无 | 排除 |
| 自然语言 bot-to-bot `@` 最小幂等账本 | 否 | 是 | 需补状态闭环和 fan-in | Draft/RFC PR |
| `<coordination_context>` prompt 注入 | 否 | 是 | 需收敛字段语义 | 可随 ledger PR |
| follow-up / refork 注入 `available_bots` | 部分 | 是 | 补失败降级测试 | 小 PR |
| 显式 bot mention 时抑制隐式 human footer | 否 | 是 | 补更多路由回归 | 小 PR |
| `send/history` session-id JSON 归一化和 help | 否 | 是 | 补 focused test | 小 PR |
| 会话内命中当前 `botmux` 构建 | 部分 | 是 | 需抽象成通用运行时 hardening | 可选 ops PR，不进协作 PR |
| 5-15 秒 fan-in buffer | 否 | 否 | 待设计 | 后续 PR |
| `queued/running/completed/failed/superseded` 状态闭环 | 否 | 否 | 待设计 | 后续 PR |
| completion report / non-actionable 分类 | 否 | 否 | 待设计 | 后续 PR |
| handoff CLI 结构化参数 | 否 | 否 | 待设计 | 后续 PR |

## 明确不纳入 upstream PR 的内容

- fork-only SOUL 设计和相关清理差异。
- 带 SOUL 名称的历史文档：`docs/multi-bot-coordination-and-soul.md`。
- upstream 已有能力的重复说明：`/role`、team/default role、capability、dispatch/report。
- merge 前本地落后 upstream 造成的“删除”假象：HD2D Office、Windows stdin、pm2、maintenance、release workflow、package / `.gitignore` 差异。
- 机器本地临时 patch、全局 npm 替换、构建产物路径等环境操作。

## PR 候选 1：自然语言 bot-to-bot `@` 去重 MVP

### 问题

`botmux dispatch/report` 已覆盖结构化派活和子话题回报；但普通自然语言 bot-to-bot `@` 仍可能在同一协作实例中反复唤起同一目标 bot，造成重复执行、重复交棒或循环点名。

### 已落地事实

- `src/services/coordination-ledger.ts`：新增最小 ledger。
- 生成 `taskKey` 和 `inputRevisionHash`，区分同一任务与新输入版本。
- 归档 `sourceMessageIds` / `sourceMessages`，保留可诊断来源。
- 对 bot 发送的精确重复 mention 返回 `skip`，避免再次启动 worker。
- 对 human 重复或补充输入保持可见，不用 bot duplicate 策略吞掉人类 follow-up。
- `src/core/session-manager.ts`：注入 `<coordination_context>`，暴露 task、revision、source、routing disposition。

### 当前未落地

- 没有 5-15 秒 fan-in buffer。
- 没有完整 `queued/running/completed/failed/superseded` 状态机。
- 没有 completion report、duplicate nudge、non-actionable 的完整分类器。
- 没有低频 ACK / merge 反馈。
- 没有 `botmux send --handoff-*` 结构化参数。

### 边界

- 不替代 `/role`：role 解决 persona / responsibility，ledger 解决重复唤起和幂等。
- 不替代 `dispatch/report`：dispatch 是结构化子话题派活；ledger 只补自然语言 `@` 的重复治理。
- 能稳定使用 `botmux dispatch --into` 时，应优先走 upstream 原生路径。

### 风险

- 自然语言 fallback `taskKey` 可能误合并或漏合并。
- 当前只有文件锁包住 ledger 写入，缺少完整 worker reservation / running 状态闭环，并发场景仍需加固。
- ledger 文件损坏、TTL 清理和跨进程诊断需要更明确的恢复策略。
- prompt 注入只能辅助模型理解，不应作为唯一幂等保障。

### 相关文件

- `src/services/coordination-ledger.ts`
- `src/daemon.ts`
- `src/core/session-manager.ts`
- `src/core/command-handler.ts`
- `src/core/trigger-session.ts`
- `src/im/lark/card-handler.ts`
- `test/coordination-ledger.test.ts`
- `test/prompt-builder.test.ts`

### PR 口径

建议先开 draft / RFC PR，标题聚焦：

`Add MVP ledger for duplicate bot-to-bot mentions`

验收重点：

- 同一 bot 精确重复 `@` 同一目标，只启动一次。
- 同一任务新增约束时不被误判为精确重复。
- 人类重复或补充消息仍进入可见处理路径。
- prompt 中有可诊断的 coordination context。

## PR 候选 2：follow-up / refork prompt 注入 `available_bots`

### 问题

新会话 prompt 已能暴露 `<available_bots>`；活跃会话的 follow-up / refork 轮次也需要队友名单，否则模型后续交棒时会丢失可协作 bot。

### 已落地事实

- follow-up / refork prompt 构建路径传入 `availableBots`。
- repo-selection pending session 保留 coordination context 和 available bots。

### 相关文件

- `src/core/session-manager.ts`
- `src/core/trigger-session.ts`
- `src/daemon.ts`
- `test/prompt-builder.test.ts`

### PR 口径

标题可为：

`Include available bots in follow-up and refork prompts`

验收重点：

- 新话题、follow-up、refork 都能看到一致的 `<available_bots>`。
- 获取 bot 列表失败时降级为空列表，不阻塞消息处理。

## PR 候选 3：显式 bot mention 时抑制隐式 human footer

### 问题

bot 明确 `@` 另一个 bot 做 handoff 时，如果系统继续自动追加“回复给人类”的 footer，模型可能把同一消息理解成同时交给 bot 和人类。

### 已落地事实

- 消息中已有显式 bot mention 时，不再追加隐式 human footer。

### 相关文件

- `src/utils/bot-routing.ts`
- `test/bot-routing.test.ts`

### PR 口径

标题可为：

`Avoid implicit human footer when explicitly handing off to a bot`

验收重点：

- bot-to-bot handoff 不额外唤醒人。
- 普通人类回复路径仍保留必要 footer。

## PR 候选 4：`send/history` CLI 体验修复

### 问题

会话内调用 `botmux send/history` 时，session id 解析和 help 输出不够稳，影响 bot 查看上下文、发送消息、调试协作。

### 已落地事实

- session id 支持从 JSON marker 中解析。
- `send/history --help` 输出更明确。

### 相关文件

- `src/cli.ts`

### PR 口径

标题可为：

`Improve send/history session targeting ergonomics`

该 PR 应只包含 CLI 体验修复，不混入 coordination ledger。

## 可选 ops hardening：会话内命中当前 `botmux` 构建

### 问题

多版本 / fork 部署时，worker 会话里执行 `botmux` 可能命中全局安装版本，而不是当前 daemon 所在构建。

### 已落地事实

- wrapper 使用 `process.execPath`。
- worker 注入 `BOTMUX_BIN_DIR`。
- tmux / sandbox backend 将 `BOTMUX_BIN_DIR` 前置到 `PATH`。

### 相关文件

- `scripts/claim-botmux-bin.mjs`
- `scripts/sandbox-cli-functional-probe.mjs`
- `src/adapters/backend/tmux-backend.ts`
- `src/adapters/backend/sandbox.ts`
- `src/daemon.ts`
- `src/worker.ts`
- `test/tmux-backend-env.test.ts`

### PR 口径

这不是多 bot 协作产品功能。只有在 rebase 后确认 upstream 仍缺通用运行时保障时，才单独开 ops hardening PR：

`Prefer the running botmux build inside worker sessions`

## 推荐拆分顺序

1. 已完成：merge `upstream/master`，消除 upstream 新提交缺失造成的假 diff。
2. 小 PR：`send/history` session targeting 和 help。
3. 小 PR：显式 bot mention 抑制隐式 human footer。
4. 小 PR：follow-up / refork 注入 `available_bots`。
5. Draft/RFC PR：coordination ledger 数据模型、单测、prompt context。
6. 后续 PR：fan-in buffer、状态闭环、handoff CLI 参数。
7. 可选 ops PR：会话内命中当前 `botmux` 构建。

## 回归命令

清理 SOUL 后已执行过：

```bash
COREPACK_DEFAULT_TO_LATEST=0 corepack pnpm vitest run test/bot-registry.test.ts test/coordination-ledger.test.ts test/prompt-builder.test.ts test/bot-routing.test.ts
COREPACK_DEFAULT_TO_LATEST=0 corepack pnpm exec tsc --noEmit
git diff --check
```

rebase upstream 后至少补跑：

```bash
COREPACK_DEFAULT_TO_LATEST=0 corepack pnpm vitest run test/coordination-ledger.test.ts test/prompt-builder.test.ts test/bot-routing.test.ts test/tmux-backend-env.test.ts
COREPACK_DEFAULT_TO_LATEST=0 corepack pnpm exec tsc --noEmit
git diff --check
```
