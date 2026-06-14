# 多 bot 协作上下文与重复 @ 抑制方案

## 当前状态

本方案最初覆盖三类问题：

1. `available_bots` 过滤错误：同一类 CLI 的多个机器人共存时，曾经会因为按 `cliId` 排除自身而漏掉同类队友。
2. 多轮互相 `@` 容易产生重复执行、重复交棒和循环唤起。
3. `soulPath` / `SOUL.md` 人格注入已经进入当前 fork；部署时应安装/运行 fork 产物，避免依赖本机临时 patch。

截至当前验证，`available_bots` 主问题已经基本确认可用。后续重点是第二类：**bot-to-bot 多次重复 @ 的通用治理**。

自我介绍只是一个暴露问题的案例，不应成为路由层硬编码逻辑。真正要解决的是：同一协作实例里，多个上游消息或多个 bot 同时/连续 @ 同一个目标 bot 时，系统如何判断这是新任务、补充信息、重复催办、完成汇报，还是无动作价值的 mention。

## 设计原则

- 不禁止 bot-to-bot mention，也不用固定 hop limit 作为主要防循环手段。
- 不按业务关键词硬编码任务类型，例如不把“自我介绍”做成特殊路由分支。
- 不依赖模型单次自然语言判断来保证幂等；路由层必须有可观测的任务账本。
- 人类直接 @ bot 时保持宽容；bot 再 @ bot 时需要更明确的交接边界。
- 同一任务、同一目标 bot、同一有效输入，在短时间内只启动一次执行；后续重复消息合并到同一任务上下文。
- 新事实、新约束、返工要求必须能生成新任务或子任务，而不是被粗暴去重。

## 推荐方案

整体采用四件事组合：

1. **身份修复**：`available_bots` 排除自己时按 `larkAppId` 判断，`cliId` 只表示执行后端类型。
2. **协作上下文**：每条 bot-to-bot 触发消息都附带或可追溯到 `coordination_context`，描述协作实例、目标任务、上游、期望产出和参与者。
3. **任务账本**：`task ledger` 记录任务指纹、分配对象、状态、结果摘要，用于幂等、合并和重复抑制。
4. **短窗口 mention 合并**：路由层在短时间窗口内合并同一目标 bot、同一协作实例、相同 `taskKey` 的多条 mention，形成一次输入。

核心判断不是“这是第几跳”，也不是“这是不是自我介绍”，而是：

- 这是不是同一个任务？
- 目标 bot 是否已经接过、正在做、或完成过？
- 新消息是否提供了新事实、新约束或明确返工要求？
- 如果只是重复催办、完成汇报、寒暄或低信息 mention，是否应该合并、轻量 ACK、静默归档，而不是启动新执行？

## 为什么需要 handoff contract

bot-to-bot 的 `@` 有两种完全不同的语义：

- **通知型 mention**：让对方看到上下文，但不要求立即执行。
- **行动型 handoff**：把一个明确任务交给对方执行。

飞书的 `@` 本身无法区分这两种语义。没有额外结构时，下游 bot 和 ledger 只能从自然语言里猜：

- 目标任务是什么？
- 上游已经完成了什么？
- 下游要交付什么？
- 什么算完成？
- 这条消息是新增需求、重复催办，还是完成汇报？

因此，bot 如果希望另一个 bot **执行任务**，应尽量带上 handoff contract：

```xml
<handoff>
  <summary>上游已完成/发现的事实</summary>
  <expected_output>希望目标 bot 产出的内容</expected_output>
  <completion_standard>完成标准或验收条件</completion_standard>
</handoff>
```

这三个字段不是为了增加流程负担，而是为了让任务边界稳定：

- `summary` 让下游不用重新推断上游上下文。
- `expected_output` 让 ledger 可以生成稳定的任务指纹。
- `completion_standard` 让下游知道何时停止，不会再把任务甩回去。

### 缺失 handoff contract 时的降级

MVP 不应硬性拒绝所有缺失 contract 的 bot-to-bot mention，否则会破坏现有自然语言协作。建议降级策略：

- 如果消息有明确行动请求，使用自然语言生成 fallback `taskKey`，并在 prompt 中标记 `handoff_contract=missing`，提醒目标 bot 不要继续无结构交棒。
- 如果消息只是完成汇报、寒暄、重复催办或“你也说两句”这类低信息 mention，不启动新执行；只写 ledger/log，必要时轻量 ACK。
- 如果消息补充了新事实或明确返工要求，生成新 `taskId`，并按需设置 `parentTaskId`，不要被旧任务去重。

长期可以给 `botmux send --mention` 增加结构化参数，例如 `--handoff-summary`、`--expected-output`、`--completion-standard`。在 CLI 参数落地前，可先用 prompt 模板要求 bot 在正文里写 `<handoff>` 块。

## 数据模型草案

### coordination_context

```ts
interface CoordinationContext {
  coordinationId: string;       // 一次协作实例，通常绑定 chatId + rootMessageId 或 workflowRunId
  taskId: string;               // 当前任务单元
  parentTaskId?: string;        // 上游任务
  chatId: string;
  rootMessageId?: string;
  origin: {
    type: 'human' | 'bot' | 'workflow' | 'webhook';
    larkAppId?: string;
    messageId?: string;
  };
  assignee: {
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
  completionStandard?: string;
  constraints?: string[];
  handoffSummary?: string;
  handoffContract: 'present' | 'missing' | 'not_required';
  taskKey: string;              // 稳定任务键：同一任务的补充信息不会改变它
  inputRevisionHash: string;    // 当前输入版本：用于判断是否有新增事实/约束
  promptStatus: 'new' | 'merged' | 'duplicate' | 'rework' | 'skipped';
  createdAt: number;
  updatedAt: number;
}
```

### task ledger

```ts
interface TaskLedgerEntry {
  taskId: string;
  coordinationId: string;
  taskKey: string;
  latestInputRevisionHash: string;
  inputRevisionHashes: string[];
  assigneeLarkAppId: string;
  sourceMessageIds: string[];
  status: 'queued' | 'running' | 'completed' | 'failed' | 'skipped' | 'superseded';
  objective: string;
  expectedOutput?: string;
  completionStandard?: string;
  parentTaskId?: string;
  resultMessageId?: string;
  resultSummary?: string;
  retryCount?: number;
  createdAt: number;
  updatedAt: number;
  expiresAt?: number;
}
```

索引至少覆盖：

- `coordinationId + assigneeLarkAppId + taskKey`
- `chatId/rootMessageId + assigneeLarkAppId + taskKey`
- `sourceMessageId`

## 任务键、输入版本与幂等

重复 @ 治理需要拆成两层：

- `taskKey`：稳定任务键，用来判断“是不是同一个任务”。
- `inputRevisionHash`：输入版本哈希，用来判断同一任务下是否出现新增事实、约束、附件或返工要求。

`taskKey` 应由稳定字段生成：

```text
coordinationId
+ assigneeLarkAppId
+ normalizedObjective
+ normalizedExpectedOutput
```

`inputRevisionHash` 单独覆盖可变化输入：

```text
normalizedConstraints
+ referencedMessageSummaries
+ attachmentRefs
+ explicitReworkSignal
```

这样补充信息不会绕过去重：它命中同一个 `taskKey`，但带来新的 `inputRevisionHash`，路由层会把它作为 `followup_info` 合并到已有任务。

要求：

- `normalizedObjective` 来自 handoff contract；缺失时从自然语言提取 fallback objective。
- `normalizedExpectedOutput` 用来区分“实现修复”“测试验证”“总结结果”等不同交付。
- `inputRevisionHash` 不包含系统提示、时间戳、寒暄和脚标。
- 不引入业务特定 key，例如 `intro`。自我介绍、代码实现、测试验证都走同一套任务键。

MVP 只使用确定性字段匹配，不做“语义相近”合并。语义相似度可作为后续增强，否则测试难写，也容易误合并正常协作。

## 路由与合并策略

### 输入分类

收到 bot-to-bot mention 后，路由层先做轻量分类：

- `actionable_task`：有明确目标和期望产出，应进入 ledger。
- `followup_info`：补充事实、约束或附件，应合并到已有任务。
- `retry_or_rework`：明确要求重试、返工、修复，应生成新任务或子任务。
- `completion_report`：上游汇报自己已完成，不应触发目标 bot 重做。
- `duplicate_nudge`：重复催办或重复点名，不启动新执行。
- `non_actionable`：寒暄、介绍、客套、低信息 mention，不启动新执行。

这个分类不能依赖单个业务关键词；MVP 可用规则 + prompt 约束 + ledger 状态组合实现，后续再考虑更强的语义解析。

### 短窗口 fan-in 合并

维护一个 5-15 秒窗口，按以下键聚合：

- `coordinationId`
- `targetLarkAppId`
- 相同 `taskKey`

窗口内多条 source message 合并为一次输入：

- 合并消息摘要、引用和附件列表。
- 只启动一个 worker turn。
- ledger 记录所有 `sourceMessageIds`。
- 如果窗口内出现新的 `inputRevisionHash`，把它并入同一个任务的输入版本列表。

这解决“Jennie 同时收到 CEO、Trae、CEO 又催一次”的场景：Jennie 只看到一次合并后的任务，而不是连续三个独立 turn。

### ledger 状态处理

收到 mention 后查 ledger：

- `queued/running`：合并 source message 和补充信息，不启动第二个执行。
- `completed`：如果没有新事实，跳过或轻量 ACK；如果有明确返工要求，创建子任务并设置 `parentTaskId`。
- `failed`：允许重试，增加 `retryCount`，保留同一任务上下文。
- `superseded`：指向新任务，不再唤起旧任务。
- 未命中：创建新任务，状态从 `queued` 开始。

跳过不是“丢消息”：所有被合并或跳过的 source message 都要落 ledger/log，方便诊断。

### 状态分层

避免把不同层级的状态混用：

- **输入分类**：`actionable_task | followup_info | retry_or_rework | completion_report | duplicate_nudge | non_actionable`。
- **ledger 持久状态**：`queued | running | completed | failed | skipped | superseded`。
- **prompt 展示状态**：`new | merged | duplicate | rework | skipped`。

路由层用输入分类决定是否创建/合并任务；ledger 只保存持久执行状态；prompt 展示状态只用于告诉模型本轮应该如何行动。

## Prompt 注入草案

给 CLI 的 prompt 增加短块，放在用户消息之前：

```xml
<coordination_context>
  <coordination_id>...</coordination_id>
  <task_id>...</task_id>
  <parent_task_id>...</parent_task_id>
  <assigned_to lark_app_id="cli_xxx">Jennie</assigned_to>
  <origin type="bot" lark_app_id="cli_elon" message_id="om_xxx" />
  <objective>验证后端修复是否覆盖重复 @ 场景</objective>
  <expected_output>给出验证结论、失败用例和风险</expected_output>
  <completion_standard>能复现/不能复现都要说明证据；不要再点名其他 bot 做同一验证</completion_standard>
  <handoff_contract>present</handoff_contract>
  <task_key>...</task_key>
  <input_revision_hash>...</input_revision_hash>
  <prompt_status>new</prompt_status>
  <source_message_ids>om_a,om_b,om_c</source_message_ids>
</coordination_context>
```

同时注入行为规则：

- 先判断本轮是新任务、补充信息、重复催办、完成汇报，还是无动作价值的 mention。
- 如果 `prompt_status=duplicate`，不要重新执行；只简短说明已有状态或等待结果。
- 如果 `prompt_status=merged`，把新增信息纳入当前任务，不要开第二个执行。
- 如果要继续 `@` 其他 bot，必须说明交接摘要、期望产出和完成标准；没有明确任务时不要 `@`。
- 不要把看到另一个 bot 的完成汇报、介绍、寒暄理解成自己也要执行同类动作。

## 实现注意

- 普通群协作不要把消息队列 offset 当成协作状态来源。队列继续负责原始消息归档；ledger / mention 合并状态按 `coordinationId + targetLarkAppId` 独立维护。
- `available_bots` 只暴露 `mentionable=true` 的 bot，避免模型拿到无法被当前 app 正确 `@` 的 open_id。
- `cliId` 不能作为 bot 实例唯一身份；同 `cliId` 的多个 bot 必须能同时出现在花名册中。
- 并发去重必须先做原子 reservation：原始消息落队列后，用文件锁/事务按 `coordinationId + targetLarkAppId + taskKey` upsert `queued` ledger；抢到 reservation 的路径才允许启动 worker，没抢到的路径只合并 source message 和 input revision。
- worker 调度成功后把状态推进为 `running`；调度失败标记 `failed` 或 `skipped`，不能留下永久 `queued`。
- duplicate/running/completed 的处理要有日志；后续可在群里提供低频、可读的“已合并/已跳过”反馈，但避免反馈本身再次触发 bot。

## 自我介绍案例如何落入通用模型

人类要求“团队成员做自我介绍”时：

- 这是一个普通 `actionable_task`，不是特殊路由类型。
- CEO 如果分派给 Trae/Jennie，应生成两个普通任务：`assignee=Trae` 和 `assignee=Jennie`。
- 如果 Trae 完成后又 @ Jennie“你也介绍一下”，Jennie 已有相同协作实例下相同 `taskKey` 的任务，则 ledger 应把它合并或判定为 duplicate，而不是因为识别了“介绍”关键词。
- 如果人类后来追加“再介绍一下你的测试边界”，这是新约束，应作为 follow-up 或子任务处理。

也就是说，自我介绍只作为测试样例验证通用幂等机制，不作为硬编码业务 key。

## SOUL.md 部署原则

`soulPath` / `SOUL.md` 不再作为本机临时补丁维护。正确方式是把能力保留在当前 fork 的源码仓库中，并把 fork 的构建产物安装/链接为当前机器实际运行的 botmux。

这样 botmux 本身就是原工具的“更新版本”，后续升级也可以通过 fork 合并上游，而不是重新手改全局 npm package。

部署要求：

- `bots.json` 支持可选字段 `soulPath`。
- 相对路径按 bot 配置文件所在目录解析；最终 realpath 必须位于同目录的 `souls/` 子树，绝对路径也受 allowlist 约束。
- 启动 bot 时读取并校验 `SOUL.md`；新会话创建和 refork/resume 时注入最新内容。
- 活跃会话热更新暂不承诺。
- 增加长度限制、路径校验和注入风险控制。
- SOUL 只能表达身份、职责、偏好、工作风格和长期记忆；不能覆盖系统、安全、工具、审批、sandbox 规则。

推荐注入块：

```xml
<bot_persona source="/path/to/SOUL.md" priority="low">
...
</bot_persona>
```

## 验证计划

- `available_bots`：两个 bot 同为 `cliId=codex`、不同 `larkAppId` 时，互相可见；当前 bot 只排除自身 `larkAppId`。
- fan-in 合并：短窗口内三条 `@Jennie` 合并成一个 ledger entry 和一个 worker turn。
- 幂等执行：同一 `taskKey` 在 `queued/running/completed` 状态下不会启动第二个执行。
- 输入版本：同一 `taskKey` 的新增约束产生新的 `inputRevisionHash`，被合并为 follow-up，而不是绕过去重。
- 返工识别：completed 后有明确新约束/返工要求时，生成子任务而不是跳过。
- contract 降级：bot-to-bot mention 缺少 handoff contract 但有明确行动请求时可执行；低信息 mention 不启动新任务。
- 自我介绍案例：团队自我介绍不依赖 `intro` 硬编码，仍能避免 Jennie/Trae 互相重复点名。
- SOUL.md：从 fork 构建/安装后的运行版能读取 `soulPath`，并在启动、新会话、refork 注入；超长、缺失文件、越权路径都有明确错误。
- 端到端：Elon 可以让 Trae/Jennie 协作；Jennie 收到多条重复 mention 时只执行一次；正常多轮协作仍可继续。

## 分阶段实施计划

### P0：身份和提示修复

- `available_bots` 按 `larkAppId` 排除自身。
- follow-up/refork prompt 也注入 `available_bots`。
- 修复 `botmux send/history` session 自动识别、pane 内 PATH 指向当前 fork、显式 bot mention 时不追加真人脚标。

### P1：通用最小 ledger

- 移除业务特定任务 key，例如 `intro`。
- 生成通用 `taskKey`：`coordinationId + assignee + objective + expectedOutput`。
- 单独生成 `inputRevisionHash`：约束、引用摘要、附件和返工信号。
- 为 bot-to-bot mention 注入 `coordination_context`。
- ledger 支持 `queued/running/completed/failed/skipped/superseded` 的最小状态。

### P2：短窗口合并

- 实现 per-target fan-in buffer。
- 合并窗口内多条 source message，只启动一个 worker turn。
- 对 `queued/running/completed` 做可观测日志和低频反馈。

### P3：handoff contract 产品化

- 先通过 prompt 模板要求 bot-to-bot 行动型 mention 携带 `<handoff>` 块。
- 再考虑给 `botmux send --mention` 增加结构化参数。
- 对缺失 contract 的 bot-to-bot mention 做兼容降级，不直接破坏现有协作。

### P4：部署与回归

- 使用当前 fork 的构建产物作为机器上的实际运行版。
- 保持 README、`bots.json.example` 和相关测试与 fork 实现一致。
- 后续升级从上游合并到 fork，再重新构建/安装，不再维护全局 npm package 临时 patch。

## 下一窗口交接计划

### 目标

新窗口继续实现“重复 @ 治理”的通用方案：保留正常多轮协作能力，但避免同一协作实例里多个 bot 对同一目标重复点名后反复启动相同任务。

### 当前仓库状态

- 本文档已经按最新思路调整：自我介绍只是测试样例，不是业务特判。
- `soulPath` / `SOUL.md` 已进入 fork 源码；下一步不需要维护全局 npm patch。
- `available_bots` 主问题已经修复并验证过，后续只在回归测试里覆盖。
- 当前源码里已有一版最小 `coordination-ledger`，但它仍包含 `intro` 特判，只能视为早期实验实现，不能作为最终方案延续。

### 新窗口优先级

1. 先读本文档，尤其是“任务键、输入版本与幂等”“路由与合并策略”“实现注意”三节。
2. 检查当前实现入口：
   - `src/services/coordination-ledger.ts`
   - `src/daemon.ts` 里的 `evaluateInboundCoordination`
   - `src/core/session-manager.ts` 里的 `buildCoordinationContextBlock`
   - `test/coordination-ledger.test.ts`
3. 第一优先级是移除 `intro` / `isIntroLike` 这类业务硬编码，改成通用 `taskKey + inputRevisionHash`。
4. 第二优先级是把状态分层：输入分类、ledger 持久状态、prompt 展示状态不要混用。
5. 第三优先级是补最小 fan-in 或 reservation 语义；如果暂时不做完整 5-15 秒 buffer，也必须保证同一 `coordinationId + assignee + taskKey` 不会并发启动两个 worker。
6. 最后再产品化 handoff contract；MVP 应兼容自然语言 mention，不能因为缺少 `<handoff>` 就直接拒绝明确任务。

### 实现约束

- 不增加“自我介绍”“实现接口”“测试验证”等业务关键词分支。
- 不用固定 hop limit 作为主要防循环机制。
- 不要把普通 bot-to-bot 协作禁掉；只抑制重复、低信息、完成汇报和已接单任务的再次启动。
- 人类 follow-up 要保持可见；不能因为 ledger 已有记录就静默吞掉人的追加要求。
- 所有 skip、merge、duplicate 都要有日志或 ledger 记录，方便之后诊断。

### 建议验收命令

```bash
COREPACK_DEFAULT_TO_LATEST=0 pnpm vitest run test/coordination-ledger.test.ts test/prompt-builder.test.ts test/bot-routing.test.ts test/tmux-backend-env.test.ts
COREPACK_DEFAULT_TO_LATEST=0 pnpm exec tsc --noEmit
COREPACK_DEFAULT_TO_LATEST=0 pnpm build
git diff --check
```

### 建议新增/调整测试

- 同一协作实例里 CEO、Trae、CEO 连续 `@Jennie`，只生成一个可执行任务，其他 source message 被合并。
- Trae 已完成任务后，Jennie 再 `@Trae` 要求做同一任务，Trae 不应重复执行。
- 同一任务追加新约束时，命中同一 `taskKey`，但产生新的 `inputRevisionHash`，并作为 follow-up/rework 处理。
- 普通“接下来请实现”“请测试验证”“请总结风险”不能被误判为自我介绍或重复介绍。
- 人类明确追加要求时，即使 taskKey 相同，也不能像 bot duplicate 一样跳过。

## 文件路径

本文档路径：`docs/multi-bot-coordination-and-soul.md`
