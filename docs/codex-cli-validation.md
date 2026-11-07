# Codex CLI implementation validation — 2026-11-07

Overall: **package regressions and the local browser workflow pass; real acceptance remains conditional**. Real-CLI evidence covers worktree writes, structured reports, steer, interruption with shell cleanup, local history, Connector restart, and uncertain-crash no-replay recovery. Successful manager-level cold continuation alongside unrelated Codex processes and a clean readonly model turn remain unverified.

This public record contains aggregate results and reproducible test names. Raw session records, machine identifiers, local paths, credentials and detailed process evidence remain local. The owner authorized committing and pushing verified source to a feature branch; deployment and merging main are outside this task.

## Final checks

| Check | Result |
| --- | --- |
| `pnpm --dir apps/connector test`, including build | **468 passed, 7 skipped**; 47 files passed, 3 skipped; 34.63 s |
| `pnpm --dir apps/steward test` | **668 passed**, including 12 generated-auth tests |
| `pnpm --dir packages/protocol test` | **61 passed** |
| `pnpm --dir apps/preview-machine test` | **7 passed** |
| Complete real adapter acceptance, `test/codex-live.test.ts` | **5 passed**, 60.26 s |
| Real Connector restart/recovery, `test/codex-connector-live.test.ts` | **1 passed**, 47.94 s; cold continuation safely refused |
| Rebuilt local browser dispatch, same-turn steer, interruption and history | Passed; no late shell write after its original deadline |
| `pnpm typecheck` | All workspace packages passed after runtime fixes |
| Connector typecheck after the final test-only update | Passed |
| `git diff --check` | Passed |

Package suites were run separately, not relabelled as a recursive test run. They total **1,204 passing tests**, excluding opt-in real checks and overlapping focused runs. Steward/protocol/preview-machine ran earlier; their implementation did not change during the final Connector fault fixes. Live tests remain opt-in and are skipped in the default suite.

Toolchain: Node 26.0.0, pinned pnpm 10.33.0, macOS, desktop-bundled `codex-cli 0.166.0-alpha.6` with the existing login. Only test-process PATH was adjusted. No global Codex configuration, authentication files or unrelated desktop processes were changed. This does not certify every supported release or a clean independent CLI installation.

## Local browser acceptance

After explicit owner authorization, the real Machines UI created a one-time pairing command and paired a foreground Connector with isolated state. The browser registered a temporary Git repository, and the configured local Steward dispatched an explicitly requested Codex write task into an isolated worktree. No background service or cloud deployment was installed.

The first task returned a real structured report, wrote exactly the requested single-line acceptance marker plus its trailing newline, and left the original checkout unchanged. Agent sessions loaded the original session records. Direct continuation and steer were durably accepted, and the UI displayed both interruption status and native `turn_aborted` history.

That run exposed an actual cancellation defect: a native background shell wrote its finish marker **after** the model turn was interrupted. The adapter now retires the owned app-server and identity-checked descendants before emitting interrupted settlement. The strengthened live adapter test starts a real shell with a delayed write, steers, interrupts and waits beyond the original deadline; the finish file remains absent and the app-server is stopped.

The rebuilt application's final browser run used a new worker and a 90-second shell. After the real start marker appeared, browser controls immediately submitted steer and interrupt. Both receipts were delivered to the same turn. At 95 seconds after shell start, the finish marker remained absent, the owned app-server was gone, SQLite recorded `idle / aborted`, and the native record contained `turn_aborted`. The browser displayed `Up to date · 24 entries` and `Interrupted.`.

An earlier post-fix browser task finished naturally before the controls were exercised. It is not counted as cancellation evidence. The final run triggered browser actions from the observed shell start and waited beyond the original deadline.

Local acceptance does not certify a deployed cloud environment. Post-interrupt continuation is cold and remains subject to occupancy checks. Interrupting local execution cannot undo external side effects.

## Restart, history and uncertain delivery

The subprocess acceptance test uses actual separate Node ConnectorApp/LocalStore/CodexAdapter processes and real Codex. Only the Steward server is mocked. Business commands and history travel over real WebSocket frames; IPC is lifecycle-only.

Three distinct Connector processes and boot IDs reopened the same store. A real Codex task wrote the expected bytes in its assigned worktree, reported done and left the original checkout unchanged. Thread identity, worktree and last event sequence survived restart.

History was reconstructed solely through `history_chunk` / `history_ack`: **31 pages, 61 fragments, 36 split fragments**, with every offset/length checked and the reconstructed records equal to the original local file.

For the uncertain-crash case, a second task reached a real shell marker. The test suspended only its identity-checked owned app-server, then killed the Connector. This prevents the CLI's normal stdin-EOF handler from recording an abort. Production startup reaped the orphan and classified the untouched real record as `unknown / delivery_ambiguous`. Receipts remained unchanged, the marker executed once, no finish file appeared, send/resume were rejected, and the original command ID was deduplicated. A real post-recovery heartbeat allowed time to observe erroneous replay. No rollout or receipt was edited.

An earlier kill-only attempt produced a genuine aborted record and was not counted as unknown evidence. Cold continuation was actually attempted through the production manager but returned `session_in_use`: **persistence and safe refusal passed; successful continuation was not certified**. Adapter-level stop/resume with the same thread ID passed separately, without the manager's cross-process guard.

## Readonly boundary

The real app-server executed the same shell write under two explicit policies:

- `readOnly`, network disabled: exit code 1, `Operation not permitted`, no output file.
- `workspaceWrite`, restricted to the temporary repository, network and implicit temporary roots disabled: exit code 0 and exact expected bytes.

This proves native local command sandbox enforcement through standalone `command/exec`. It does not prove a readonly model turn or confinement of external integrations. This machine inherits desktop MCP/plugin configuration, which empty-table overrides did not remove. Readonly preflight correctly refused before task delivery. The live test records that refusal separately and never treats a missing output file alone as sandbox proof.

## Fault regressions and acceptance repairs

Adapter regressions cover fragmented/early/duplicate notifications, strict report validation, terminal-then-exit deduplication, failed-spawn cleanup, inherited environment preservation, known request-validation rejections versus uncertain server errors, owned descendant cleanup, and large identity headers. The focused adapter/header run passed 26 tests.

Shared delivery regressions cover write-ahead ordering, stop before/during launch, unresolved-input guards, manual-resume state, steer alongside deferred input, broken-worker queue returns, crash-recovery queue pumping, and fast-terminal FIFO/state preservation. The final focused run passed 49 tests, including 18 delivery-boundary regressions. The three fast-terminal cases failed before their fix and passed afterward.

The first post-fix full Connector run passed 467 tests and failed one older assertion. Manual resume now claims `recovering` before input; a racing send queues and interrupt returns it as `superseded`, instead of attempting another cold launch and hitting `lock_held`. The updated test checks the state, waits for the live transition, and proves no second process or prompt occurred. The subsequent complete suite passed all 468 tests.

Two stale rename assertions were repaired: the CLI test now launches `bin/orbit.js`, and the web pairing test expects the current `@sclfcz/orbit` package scope. No permission or recovery guard was weakened. A machine-local preview configuration was used for acceptance and excluded from the feature commit.

The original implementation snapshot had 426 Connector passes, 11 stale-bin failures and 5 skipped tests; Steward had 667 passes and one stale-scope failure. A recursive run also exposed load-sensitive heartbeat/watchdog failures that passed isolated checks and the later complete Connector suite. These earlier failures are not relabelled as successful runs.

## Remaining boundaries

- Only `0.166.0-alpha.6` was live-tested. Discovery accepts the narrow 0.166/0.167 family; acceptance of a version is not certification of that release.
- A clean independent CLI configuration is still needed to certify readonly model execution.
- Any unowned Codex process can conservatively block cold continuation, including desktop-related processes. Its command line cannot prove which thread it owns. Successful manager-level cold continuation with desktop coexistence remains unverified.
- Images remain unsupported, and monetary cost is not inferred from token usage.
- No deployed cloud environment was tested.

See [Codex support](codex-cli.md), [ADR-0013](adr/0013-codex-cli-workers.md), and the [implementation plan](plans/codex-cli-integration.md). Routing prompts/model selection/tool definitions were not changed, so ADR-0001's routing-evaluation trigger does not apply. Pi-to-Codex handoff is checked as a new session, not reuse of a Pi session ID.
