# 2026-06-16 多 bot 子话题路由问题交接

## 当前状态

- 问题仍未解决。
- 我之前提交并推送的 `9d6292b1 修复多话题协作回复路由` 判断不完整，已用反向提交撤销：
  - `92659b35 Revert "修复多话题协作回复路由"`
- 本地未提交的 `src/types.ts` 试探性改动已丢弃。

## 用户期望

在普通群“柏禧的天才小组”里，用户 @ CEO 派任务时：

1. CEO 可以在用户问题下新建子项目话题。
2. CEO 在子话题里 @ 下属派活。
3. 后续同一任务的所有系统确认、下属回复、回报、催办、CEO 汇总，都应留在这个子项目话题里。
4. 不能突然回到外层主群聊天框，否则任务层级混乱。

## 最新复现

用户在“柏禧的天才小组”发：

```text
@[CEO]Elon 帮我做一个简单的计算器 app，网页版
```

观察到：

- CEO 创建了计算器子话题，并在子话题中 @ Trae/Jennie。
- Trae/Jennie 随后在主聊天框回复了：
  - `🔄 已切换到 ALL-IN-ONE`
- Trae 又在主聊天框普通回复了实现回报。
- CEO 被主聊天框里的 Trae 回复再次唤醒，然后又在主聊天框继续派 Jennie。

## 已确认的运行时证据

群 chat id：

```text
oc_56e30e218607f0db084c3a8bd02274ff
```

计算器子话题 root：

```text
om_x100b6c38f6c44ca8e2ed0f4e21face3
```

dispatch registry 已记录计算器子项目：

```json
{
  "orchRoot": "om_x100b6dc7ca6d88a4e1286e305da16b5",
  "orchChatId": "oc_56e30e218607f0db084c3a8bd02274ff",
  "orchScope": "chat",
  "orchAppId": "cli_aa9783c864f91bb5",
  "title": "计算器网页应用实现与验收",
  "bots": [
    "ou_97014d9aa0d68692e0ed405bda2fa274",
    "ou_8aa491c994e518bd1a4812ca6bfa2ed9"
  ]
}
```

队列文件：

```text
/home/huangbaixi/.botmux/data/queues/oc_56e30e218607f0db084c3a8bd02274ff.jsonl
```

关键消息：

- line 40：用户主群请求计算器。
- line 41/42：CEO 在计算器子话题派发 Trae/Jennie，`rootId=om_x100b6c38f6c44ca8e2ed0f4e21face3`。
- line 45：Trae 实现回报落到主群，`rootId=""`。
- line 46：CEO 在计算器子话题继续派 Jennie，说明 CEO 后续也尝试过回话题，但前面 Trae 的主群消息已经污染了主会话。

daemon 日志显示 `/repo` 确认也落到主群：

```text
04:05:24 [b9dd137c] Command: /repo
04:05:25 Sent message ... to chat oc_56e30e218607f0db084c3a8bd02274ff
04:05:25 [b9dd137c] Repo selected via /repo /home/huangbaixi/ALL-IN-ONE
```

同类 Jennie 日志：

```text
04:05:24 [f1f34ef6] Command: /repo
04:05:26 Sent message ... to chat oc_56e30e218607f0db084c3a8bd02274ff
04:05:26 [f1f34ef6] Repo selected via /repo /home/huangbaixi/ALL-IN-ONE
```

## 我前一个修复为什么无效

`9d6292b1` 主要思路是记录：

```text
turnId -> topic rootMessageId
```

然后让 `final_output`、`botmux send`、`botmux report` 通过这个映射回到原话题。

这个思路只覆盖了规范的 `scope: "chat"` session。实际复现中 Trae/Jennie 复用了历史遗留 session：

```json
{
  "scope": null,
  "rootMessageId": "oc_56e30e218607f0db084c3a8bd02274ff",
  "currentReplyTarget": {
    "rootMessageId": "om_x100b6c3802b914a0e1651e098d81a05",
    "turnId": "om_x100b6c382a7694a8e10b7fde81959a2"
  },
  "replyTurnTargets": null
}
```

这类 session 本质是 chat-scope，但代码大量位置只认 `scope === "chat"`。结果：

- `beginReplyTargetTurn()` 不记录新的计算器 topic alias。
- `resolveSessionReplyTarget()` 不按 chat-scope topic alias 路由。
- `/repo` 这种 daemon command confirmation 仍发主群。
- 后续普通 `botmux send` 也可能继续主群泄漏。

所以前一个提交是局部修复，不是根因修复。

## 下一步建议

建议下一位不要从 prompt 入手，先从 session scope 兼容和路由不变量入手。

优先检查并修复：

1. 历史 session scope 推断
   - `scope` 缺失但 `rootMessageId` 是 `oc_...` 或等于 `chatId` 时，应视为 chat-scope。
   - 恢复 active sessions 时应写回 `session.scope = "chat"`，避免每次重启继续错误。

2. 所有 session 路由统一走同一个 effective scope
   - `sessionAnchorId`
   - `restoreActiveSessions`
   - `resumeSession`
   - `findChatReplyAlias`
   - `beginReplyTargetTurn`
   - `resolveSessionReplyTarget`
   - daemon command `sessionReply`

3. `/repo` daemon command confirmation 必须有测试
   - 输入：历史 `scope:null + rootMessageId=oc_chat` session，从子话题触发 `/repo`。
   - 期望：`🔄 已切换到 ...` reply 到子话题 root，而不是 `sendMessage(chatId)`。

4. 下属在子话题内普通 `botmux send` 的行为必须硬约束
   - 如果当前 turn 来自 dispatch 子话题，默认发送目标应是该子话题。
   - 只有显式 `--top-level` 才允许主群。

5. `botmux report` 仍然应该保留，但不能把正确性完全压在 prompt 上
   - agent 不调用 `report` 时，普通 `send` 也不能泄漏。

## 建议的回归测试

- legacy chat-scope session 恢复测试：
  - `scope` 缺失，`rootMessageId=oc_chat`，恢复后 runtime scope 应为 `chat`。

- command confirmation 测试：
  - 子话题里触发 `/repo /path`，确认消息走 `replyMessage(topicRoot)`。

- worker final output 测试：
  - legacy session 从子话题触发任务，最终输出仍回子话题。

- botmux send 测试：
  - legacy session 中 `current turnId` 属于子话题时，默认 `botmux send` 回子话题。

- orchestration e2e 或近似集成测试：
  - CEO dispatch 子话题 -> sub-bot `/repo` -> sub-bot send/report -> CEO follow-up，所有消息 `rootId` 都应等于子话题 root。

## 重要提醒

不要把这个问题简化为“让 CEO prompt 写得更清楚”。prompt 可以辅助，但不能保证 daemon command、bridge final output、普通 send 的路由正确。真正的不变量应该在 botmux 路由层保证。
