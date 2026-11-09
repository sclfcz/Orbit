# Codex CLI 接入：剩余工作交接清单

状态：A、B、C、G 已完成；PR [sclfcz/Orbit#1](https://github.com/sclfcz/Orbit/pull/1) 已由 owner 合并到 main（合并提交 `50588c2`，2026-11-07），main 的 CI 通过。D 已于 2026-11-08 在 staging 验收通过（分支 `feat/codex-staging-acceptance`，只改文档），staging Worker 已于同日删除。E 已于 2026-11-08 完成：npm 发布 `@sclfcz/orbit@0.2.0`，正式 Worker 部署 `v0.2.0`，本机 Connector 升级后 `orbit doctor` 显示 Codex 可用。F（图片输入）v1 已于 2026-11-09 随 0.4.0 上线（仅 Pi），Codex 和 Claude Code 的图片输入随 0.5.0 上线。本文是交给 Codex 的任务说明。每个计划独立交付，完成后由审查方核对 diff、测试输出和证据，再决定下一个。

发布记录：0.5.0 于 2026-11-09 发布，Codex 和 Claude Code worker 也能接收图片（ADR-0014 第 6、7 阶段，PR #21–#23）。发布前的真实验收：`codex-cli 0.167.0` 读出图片里的随机文字，turn 结束后临时文件已删除；Claude Code 2.0.31 首次运行和 `--resume` 续跑都读出了各自图片里的随机文字。正式 Worker 从 `v0.5.0` 部署，`/app` 200、`/api/messages` 401；本机 Connector 升级到 0.5.0，`orbit doctor` 的 pi 和 Codex 检查都正常。

0.4.0 于 2026-11-09 发布，新增图片输入 v1（issue #13，ADR-0014，PR #14–#18）：会话视图直接发送和回复 worker 提问时可附带图片，仅支持 Pi；connector 按引用拉取并校验字节；当前 Pi 模型不支持图片时在发送 prompt 前拒绝；附件按 24 小时 / 7 天 / 30 天规则清理。发布前的真实验收：视觉模型读出了图片里的随机文字，纯文本模型在 prompt 发出前被拒绝为 `model_no_image_input`。正式 Worker 从 `v0.4.0` 部署，`/app` 200、`/api/messages` 401；本机 Connector 升级到 0.4.0，`orbit doctor` 的 pi 和 Codex 检查都正常。

0.3.0 已于 2026-11-08 发布并上线，新增移除已登记目录（issue #7，PR #8）。这是第一次通过 npm Trusted Publishing 发布，附带 provenance，Trusted Publisher 配置因此完成验证。正式 Worker 从 `v0.3.0` 部署，secret 名称前后一致，`/app` 200、`/api/messages` 401；本机 Connector 升级到 0.3.0，`orbit doctor` 的 pi 和 Codex 检查都正常。正式环境验收通过：移除已登记目录后，Machines 页面不再显示该目录，磁盘文件保留，再向该目录派发任务会被拒绝；目录上有 worker 运行时，移除会被拒绝，worker 结算后可以移除。验收中有一个长任务因机器合盖睡眠而失联，触发了现有的卡死保护，与本次功能无关。

已在 main：Codex worker 实现、冷接续修复、独立 CLI 0.167.0 验收、干净 home 只读模型验收、`orbit doctor` 的 Codex 诊断、管理路径下的干净 home 只读验收。记录见 [codex-cli-validation.md](../codex-cli-validation.md)。`feat/codex-cli-workers`、`feat/codex-doctor`、`feat/codex-manager-readonly` 已删除，后续工作不要再用这些分支名。

## 建议顺序

| 顺序 | 计划 | 状态 | 授权门 |
| --- | --- | --- | --- |
| 1 | A. `orbit doctor` 的 Codex 诊断 | 已完成，在 main | — |
| 2 | B. Connector 管理路径下的干净 home 只读验收 | 已完成，在 main | — |
| 3 | C. 提 PR、跑 CI、整理合并前审查 | 已完成，PR #1 已合并 | — |
| 4 | D. 部署环境（独立 staging Worker）验收 | 已完成；staging Worker 已删除 | — |
| 5 | E. 版本号、发 npm、部署正式环境 | 已完成（2026-11-08） | — |
| 6 | F. 图片输入 | 已完成：Pi（0.4.0），Codex、Claude Code（0.5.0） | — |
| 收尾 | G. 本地清理 | 已完成（干净只读 `CODEX_HOME` 保留） | — |

E 的发布和部署依赖 D 通过，尤其是 D 第 6 步的新旧版本兼容性结论。

### A、B 并行时的分支规则（历史记录，已完成）

两个任务都从 `feat/codex-cli-workers` 的最新提交各开一个分支，互不推送对方的分支：

- A：`feat/codex-doctor`
- B：`feat/codex-manager-readonly`

文件归属如下，避免冲突：

| 文件 | A | B |
| --- | --- | --- |
| `apps/connector/src/cli.ts`、`service.ts`、`codex-adapter.ts` | 可改 | 不改 |
| `apps/connector/test/bin.test.ts`、`service.test.ts`、`proxy.test.ts`、`codex-adapter.test.ts` | 可改 | 不改 |
| `apps/connector/test/codex-connector-live.test.ts`、`codex-live.test.ts`、新的共享 live helper | 不改 | 可改 |
| `docs/codex-cli.md` | 只改 “Local setup” 一节 | 只改 “Clean readonly acceptance” 一节 |
| `docs/codex-cli-validation.md` | 不改 | 可改 |
| `apps/connector/README.md` | 可改 | 不改 |

如果某个任务发现必须改归另一方的文件，停下来报告，不要自己改。两个分支都审查通过后，由审查方依次合入 `feat/codex-cli-workers`，然后重跑一次完整 Connector 测试。

## 所有计划共用的约束

违反任何一条都视为未完成，即使测试全绿。

- 不开启 `danger-full-access`，不修改用户全局 Codex 配置（默认 `CODEX_HOME` 下的 `config.toml`），不复制、链接或打印认证文件。
- 不放宽只读预检、写入策略、进程身份校验、交付不确定时禁止重放等保护。若测试只有放宽保护才能通过，停下来报告。
- 不打印、不提交任何密钥或密码（`LOGIN_PASSWORD`、`SERVER_KEY`、`NPM_TOKEN`、模型 key、配对码）。
- 公开文档只写汇总结果和可复现的测试名，不写本机绝对路径、机器 ID、会话 ID、thread ID、设备 ID。原始证据放 `/tmp` 下，不入库。
- 不杀与 Orbit 无关的进程（包括 Codex 桌面版及其 app-server）。只能停止本次测试自己启动、且身份可校验的进程。
- 未经 owner 明确授权，不合并 main、不打 `v*` tag（会触发 `release.yml` 自动 `npm publish`）、不 `npm publish`、不部署、不改 Cloudflare 或 GitHub 设置、不改计费。
- 只推送到本计划指定的分支（D 用 `feat/codex-staging-acceptance`，E 的版本号提交用 owner 指定的分支），不直接推 main，不 force push。
- 使用 `package.json` 里 `packageManager` 固定的 pnpm 版本；本地版本不符时先 `corepack enable`。不要回退 `packageManager` 字段。
- 模拟测试和真实 CLI 验收分开报告。失败、跳过、重跑都要如实写出，不能把早期失败改写成通过。

## 每个计划交回审查时必须提供

1. 提交 SHA 列表和每个提交的一句话说明。
2. 每条验证命令的原样输出摘要：通过、失败、跳过的数量和耗时。
3. 真实验收的证据文件路径（`/tmp/...`，不入库）。
4. 未完成或未验证的项目，以及原因。
5. 是否改动了任何保护逻辑；如有，说明改了哪行、为什么不会削弱保护。

---

## A. `orbit doctor` 的 Codex 诊断

### 目标

owner 能在一条命令里看到：Connector 后台服务能不能找到 `codex`，版本是否在兼容范围，以及找不到时该怎么修。现在后台服务的 PATH 在 `orbit connect` 安装时就固定下来（`apps/connector/src/cli.ts` 中 `PATH: process.env.PATH ?? DEFAULT_PATH`，写入 launchd plist 的 `EnvironmentVariables` 或 systemd 的 `Environment=`）。之后安装的 CLI，交互 shell 能找到，服务却可能找不到。

### 改动范围

- `apps/connector/src/cli.ts`：`doctorCommand()`，以及需要时的 `statusCommand`。
- `apps/connector/src/service.ts`：如需从已安装的 unit/plist 读取服务的 PATH，在这里加只读方法。
- `apps/connector/src/codex-adapter.ts`：只复用 `detectCodex()`，需要时给它加一个可选的 env/PATH 参数。不改版本门槛和其他行为。
- 测试：`apps/connector/test/` 下覆盖 CLI 的 `bin.test.ts`、`service.test.ts`、`proxy.test.ts`（doctor 目前在这里有覆盖，先确认），以及 `codex-adapter.test.ts`。
- 文档：`docs/codex-cli.md` 的 Local setup 段，`apps/connector/README.md` 中英两段（如有 doctor 输出示例）。

### 步骤

1. 先读 `doctorCommand()` 和 `service.ts`，确认已安装服务的 PATH 能否只读地取到（launchd plist、systemd unit 文件）。取不到时，只报告当前 shell 的结果，并写明“服务 PATH 未知”。
2. doctor 新增两行，格式与现有行对齐：
   - `codex (this shell):` 显示解析到的版本，或 `not found`，或版本不兼容的诊断。
   - `codex (service PATH):` 用服务 PATH 运行同样的检测。
3. 检测只运行 `codex --version`，沿用 5 秒超时。不运行模型任务。不要求登录。`codex login status` 可选；若加入，只显示“已登录/未登录”，不显示账号信息。
4. Codex 是可选 agent：找不到或版本不兼容时不把 `healthy` 置为 false，不改变 doctor 的退出码。
5. shell 能找到、服务找不到时，给出明确的修复步骤。先在代码里确认 `orbit restart` 是否会重新捕获 PATH。如果不会，提示正确做法（例如在已安装 CLI 的 shell 中重新运行安装/升级命令），不要写一个不起作用的建议。
6. 不显示 `codex` 的绝对路径以外的环境信息；不打印整个 PATH（可能含私人目录），只说明“服务 PATH 中未找到”。

### 测试

- 用 `test/fake-codex.mjs` 的 `--fake-version=` 覆盖：兼容版本、不兼容版本、不存在、超时。
- 覆盖“shell 找到、服务 PATH 找不到”时的提示文本。
- 覆盖 Codex 缺失时 doctor 的退出码不变。

### 验证命令

```bash
pnpm --dir apps/connector exec vitest run test/codex-adapter.test.ts
pnpm --dir apps/connector test
pnpm --dir apps/connector typecheck
git diff --check
```

另外在本机手动运行一次构建后的 `node apps/connector/bin/orbit.js doctor`，贴出 Codex 相关两行（去掉路径和设备 ID）。

### 完成标准

- 上述命令全部通过，Connector 全量测试数量不少于当前的 474 个通过。
- doctor 的退出码规则对非 Codex 项不变。
- 文档说明了服务 PATH 固定的原因和修复方式。

---

## B. Connector 管理路径下的干净 home 只读验收

### 目标

现有干净 home 只读验收直接调用 `CodexAdapter`。本计划补上经过真实 Connector 子进程、`WorkerManager`、WebSocket 派发的只读任务，证明整条管理路径在干净 home 中能完成只读模型执行，同时默认 home 仍然安全拒绝。

### 前置

- owner 已按 [codex-cli.md 的 Clean readonly acceptance](../codex-cli.md#clean-readonly-acceptance) 建好并用 `codex login` 登录了干净 home。Codex 不得自己创建认证或复制认证文件。如果没有可用的干净 home，停下来告诉 owner。
- 独立安装的 `codex-cli 0.167.0` 在 PATH 上。

### 改动范围

- `apps/connector/test/codex-connector-live.test.ts`：新增一个 opt-in 用例。
- 只在测试需要时，给 Connector 子进程传 `CODEX_HOME`；生产代码不新增配置项。若发现生产代码必须改，先停下来报告方案。
- `docs/codex-cli.md`、`docs/codex-cli-validation.md`：记录结果。

### 步骤

1. 新用例同时要求 `ORBIT_CODEX_LIVE=1` 和 `ORBIT_CODEX_READONLY_HOME`，否则跳过。
2. 启动真实 Connector 子进程，使用隔离的 `SIG_HOME`，环境变量 `CODEX_HOME` 指向干净 home。Steward 端沿用该文件现有的 mock WebSocket 服务器。
3. 在临时 Git 仓库写一个随机标记文件。通过 WebSocket 派发 `agent: "codex"`、`mode: "readonly"` 的任务。提示词要求执行一次 `cat <输入文件>; printf ... > <输出文件>`，并且不在提示词里透露标记内容。
4. 断言全部满足才通过：
   - 收到结构化报告，`status` 为 `done`，内容包含随机标记。
   - 输入文件内容不变，输出文件不存在，原仓库工作区干净。
   - 从该 worker 的原生 rollout 中按 `call_id` 找到这次 shell 调用及其输出：输出包含标记、权限拒绝信息（`operation not permitted|permission denied|read-only file system`）和非零退出码。可复用 `codex-live.test.ts` 中现有的相关逻辑，复用时抽出共享 helper，不要复制粘贴。
   - 预检拒绝、模型自述“被拒绝”、仅输出文件不存在，都不能让测试通过。
5. 再加一个对照断言或保留现有用例：同一 Connector 用默认 home 派发只读任务时，返回 `unsupported_capability`，且没有任何输入送达模型。
6. 测试结束时只停止自己启动的 Connector 和 app-server。

### 验证命令

```bash
ORBIT_CODEX_LIVE=1 ORBIT_CODEX_READONLY_HOME=/absolute/path/to/clean-codex-home pnpm --dir apps/connector exec vitest run test/codex-connector-live.test.ts --no-file-parallelism
pnpm --dir apps/connector test
pnpm --dir apps/connector typecheck
```

默认 `pnpm --dir apps/connector test` 中新用例必须显示为 skipped。

### 完成标准

- 真实运行通过，证据 JSON 写到 `/tmp/orbit-codex-connector-clean-readonly.json`。
- 默认套件不因缺少环境变量而失败。
- 没有修改只读预检逻辑。
- 验证记录新增一行结果；“Remaining boundaries”中“管理路径未验证”的说法相应更新。

---

## C. 提 PR、跑 CI、合并前审查

### 授权门

开 PR 是对外可见的操作。owner 说“可以开 PR”之后才执行步骤 3。

### 步骤

1. 确认 A、B 已推送，`git status` 干净（`.claude/` 不提交）。
2. 本地完整跑一遍 CI 等价命令，注意 CI 用 Node 22，本地是 Node 26。如果本机有 Node 22（例如通过 `corepack`/`fnm`/`nvm`），再用 Node 22 跑一遍 Connector 测试，因为 `node:sqlite` 等行为可能有版本差异。

   ```bash
   pnpm install --frozen-lockfile
   pnpm -r typecheck
   pnpm -r test
   cd apps/connector && npm pack --dry-run
   ```

   `npm pack --dry-run` 的产物必须仍包含 `dist/cli.js`、`dist/ext/sig-pi.ts`、`bin/orbit.js`，且没有运行时依赖（见 `.github/workflows/ci.yml` 的 tarball 检查）。
3. 用 `gh pr create --repo sclfcz/Orbit --base main --head feat/codex-cli-workers` 开 PR。描述包含：
   - 功能概述和 ADR-0013 链接。
   - 验证记录的链接，以及默认套件与 opt-in 真实验收的区别。
   - 已知边界：版本门槛只覆盖 0.166/0.167 系列、默认 home 下只读会被拒绝、图片不支持、未在部署环境验收。
   - 不写本机路径和 ID。
4. 等 CI 结果。不要轮询或写定时任务；用 `gh pr checks` 查看一次结果即可，失败时读日志定位。
5. CI 失败时：修复后推送到同一分支。若失败是负载敏感的心跳/看门狗测试，先在本地隔离复现，不要加重试或放宽超时来掩盖，除非能证明是测试本身的时序假设错误，并在提交说明里写明。
6. 检查与 main 的冲突。main 有新提交时用 merge 同步（不要 rebase 已推送的分支），解决冲突后重跑步骤 2。

### 完成标准

- PR 已开，CI 全绿。
- 交回审查的材料包括：PR 链接、CI 运行链接、本地 Node 22/26 两次运行的结果。
- 不合并。合并属于计划 E。

---

## D. 部署环境验收（独立 staging Worker）

### 目标

在真实 Cloudflare 部署上验证 Codex worker 的端到端流程，并顺带完成 0.167.0 下的浏览器验收（之前的浏览器验收用的是桌面自带 0.166 alpha）。使用独立的 staging Worker，不碰 owner 已有的正式部署。

### 授权门（全部由 owner 亲自操作或明确同意）

- 部署功能分支代码到一个新的 Worker 名，例如 `orbit-codex-staging-<4 位 hex>`。部署前确认这个名字在 owner 账号下不存在，避免覆盖。
- `npx wrangler login` 由 owner 点击授权。
- `LOGIN_PASSWORD` 由 owner 在自己的终端或 Cloudflare 控制台设置，不经过 agent。
- 模型 key 由 owner 在 workspace 的 Settings 页面填写。
- 可能产生的 Cloudflare 或模型费用由 owner 确认。
- 验收结束后是否删除 staging Worker 由 owner 决定。删除 Worker 会销毁它的数据。

### 本机现状（2026-11-07 审查方核对）

- `wrangler whoami` 已登录，令牌有 `workers_scripts (write)`。正式 Worker `orbit-steward` 已存在，最后部署于 2026-11-06。**D 全程不得对 `orbit-steward` 执行 deploy、secret 或 delete。**
- 本机 `codex` 是 `0.167.0`，默认 `CODEX_HOME` 的模型走 `opencode-go` 提供方，不消耗 ChatGPT 额度，所以第 5 步的写任务、steer、中断、接续可以现在做。默认 home 下的只读任务会在模型输入前被拒绝，也不需要额度。干净只读 home 的 ChatGPT 额度到 2026-11-09 10:08 才恢复，D 不需要用它。
- 没有设置代理变量，`workers.dev` 可以访问。
- npm 上的最新版仍是 `@sclfcz/orbit@0.1.3`（不含 Codex），用作第 6 步的旧 Connector。

### 步骤

按 [agent-deploy.md](../agent-deploy.md) 的纪律执行。工作分支是 `feat/codex-staging-acceptance`（从 main `50588c2` 开出）。

1. 选一个新名字 `orbit-codex-staging-<4 位 hex>`，先用 `pnpm --dir apps/steward exec wrangler deployments list --name <staging-name>` 确认它不存在。**先部署旧版本**以便做第 6 步的“新 Connector 连旧 Steward”：在一个临时 worktree（`git worktree add /tmp/orbit-staging-old 69c1f96`，即合并前的 main）里 `pnpm install && npm run deploy -- --name <staging-name>`，记录 wrangler 打印的 URL。部署前把名字报给 owner 确认。
2. 用 agent-deploy.md 第 3 步的 curl 检查未登录状态：`/app` 返回 200，`/api/messages` 返回 401。
3. owner 设置 `LOGIN_PASSWORD`、登录、填模型 key。之后先做第 6 步的“新 Connector 连旧 Steward”，再在当前分支 checkout 上 `npm run deploy -- --name <staging-name>` 部署新版本，重新做第 2 步的 curl。然后在 Machines 页面生成一次性配对命令。
4. 在本机用隔离状态运行前台 Connector，不安装后台服务、不改现有 `~/.sig`：

   ```bash
   SIG_HOME="$(mktemp -d /tmp/orbit-staging-sig.XXXXXX)" node apps/connector/bin/orbit.js connect <staging-url> <code> --foreground
   ```

   确认 Machines 页面显示该机器在线，并广播了 `codex` 及版本 0.167.0。
5. 注册一个专用临时 Git 仓库，逐项验收：
   - 明确要求用 Codex 的写任务：在隔离 worktree 写入指定内容，返回结构化报告，原 checkout 不变。
   - 运行中 steer、运行中 interrupt（用一个长时间运行的 shell，确认中断后迟到的写入没有发生）。
   - 中断后对同一 worker 的冷接续：thread ID 不变，产生新报告。
   - 会话记录在 workspace 中可查看，条目数随新轮次增加。
   - Connector 重启（Ctrl-C 后用同一 `SIG_HOME` 重新前台启动）后，worker 状态、历史仍可用，且没有重放。
   - 断网重连：短暂断开网络或代理后恢复，确认重新连上，未完成的命令没有重复执行。
   - 默认 home 下的只读任务被明确拒绝，UI 显示的原因可理解。
6. 版本兼容性检查（重要，影响发布顺序）：
   - 新 Connector 连旧 Steward：在第 3 步部署新版本**之前**，用当前分支构建的 Connector（`pnpm --dir apps/connector build` 后用 `node apps/connector/bin/orbit.js`，独立 `SIG_HOME`）配对旧版本 staging，确认旧 Steward 不会因为未知 agent `codex` 拒绝 hello 或报错，并且 Pi 任务正常。不要连 owner 的正式部署。
   - 新 Steward 连旧 Connector：新版本部署后，用 `npx -y @sclfcz/orbit@0.1.3 connect <staging-url> <code> --foreground`（另一个独立 `SIG_HOME`）配对，确认 Pi 正常、Codex 不可选且不报错。
   - 这两项决定 E 中“先部署还是先发 npm”。
7. 证据：截图、Connector 日志摘要、SQLite worker 状态摘要放到 `/tmp/orbit-staging-evidence-<date>/`。截图如需分析，先用 `describe_image` 转成文字描述。
8. 验收结束后停止所有前台 Connector，删除 `/tmp/orbit-staging-old` worktree。在 staging 的 Machines 页面移除这些机器。是否删除 staging Worker 问 owner。
9. 文档改动提交并推送到 `feat/codex-staging-acceptance`，不开 PR、不合并。

### 完成标准

- 第 5、6 步每一项都有“通过/失败/未做”和证据位置。
- `docs/codex-cli-validation.md` 新增“Deployed staging acceptance”一节，只写汇总，不写 URL、Worker 名、设备 ID。
- “Remaining boundaries”中“No deployed cloud environment was tested”相应更新。

---

## E. 合并 main、发布 npm、部署正式环境

已于 2026-11-08 完成，每一步都经 owner 单独授权：

- 版本号经 PR #2 合入 main（`adc7f43`），`v0.2.0` tag 指向该提交。
- `release.yml` 的发布前两次失败：第一次 `NPM_TOKEN` 为空值（`ENEEDAUTH`），第二次 token 未开启绕过 2FA（`EOTP`）。两次都没有向 npm 上传内容。换成限定 `@sclfcz/orbit`、绕过 2FA、30 天有效的 granular token 后，第三次重跑成功，`0.2.0` 成为 `latest`。
- 正式 Worker 部署 `v0.2.0`。secret 名称前后一致（只有 `LOGIN_PASSWORD`，内部 key 由 Durable Object 自动生成），`/app` 200、`/api/messages` 401，已配对机器保持在线。
- 本机 Connector 用 `orbit upgrade --version 0.2.0` 从 npx 0.1.3 升级为全局安装。`orbit doctor` 的两行 Codex 检查都是 `codex-cli 0.167.0`，Machines 页面的 Agents 显示 `pi, claude-code, codex`。
- 之后的版本改用 npm Trusted Publishing（PR #3），不再需要 `NPM_TOKEN`。0.3.0 是第一次通过它发布，配置已完成验证。

以下是原始步骤，保留作记录。只有 owner 对每一步分别明确授权后才能执行。

### 步骤

1. **合并**（授权点 1）：已完成。owner 于 2026-11-07 用 merge commit 合并 PR #1（`50588c2`），早于 D；因此 main 已包含 Codex 功能，但尚未发布、尚未部署。
2. **版本号**：在分支 `release/v0.2.0` 上提交，经 PR 合入 main。`apps/connector/package.json` 的 `version` 从 `0.1.3` 改为 `0.2.0`（owner 2026-11-08 同意开始 E）。`VERSION` 从 `package.json` 读取；Codex app-server 握手里原先写死的 `0.1.3` 也改为读取 `VERSION`。README 和 `docs/agent-connect.md` 中没有写死的版本号。
3. **发布 npm**（授权点 2）：发布方式是推送 `v<version>` tag，它会触发 `.github/workflows/release.yml`，用仓库 secret `NPM_TOKEN` 执行 `npm publish --access public`。推 tag 前确认：
   - `gh secret list --repo sclfcz/Orbit` 中存在 `NPM_TOKEN`（只看名字，不读值）。
   - tag 指向的提交就是第 2 步的版本号提交。
   - 推送后用 `gh run list --workflow release.yml` 查看一次结果，不轮询。
   - 0.2.0 之后的版本：`release.yml` 改用 npm Trusted Publishing（GitHub Actions OIDC），不再读取 `NPM_TOKEN`。登记参数：`sclfcz` / `Orbit` / `release.yml`，无 environment，允许 `npm publish`。npm 规定新登记的配置必须在 2 天内完成第一次成功发布，否则过期，且不能编辑，只能删除重建。owner 于 2026-11-08 登记过一次，状态为 Pending validation；owner 决定不为验证单独发版，这条配置会在 2026-11-10 过期。下次发版按以下顺序：
     1. 推 tag 前，先在 npmjs.com 的 `@sclfcz/orbit` → Settings → Trusted Publisher 查看状态。如果显示过期或仍是 Pending validation，删除旧配置，用上面相同的参数重新登记。
     2. 登记后 2 天内推 `v*` tag，完成第一次发布；这次发布同时完成验证。
     3. 第一次通过 OIDC 发布成功后，再删除 repo secret `NPM_TOKEN` 和 npm token `orbit-release-ci-v2`。
   - 发布后用 `npm view @sclfcz/orbit version` 确认。
4. **部署正式环境**（授权点 3）：按 D 第 6 步的兼容性结论决定先后顺序。部署使用 owner 现有正式部署的 Worker 名，不新建；保留 `SERVER_KEY` 和 `SERVER_KEY_PREVIOUS`，不重设密码。部署后做 agent-deploy.md 第 3 步的 curl 检查。
5. **机器升级**：owner 在各机器上运行 `orbit upgrade`。如果 A 的结论是服务 PATH 不会自动更新，提醒 owner 按 A 写好的修复步骤处理，然后用 `orbit doctor` 确认 Codex 两行都正常。

### 完成标准

- main 包含功能、npm 上是新版本、正式部署在线、至少一台机器升级后 `orbit doctor` 显示可用的 Codex。
- 任何一步失败都停下来报告，不自行回滚或重试发布。npm 已发布的版本不能覆盖，只能发新版本。

---

## F. 图片输入（已完成，0.4.0 和 0.5.0 上线）

owner 选了端到端方案，按 ADR-0014 和 issue #13 分阶段实施：ADR（PR #14）、Steward 存储与 API（PR #15）、Web 输入框与历史（PR #16）、Connector 拉取与 Pi 接入（PR #17）、保留期清理（PR #18），这部分随 0.4.0 上线，只支持 Pi。

随后的 0.5.0 加上了另外两个 agent：

- **按 agent 判断能力（PR #21）：** Connector 对每个 `capabilities.images` 为 true 的适配器声明 `imageInput`，Steward 按 worker 自己的 agent 判断能否附图。
- **Codex（PR #22，ADR-0014 第 6 阶段）：** 校验过的附件写进 Connector 状态目录下的私有子目录，以 `localImage` 发给 app-server；turn 结束、中断、停止、崩溃都会删除，启动时清理残留。
- **Claude Code（PR #23，第 7 阶段）：** 只有带图片的 run 改用 `--input-format stream-json`，纯文本 run 不变。

和 Pi 不同，Codex 和 Claude 不会在发送前检查模型是否支持图片；配了纯文本模型时，失败会出现在模型回复里。

下面的“现状”和“方案 1 清单”是做决定前的记录，已全部过时，仅作历史保留。

### 决定前的现状（历史记录）

- `CodexAdapter.start()` 收到图片时抛出 `unsupported_capability`，能力声明 `images: false`。
- Connector 内部类型（`agent.ts`、`worker-manager.ts`、`store.ts` 的 deferred 队列）已有 `images` 字段，`WorkerManager` 在入口处检查单张 4 MB base64 上限。
- 协议包 `packages/protocol` 和 Steward 都没有把图片发给 Connector 的路径。Pi 声明了 `images: true`，但目前也收不到 Web 端的图片。
- Codex 0.167.0 的 app-server 协议有两种图片输入：`{ type: "image", url, detail? }` 和 `{ type: "localImage", path, detail? }`。桌面自带的 0.166.0-alpha.6 是否同样支持尚未核实。

### 第 0 步：owner 决定（已选方案 2）

- **方案 1：只做 Connector 适配层。** 范围小，但在 Steward 支持之前，用户用不到这个功能。
- **方案 2：端到端。** 包括 Web 上传、Steward 存储与转发、协议字段、Connector、Codex。这是一个独立的产品功能，应该另开 issue 和 ADR，不放在本分支里。

建议：本分支保持“图片不支持”，另开 issue 走方案 2。

### 若选方案 1，交给 Codex 的清单

1. 分别用 0.166.0-alpha.6 和 0.167.0 的 `codex app-server generate-json-schema` 确认 `image`/`localImage` 的字段。两个版本不一致时，只对确认支持的版本开启图片能力；能力要按检测到的版本声明。
2. 选择传递方式。优先 `localImage`：把 base64 解码写入该 worker 状态目录下的私有临时文件（权限 0600），轮次结束后删除。校验 mimeType 在白名单内（png/jpeg/webp/gif），并检查文件头与声明类型一致。不要把图片写进仓库 worktree。
3. `start()`、`send()`、steer、after 队列四条路径都要支持；deferred 队列重启后重放图片时，临时文件要能重新生成。
4. 交付不确定时禁止重放的规则不变：图片和文本属于同一个交付意图。
5. 测试：fake app-server 收到正确的输入结构；超过大小上限、mime 不符时拒绝；临时文件在成功、失败、中断后都被清理。
6. 真实验收：用一张内含随机文字的小图，要求模型读出文字，验证报告包含该文字。
7. 更新能力声明、`docs/codex-cli.md`、ADR-0013。

---

## G. 本地清理（审查方执行，需 owner 同意）

这些是之前验收留下的本机状态，不交给 Codex：

- 本地 Steward 预览服务 `orbit-acceptance`（端口 8787，持久化目录在 `/tmp` 下）。之前尝试停止时被权限拒绝，需要 owner 同意后停止。
- `.claude/launch.json`：未跟踪，只用于本地预览。可以保留并加入本地忽略，也可以删除。
- `/tmp` 和系统临时目录下的验收目录（浏览器验收、只读验收、证据目录、协议 schema 导出）。删除前先列出清单给 owner 确认。
- 干净的只读 `CODEX_HOME` 是 owner 登录过的目录，是否保留由 owner 决定。B 和以后的复验需要它。

---

## 交给 Codex 的提示词模板

A、B、C 的提示词已用完，对应分支已删除。计划 D 用下面这段：

```text
你在 sclfcz/Orbit 仓库工作。先 git fetch，切到 feat/codex-staging-acceptance（若本地没有，从 origin/main 新建同名分支）。请完整阅读 docs/plans/codex-remaining-work.md 中“所有计划共用的约束”“每个计划交回审查时必须提供”和“D. 部署环境验收”三节，然后只实施计划 D。
绝不对正式 Worker orbit-steward 执行 deploy、secret put、delete 或任何修改。staging 名字部署前先报给 owner 确认。
LOGIN_PASSWORD 和模型 key 由 owner 自己输入，不要索取、不要经过你的工具；需要 owner 操作时停下来说明具体要做什么。
配对码只用一次，不要写进日志或文档。Connector 一律前台运行并使用独立的 SIG_HOME，不安装后台服务，不碰 ~/.sig。
测试只有放宽保护才能通过时，停下来报告，不要修改保护逻辑。
完成后只推送 feat/codex-staging-acceptance（不要 force push，不要开 PR，不要合并 main，不要打 tag），并按“交回审查”一节给出材料。不要删除 staging Worker。
```
