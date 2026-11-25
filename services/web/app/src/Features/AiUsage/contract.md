# AiUsage 契约（用量记录 holder）

一句话：**业务代码只 require `Features/AiUsage`**，永不直接碰 `impl.js`。
开源仓库里没有 `impl.js`，holder 加载 `./dummy`，于是「记账」变成空转，
计费/用量 UI 自动隐藏，代码里不需要任何 `if (isOpenSource)`。

## 加载顺序

1. `process.env.AI_USAGE_IMPL` —— 任意路径的私有实现（可以在仓库外）
2. `./impl.js` —— 仓内私有实现（`.gitignore`，只有商业分支的部署树里存在）
3. `./dummy` —— 哑实现（开源仓库走这条）

`index.js` 先 `fs.existsSync` 再 `require`：私有实现**内部**缺模块时错误码同样是
`MODULE_NOT_FOUND`，用 try/catch 会把它误判成「没有私有实现」→ 静默不记账。

私有实现必须导出 `record` 与 `summaryToday`，缺一个就直接抛错拒绝启动
（宁可起不来，也不要以「记不上账」的状态对外服务）。

## 接口

| 方法 | 调用方 | 契约 |
| --- | --- | --- |
| `record(entry)` | `llm-relay.js`、`ai-agent.js`、`real-sub-agents.js` | **永不抛**。无 `userId` 静默跳过。`billing='free'` 只记用量不扣费。扣费用上游 `requestId` 做幂等键，且**不 await** |
| `summaryToday(userId)` | `GET /api/llm/usage` | `null` = 没有账本（哑实现）；否则 `{calls,promptTokens,completionTokens,totalTokens,byModel,bySource}` |
| `isEnabled()` | 控制器 / 前端 meta | 哑实现恒 `false` |
| `COLLECTION_NAME` | 日志 / 测试 | 默认 `llm_usage` |

## entry 字段

| 字段 | 说明 |
| --- | --- |
| `userId` | Overleaf user id（无则整条丢弃） |
| `source` | `relay`（白板/OpenAI 兼容转发）或 `ft-ai`（站内 AI 助手、Agent、翻译/总结） |
| `billing` | `user` / `service` / `free`（免费大模型目录里的模型） |
| `model` | **实际发出去**的模型 id（回落时是回落后的模型，不是用户选的那个） |
| `status` / `ms` / `requestId` | 上游状态码、耗时、上游 request id |
| `usage` | OpenAI 形状：`prompt_tokens` / `completion_tokens` / `total_tokens`。`responses` 协议的 `input/output_tokens` 已在 `providers/responses.js` 归一 |

## 两种协议都要能记上

- `chat_completions`：非流式取 `response.usage`；流式靠 `stream_options.include_usage`
  + `commercial/llm-usage.js` 的 `createUsageTap`（公开侧，纯协议解析）。
- `responses`：流式取 `response.completed` 事件的 `response.usage`；
  非流式取 `payload.usage`；两者都经 `llm-relay.js` 的 `toChatUsage()` 归一。

## 改这块之前的检查清单

1. `record()` 里任何 `throw` 都等于让一次成功的大模型调用变成 500 —— 全部 try/catch 吞掉并打日志。
2. 新增字段：同时改 `impl.example.js` 的注释与 `impl.js`，历史行保持可解释。
3. `impl.js` 不得提交（`.gitignore` 已拦）；`git status` 里出现它就是要出事。
4. 商业分支与开源分支都要能启动：holder / dummy / example 三件套必须同时存在于两个分支。
