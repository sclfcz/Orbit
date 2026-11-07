# Orbit 接入 Codex CLI：实施交接计划

状态：待实施。本文是交给 Codex 的任务说明，不表示功能已完成或通过真实验收。

## 1. 目标和已确定的方案

让 owner 在 Orbit 中明确指定“用 Codex 做这个任务”，由本机 Connector 完成派发、进度上报、结构化报告、同会话接续、中断、重启恢复及本地会话记录查看。

**与当前 Claude Code 一样，接入本机 CLI，不接入桌面界面。** 当前 `ClaudeAdapter` 驱动 `claude` CLI；新增 `CodexAdapter` 驱动独立安装的 `codex` CLI，通过其官方 **`app-server` stdio JSON-RPC** 接口通信。

```text
Orbit Steward → Connector / WorkerManager → CodexAdapter → codex app-server
                                      ↘ 本机状态库、worktree、会话记录
```

每个 Orbit worker 管理一个 app-server 进程，复用现有 worktree、仓库锁、执行槽位、命令去重、事件持久化及恢复次数限制。不要新增另一套调度器。

用户目前使用 Codex 桌面版，已表示需要时可以安装 CLI。桌面版继续使用；不依赖 app bundle 内部路径，不自动操作桌面窗口，不接管用户已打开的桌面会话，也不承诺 Orbit 创建的会话会自动出现在桌面版。

## 2. 实施边界

### 第一版必须完成

- 检测本机 Codex CLI 并上报 agent 能力；明确指定 `codex` 后可派发。
- worktree 写入任务；可验证的只读执行，不能保证时如实拒绝。
- 流式进度、合法结构化报告，以及错误、取消、未报告的区别处理。
- 原会话继续、运行中 steer、当前轮结束后再发送、interrupt、stopProcess。
- Connector 重启后保留真实会话身份；不重复执行交付结果不确定的指令。
- 已接受的延后消息持久化，重启后交付或明确返还，不能静默消失。
- 工作台显示 Codex 名称，并可查看其本机完整会话记录。
- Pi / Claude 既有行为通过受影响路径回归。

### 本次不扩展

- 不更换 steward 的模型，不改变默认 worker 选择，不增加云端 Codex 登录页。
- 不导入任意已有 Codex 会话，不做桌面控制或跨端会话同步。
- 不增加权限审批 UI、通用授权模型或前次架构分析中的其他自主推进功能。
- 图片能力验证后再声明；未支持时明确拒绝，不静默忽略输入。
- 不默认开启 `danger-full-access`，不修改用户全局 Codex 配置，不复制认证文件。

使用 CLI 实际可用的登录及默认模型配置。是否复用桌面登录须验证；若需要交互登录，由用户完成。已有显式 model 参数正常传递，恢复时不要用空值覆盖 Codex thread 已保存的设置。

## 3. 开始实施前

1. 阅读根目录 `AGENTS.md`、`CONTEXT.md`，以及 ADR-0001、ADR-0005、ADR-0011。
2. 检查当前 git diff。写计划时以下文件已有用户修改，须保留：
   - `apps/steward/src/steward.ts`
   - `apps/steward/src/llm/connection-test.ts`
   - `apps/steward/src/llm/models.ts`
   这只是快照；实施时以实际工作区为准，不覆盖或清理其他既有内容。
3. 检查 `codex` 的实际路径、版本及认证状态。此前仅确认当前 PATH 未找到命令，未验证桌面安装或 CLI 登录。缺少 CLI 时给出官方安装步骤；不要假设当前环境已准备好。
4. 使用根 `package.json` 的 packageManager 指定 pnpm（当前 10.33.0），Node ≥22.18.0。
5. 未另获用户授权，不提交、推送、发布或部署。这里的实施交接不包含这些动作。

## 4. 已核对的现有接入点

| 位置 | 可复用事实 / 需要处理的点 |
|---|---|
| `apps/connector/src/agent.ts` | AgentKind 已预留 codex；AgentAdapter 已定义生命周期和能力位 |
| `apps/connector/src/connector-app.ts` | defaultAdapters 注册 Pi 和检测到的 Claude；hello.agents 由 adapter 集合生成 |
| `apps/steward/src/dispatch.ts` | 按机器实际 agent 过滤；跨 agent 接力使用新会话，不需重新设计路由 |
| `apps/connector/src/worker-manager.ts` | 复用 worktree、锁、启动/中断/恢复流程；部分恢复逻辑具有 Pi 格式假设 |
| `apps/connector/src/store.ts` | 本机持久化身份、命令及恢复状态的落点 |
| `apps/connector/src/commands.ts`、`session-observation.ts`、`session-tail.ts` | 当前恢复证据主要识别 Pi marker / tail，必须区分 Codex |
| `apps/connector/src/full-session-history.ts` | 复用 readFullSessionHistory 的 JSONL 分片、分页、游标与文件变化检测 |
| `apps/steward/ui/session-model.js`、`workspace.js` | 增加 Codex 记录识别和标签；未知记录继续保留 raw |

原则上不需要协议升版、添加 agent 枚举、修改 steward prompt 或 LLM 工具定义。若发现确需改动路由受保护表面，说明原因并执行 ADR-0001 要求的 routing eval。

## 5. 实施顺序

### 阶段 A：确认协议与真实行为

研究基线是官方稳定发布 `rust-v0.167.0`（2026-11-06）；它是计划时查阅的版本，**不是未经测试就指定的最低版本**。以实际安装版本和官方生成协议定义固定支持范围，记录真实测试版本。

确认 initialize/initialized、thread/start/resume、turn/start/steer/interrupt、outputSchema、通知和错误格式、usage、实际记录格式。

关键身份约束：

- Orbit Thread 是事项；Codex `thread.id` 是恢复身份。保存到 Orbit 的 worker sessionId 时，存 Codex `thread.id`，不是新版 Codex 表示会话树根的 `thread.sessionId`。
- Codex `thread.path` 可空且标为 unstable；新 thread 尚未工作时未必持久化。有 ID 不代表首条任务已接收。
- `clientUserMessageId` 只能在验证后用于接收证据关联，不能直接宣称服务端去重或 exactly-once。

真实 CLI 就绪后，在独立测试仓库验证只读、worktree 写入、结构化报告、续接和中断。CLI/认证暂缺时，可以继续 fake、接口实现和确定性测试，但必须保留真实验收未完成状态，不编造行为或验收记录。

### 阶段 B：实现 CodexAdapter 和自动发现

新增 `apps/connector/src/codex-adapter.ts`，按需拆一个小型 transport 模块。stdio 客户端处理请求 ID、超时、退出时拒绝待处理请求、分片输入；区分 response、notification 和 server request，stderr 不进入协议解析。

| Orbit 操作 | Codex 映射 |
|---|---|
| start | initialize → initialized → thread/start → 持久化身份与交付意图 → turn/start |
| idle send / cold resume | 必要时 thread/resume，再 turn/start |
| running steer | turn/steer，携带 expectedTurnId |
| after | WorkerManager 的持久队列，当前 turn 结束后再 turn/start |
| interrupt | turn/interrupt；RPC 确认不等于已取消，等待真实终态并处理完成竞态 |
| stopProcess | 停止本 worker 拥有的进程树，保留会话记录 |

用 `turn/start.outputSchema` 请求既有 ReportPayload（含 answer），本地验证后才发 report。schema 需满足 Codex 支持的 JSON Schema 子集，并与现有报告合约保持一致。失败、取消、缺失/无效报告分别映射 error、aborted、unreported；不能把退出码 0 或任意最后文本当作任务完成。不要为此新增实验 dynamicTools 或 MCP 服务。

事件按进程代次、thread ID、turn ID 关联；处理回应前到达的通知、重复/迟到通知，每轮只 settle 一次。提供 workerPids、workerActivity、isRunning、isStreaming，接入现有监控和清理。未提供的费用保持未知，不由 token 数臆算。

复用 `adjudication.ts`，以及现有 childEnv、normalizeReport、extractTarget、RESUME_PROMPT 等工具；必要时小范围抽离 Pi 模块中的通用函数，不全面重构旧 adapter。

修改 `connector-app.ts`，增加 detectCodex、可注入 codexCommand 和注册。未安装不注册，不兼容版本给出诊断，认证失败明确提示。检测应有超时且不调用模型；不要在发现阶段启动业务任务。区分交互终端与后台 daemon 的 PATH。

### 阶段 C：可靠交付和恢复

这是发布条件，不能以“首次启动成功”代替。

1. **首 prompt 前保存身份。** 兼容扩展 agent.ts 的 onSession，使其能传回真实恢复 ID、可空 path 和观察基线。必须确认 LocalStore 保存完成后才发送工作输入，不能只等 start 返回后保存。
2. **按 agent 检查恢复证据。** 增加 Codex 观察/解析模块，接入 commands、session-observation、session-tail 和 manager。Codex JSONL 不得交给 Pi parser 判 not_started。
3. **区分三种交付结果。** 可证明收到才 delivered，可证明未发送才 not_delivered；其余 ambiguous。本地 intent 不是服务端接收证据。禁止自动重放 ambiguous，也禁止用 RESUME_PROMPT 绕开这个限制。
4. **延后消息只有一个持久队列。** 将现有 manager deferred-send 队列落入 LocalStore，由 WorkerManager 单一管理；Codex 不另建内存 after 队列。入库后才能返回 queued。持久化排队、发送中、接收证据、不确定和返还状态；中断、stop、broken 与恢复共用这些记录。ambiguous 项阻止同 worker 的 FIFO 后续项越过它。共享路径修改需补 Pi/Claude 回归。
5. **占用与生命周期。** 按真实 Codex thread 身份、已记录进程身份和原生冲突结果检查占用；app-server argv 未出现 thread ID 不代表无人占用。只清理 Orbit 确认拥有的进程。保留现有锁、cwd、权限、恢复次数上限及模型设置。

需要覆盖：首 prompt 前后崩溃、通知早于 RPC 回应、工作已结束但回执未持久化、有 ID 无 path、队列发送后未记录接收、中断与自然完成竞态。无法确定时显式等待处理，不新建会话从头执行。

### 阶段 D：权限、历史和工作台

- readonly 使用明确的只读 sandbox；write 使用分配 worktree 的 workspace-write 策略，核查额外 writable roots，不笼统声称任何配置下都绝对隔离。
- 非交互审批采用明确策略；仍收到批准请求时拒绝该动作并返回可理解的 blocked/error，不能挂着等用户在不可见终端回答，也不能自动升权。
- 首次启动与恢复都落实同一策略。检查继承的 MCP/外部工具对只读承诺的影响；不可保证时不宣称 readonly=true。保留本机项目信任和现有 PR 同意机制。
- 从已登记 worker 的真实身份定位记录；验证 path 属于该会话，不接受云端任意路径。path 不可用、文件缺失或机器离线时明确报错。
- 复用完整 JSONL 分片传输，增加 Codex 用户/助手/工具/错误/压缩记录的 UI 规范化；避免将语义相同的多种底层记录重复渲染。未知记录保留 raw。
- 原始记录留在本机，云端仅按需转发，不新增会话归档副本。会话页 send/interrupt 沿用 ADR-0011 的既有鉴权入口。

### 阶段 E：文档、打包、验证

新增 ADR 明确修订 ADR-0001 “Codex stays out”，更新 agent-connect、connector 设计和使用说明，写清安装登录、支持版本、调用方式、能力及恢复边界。新增引用的 TS 会自动进入现有 CLI bundle；仅在确需运行时资源时改 build.mjs，不无故新增 SDK 依赖。

## 6. 测试与完成标准

沿用现有 claude-adapter、claude-manager、crash-recovery、full-session-history，以及 steward dispatch/handoff/history-relay/ui-session 测试模式；新增 fake Codex app-server 与针对性 fixtures。

| 检查 | 必须覆盖 |
|---|---|
| 协议 | 握手/超时/分片 JSON、server request、乱序和重复通知、退出清理 |
| 结果 | 合法报告、无效报告、认证与暂态错误、取消、usage 缺失、每轮只结算一次 |
| 控制 | steer turn 校验、interrupt 完成竞态、after 队列持久化及返还 |
| 恢复 | 各发送/落库窗口故障注入；不确定不重放；身份、模型、权限与目录保持 |
| 历史 | 长行/分页/游标、文件替换或缺失、未知记录、Codex 显示及旧格式回归 |
| 集成 | hello → 指定 codex → 执行/报告 → 会话页控制 → 重启续接；Pi→Codex 接力正确开新会话 |

先运行有针对性的测试，再运行完整检查。实际命令以仓库 scripts 为准：

```bash
pnpm --dir apps/connector typecheck
```

```bash
pnpm --dir apps/connector test
```

```bash
pnpm typecheck
```

```bash
pnpm test
```

Connector test 含 pretest 构建。若改了 steward prompt、模型、工具定义或 findCandidates，另按项目要求执行 routing eval。

真实烟测使用专门测试仓库，包含只读与 worktree 写入、报告、steer/interrupt、冷恢复和记录查看，不以 push/发布作为测试步骤。运行前记录 Codex 版本，完成后报告结果。

**交付时分别列出：实现内容、已运行检查及结果、真实 Codex 验收、仍存在的限制。** 如果真实环境不具备，只能报告“实现及模拟验证完成，真实验收未完成”；不能把 mock 通过写成真实可用。不要为了通过检查改掉用户已有的无关变更。

## 7. 交接给 Codex 的任务提示

> 请按 `docs/plans/codex-cli-integration.md` 为 Orbit 实现 Codex CLI 支持。使用 `codex app-server`，接入现有 AgentAdapter/Connector；不要做桌面自动化。先核对当前工作区和相关指令，保留已有改动，然后按阶段实施并验证，重点完成命令交付证据、重启恢复和延后消息持久化。缺少真实 CLI 或登录时可继续实现与 fake 测试，明确报告真实验收缺口；需要用户登录时说明。未经另行授权不要提交、推送或部署。最终汇报改动、测试结果、真实烟测和限制。

## 8. 参考

- 官方 App Server 指南：https://developers.openai.com/codex/app-server
- 研究时的稳定发布：https://github.com/openai/codex/releases/tag/rust-v0.167.0
- 对应协议定义：https://github.com/openai/codex/tree/rust-v0.167.0/codex-rs/app-server-protocol/schema/typescript/v2
