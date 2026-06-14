# 多 bot 协作上下文与 SOUL.md 产品化方案

## 背景问题

当前多 bot 协作有三类问题需要一起收敛：

1. `available_bots` 过滤错误：同一类 CLI 的多个机器人共存时，机器人会把同类队友误判为自己，导致无法点名协作。
2. 多轮互相 `@` 容易产生重复执行、重复交棒和“自我介绍 ping-pong”：简单禁止机器人互相 `@` 会损失协作能力，但完全放开又缺少幂等和上下文边界。
3. 本地已经实现过 `soulPath` / `SOUL.md` 人格注入，但还没有进入当前 fork 的源码仓库；如果只改全局 npm package，后续升级会覆盖本地改动。

本方案目标是修复识别根因，同时给多 bot 协作补一层轻量的协作上下文和任务账本，让机器人可以继续多轮互相点名，但不会因为上下文不清而重复接活或循环介绍。

## 已确认根因

`available_bots` 的 bug 根因是“按 `cliId` 排除自己”。

实际部署里 Elon 和 Jennie 都是 `cliId=codex`，但它们是两个不同飞书机器人，拥有不同的 `larkAppId`。如果构造可用机器人列表时用 `entry.cliId !== current.cliId` 排除自己，Jennie 会把 Elon 一起过滤掉，反之亦然。

正确语义应是：

- `cliId` 表示 CLI 类型或执行后端，例如 `codex`、`claude-code`、`gemini`。
- `larkAppId` 才是一个飞书 bot 实例的稳定身份。
- “排除自己”必须按当前发送方的 `larkAppId` 排除，而不是按 `cliId` 排除。

修复方向：所有“当前 bot / 队友 bot / available bots”的身份判断统一使用 `larkAppId`；`cliId` 只可用于能力、别名和展示，不可作为 bot 实例唯一键。

当前 fork 的 `src/core/session-manager.ts` 已经按 `larkAppId` 排除自身，并额外要求 `mentionable=true`，这是正确方向；需要保证后续改动和编译产物都保持这个语义。此前全局 npm 安装包的 `dist` 曾出现按 `cliId` 过滤的问题，应避免再次回退。

## 设计目标

- 不用硬 hop limit 禁止协作；允许机器人在多轮中互相 `@`、追问、补充、交棒。
- 避免重复任务：同一任务、同一输入、同一 bot 在短时间内不应重复执行。
- 避免自我介绍 ping-pong：介绍类消息只作为低频 priming，不成为机器人互相触发的默认动作。
- 让每轮协作携带可读、可压缩、可持久化的 `coordination_context`。
- 给路由层一个可解释的合并窗口：短时间内多个 mention 指向同一目标时，合并成一次交付。
- 为后续 workflow、联邦 bot、跨部署拉群保留同一套幂等模型。
- 把 `soulPath` / `SOUL.md` 人格注入能力产品化到源码仓库，避免依赖不可追踪的全局 npm package patch。

## 非目标

- 不做强中心化调度器，不要求所有 bot 只能按 DAG 顺序执行。
- 不禁止 bot-to-bot mention，不用固定 `max_hops=1/2` 作为主要防循环手段。
- 不在本阶段实现完整分布式事务或全局锁。
- 不把 `cliId` 改造成唯一身份；它仍然只是 CLI 类型。
- 不把 SOUL.md 设计成远程可执行脚本；它只是一段受限的人格/偏好文本。

## 推荐方案

整体采用四件事组合：

1. **身份修复**：`available_bots` 排除自己时按 `larkAppId` 判断。
2. **协作上下文**：每条机器人触发消息附带或可追溯到 `coordination_context`，描述当前协作实例、任务、上游、期望产出和已知参与者。
3. **任务账本**：新增 `task ledger` 记录任务指纹、分配、状态和结果摘要，用于幂等判断和重复任务抑制。
4. **短窗口 mention 合并**：路由层在短时间窗口内合并对同一目标 bot、同一协作实例、相近任务指纹的 mention，形成一次输入。

核心判断不是“这已经是第几跳”，而是：

- 这是不是同一个任务？
- 目标 bot 是否已经接过或完成过？
- 新消息是否提供了新的事实、约束或明确的返工要求？
- 如果只是介绍、寒暄、重复催办，是否应该静默归档或轻量 ACK，而不是新开任务？

## 数据模型草案

### coordination_context

```ts
interface CoordinationContext {
  coordinationId: string;       // 一次协作实例，通常绑定 chatId + rootMessageId 或 workflowRunId
  taskId: string;               // 当前任务单元
  parentTaskId?: string;        // 上游任务
  rootMessageId?: string;
  chatId: string;
  origin: {
    type: 'human' | 'bot' | 'workflow' | 'webhook';
    larkAppId?: string;
    messageId?: string;
  };
  assignee?: {
    larkAppId: string;
    botName?: string;
    cliId?: string;
  };
  participants: Array<{
    larkAppId: string;
    botName?: string;
    cliId?: string;
    role?: 'owner' | 'assignee' | 'reviewer' | 'observer';
  }>;
  objective: string;
  expectedOutput?: string;
  constraints?: string[];
  handoffSummary?: string;
  idempotencyKey: string;
  createdAt: number;
  updatedAt: number;
}
```

### task ledger

```ts
interface TaskLedgerEntry {
  taskId: string;
  coordinationId: string;
  idempotencyKey: string;
  inputHash: string;
  assigneeLarkAppId: string;
  sourceMessageIds: string[];
  status: 'queued' | 'running' | 'completed' | 'failed' | 'skipped' | 'superseded';
  resultMessageId?: string;
  resultSummary?: string;
  createdAt: number;
  updatedAt: number;
  expiresAt?: number;
}
```

建议存储位置沿用 dataDir 文件存储风格，先做本地 JSON/append log 即可。索引至少覆盖：

- `coordinationId + assigneeLarkAppId + idempotencyKey`
- `chatId/rootMessageId + assigneeLarkAppId + inputHash`
- `sourceMessageId`

### idempotencyKey

建议由稳定字段组合生成：

```text
coordinationId
+ normalizedObjective
+ assigneeLarkAppId
+ normalizedMentionTarget
+ relevantInputHash
```

`normalizedObjective` 去掉寒暄、介绍模板和时间戳；`relevantInputHash` 只覆盖任务正文、引用消息摘要、附件索引和明确约束，不把每轮系统提示完整纳入。

## Prompt 注入草案

给 CLI 的 prompt 增加一个短块，放在 role / roster 之后、用户任务之前：

```xml
<coordination_context>
coordination_id: ...
task_id: ...
assigned_to: Jennie (larkAppId=cli_xxx)
origin: Elon message om_xxx
objective: 修复 available_bots 过滤 bug 的方案评审
expected_output: 给出结论、风险和下一步；不要自我介绍
known_participants:
- Elon: codex, larkAppId=...
- Jennie: codex, larkAppId=...
idempotency_key: ...
ledger_status: new | duplicate | followup | supersedes_previous
</coordination_context>
```

同时注入行为约束：

- 被 `@` 时先判断这是否是新任务、补充信息还是重复催办。
- 如果 `ledger_status=duplicate`，不要重新执行；只简短说明已有处理结果或等待状态。
- 不要主动发自我介绍，除非人类明确要求 `/introduce` 或“请介绍你们各自能力”。
- 可以继续 `@` 其他 bot，但必须带上交接摘要、期望产出和完成标准。
- 不要把“看到另一个 bot 介绍自己”理解成需要回介绍。

## 路由 / 合并策略

### available_bots

- 构造可用 bot 列表时，过滤条件为 `entry.larkAppId !== currentLarkAppId`。
- 只暴露 `mentionable=true` 的 bot，避免模型拿到无法被当前 app 正确 `@` 的 open_id。
- 同 `cliId` 的多个 bot 可以同时出现；展示时用 `botName + cliId + larkAppId` 区分。
- 自动 mention 别名可继续使用 `botName` 和受限的 `cliId`，但解析结果必须落到唯一 `larkAppId`。

### mention 合并窗口

路由层维护一个短窗口，例如 5-15 秒：

- 同一 `coordinationId`
- 同一 `targetLarkAppId`
- 相同或相近 `idempotencyKey`
- 多条 source message

满足上述条件时合并为一个任务输入，把多条消息摘要、引用和附件列表一起交给目标 bot。窗口结束后写入 ledger，再启动或续接会话。

### 幂等执行判断

收到 mention 后先查 ledger：

- `completed`：如果输入没有新信息，返回已有结果摘要或静默跳过；如果有明确返工要求，生成新 `taskId`，并记录 `parentTaskId`。
- `running/queued`：合并 source message，更新任务上下文，不启动第二个相同执行。
- `failed`：允许重试，但复用同一 `idempotencyKey` 并记录 retry count。
- `superseded`：指向新任务，不再唤起旧任务。

### 实现注意

- 普通群协作不要把“消息队列 offset”当成协作状态来源。队列可以继续负责原始消息归档，但 ledger / mention 合并状态应按 `coordinationId + targetLarkAppId` 独立维护，避免多个 bot 在同一 chatId 下互相抢读、漏读或重复读。
- prompt 里不要只告诉模型“可以 @ 同事”，还要告诉它“什么情况下不应再次 @”：对方已完成同一子任务、自己已完成同一子任务、当前消息只是介绍/寒暄/重复催办时，默认不再拉起新执行。
- 如果 bot 决定继续 `@` 同事，必须带上 `handoffSummary`、`expectedOutput` 和完成标准，避免下游 bot 只能从聊天自然语言里猜任务边界。

### 自我介绍抑制

- `/introduce` 仍保留为手动兜底，不作为协作群新成员加入后的默认自动链路。
- 识别“我是 X / 我擅长 Y / 很高兴协作”这类介绍消息时，默认不生成新任务。
- 如果人类明确要求所有 bot 介绍，则每个 bot 只对该 `coordinationId` 介绍一次，ledger 记录 `intro:<larkAppId>`。

## SOUL.md 产品化要求

本地已实现的 `soulPath` / `SOUL.md` 人格注入功能应迁移进当前 fork 的源码仓库，而不是继续依赖全局 npm package 改动。否则后续 `npm install -g` 或 package upgrade 会覆盖本地实现，导致行为不可复现。

建议产品化范围：

- `bots.json` 支持可选字段 `soulPath`，相对路径按 bot 配置文件所在目录解析；最终 realpath 必须位于同目录的 `souls/` 子树，绝对路径也受同一 allowlist 约束。
- 启动 bot 时读取并校验 `SOUL.md`，将解析结果缓存到 bot profile 或会话启动上下文。
- 新会话创建时注入 SOUL 内容；refork / resume 新分支时重新注入最新版本。
- 活跃会话是否热更新暂不承诺，默认“下一次新会话或 refork 生效”。
- 增加长度限制，例如默认 4-8KB；超限时拒绝或截断并给出明确日志。
- 增加注入风险控制：SOUL.md 只能表达人格、偏好、工作风格和长期记忆，以低优先级 `<bot_persona>` 注入；不允许覆盖系统权限、绕过审批、泄露密钥或改变 sandbox 策略。
- README 和 `bots.json.example` 需要补充 `soulPath` 示例、注入时机、长度限制和安全说明。

推荐注入块沿用本地实现命名：

```xml
<bot_persona source="/path/to/SOUL.md">
...
</bot_persona>
```

并在系统提示中明确优先级：系统/安全/工具约束高于 `<bot_persona>`，`<bot_persona>` 高于普通用户偏好但不能覆盖当前用户任务。

## 风险与验证计划

### 风险

- `larkAppId` 迁移不完整：仍有局部代码用 `cliId` 当实例身份，会继续误过滤同类 bot。
- 合并窗口过短会漏合并，过长会增加响应延迟。
- `idempotencyKey` 过粗会误跳过有效返工，过细会无法去重。
- ledger 文件并发写可能产生竞争，需要文件锁或 append-only 写入策略。
- SOUL.md 内容过长或被写入 prompt injection 文本，会影响模型遵循系统约束。

### 验证

- 单元测试：两个 bot 同为 `cliId=codex`、不同 `larkAppId` 时，`available_bots` 应互相可见。
- 单元测试：当前 bot 只排除自身 `larkAppId`，不排除同类 CLI。
- 路由测试：短窗口内三条 `@Jennie` 合并为一个 ledger entry。
- 幂等测试：同一 `idempotencyKey` 在 `running/completed` 状态下不会启动第二个执行。
- 介绍抑制测试：bot 自我介绍消息不会触发对方再介绍；人类显式 `/introduce` 仍可触发一次。
- SOUL.md 测试：`bots.json soulPath` 能在启动、新会话、refork 注入；超长、缺失文件、越权路径都有明确错误。
- 端到端测试：Elon 与 Jennie 均为 codex 时，Elon 可以 `@Jennie`，Jennie 收到任务后可根据上下文继续 `@Elon` 补充，但不会重复执行同一任务。

## 分阶段实施计划

### P0：修复身份 bug

- 将 `available_bots` 自身过滤改为按 `larkAppId`。
- 补同 `cliId` 多 bot 的回归测试。
- 检查 mention 解析、footer 寻址、roster 展示中是否还有把 `cliId` 当唯一身份的逻辑。

### P1：最小协作上下文

- 为 bot-to-bot mention 构造 `coordination_context`。
- 给 prompt 注入短块，要求模型识别重复任务、不要默认自我介绍。
- 先用内存或本地文件实现最小 ledger。

### P2：短窗口合并与幂等执行

- 在路由层实现 mention 合并窗口。
- ledger 支持 `queued/running/completed/skipped/superseded`。
- 对 duplicate/running/completed 做可观测日志和用户可读反馈。

### P3：SOUL.md 产品化迁移

- 在源码仓库实现 `bots.json soulPath`。
- 在启动、新会话、refork 注入 SOUL.md。
- 加长度限制、路径校验、注入风险控制。
- 更新 README、`bots.json.example` 和相关测试，确保全局 npm package upgrade 不会覆盖能力。

### P4：协作体验打磨

- 在 `botmux bots list` 或实时花名册里展示可协作状态、最近任务状态。
- 给重复任务、等待中任务、已完成任务提供清晰的群内反馈。
- 将 ledger 与 workflow run / federation coordination 复用同一套 `coordinationId` 语义。

## 文件路径

本文档路径：`docs/multi-bot-coordination-and-soul.md`
