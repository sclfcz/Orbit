# Codex CLI implementation validation — 2026-11-07

Overall: **package regressions, local browser workflow and cold continuation pass; readonly model acceptance remains conditional**. Real-CLI evidence covers worktree writes, structured reports, steer, interruption with shell cleanup, local history, Connector restart, and uncertain-crash no-replay recovery. Manager-level cold continuation succeeds while an unrelated real app-server remains alive; same-thread competing writers are refused before input. A clean readonly model turn remains unverified.

This public record contains aggregate results and reproducible test names. Raw session records, machine identifiers, local paths, credentials and detailed process evidence remain local. The owner authorized committing and pushing verified source to a feature branch; deployment and merging main are outside this task.

## Final checks

| Check | Result |
| --- | --- |
| `pnpm --dir apps/connector test`, including build | **474 passed, 7 skipped**; 47 files passed, 3 skipped; 31.05 s |
| `pnpm --dir apps/steward test` | **668 passed**, including 12 generated-auth tests; earlier unchanged-package run |
| `pnpm --dir packages/protocol test` | **61 passed**; earlier unchanged-package run |
| `pnpm --dir apps/preview-machine test` | **7 passed**; earlier unchanged-package run |
| Complete real adapter acceptance before the cold-continuation amendment | **5 passed**, 60.26 s |
| Strengthened real adapter writer-exclusion/release/continuation test | **1 passed**, 4 deselected; 27.43 s |
| Real Connector restart/recovery, `test/codex-connector-live.test.ts` | **1 passed**, 65.31 s; same-thread cold continuation with an unrelated real app-server alive |
| Rebuilt local browser dispatch, same-turn steer, interruption and history | Passed; no late shell write after its original deadline |
| Rebuilt browser continuation of the interrupted session | Passed; same native thread, new structured report, history updated |
| Focused cold-continuation and delivery regressions | **67 passed**, 6.36 s; Connector typecheck passed |
| Independent npm CLI `0.167.0`: both real acceptance files, sequential | **6 passed**, 193.93 s; includes safe readonly refusal, not a clean readonly model run |
| `pnpm typecheck` | All workspace packages passed after the cold-continuation fix |
| `git diff --check` | Passed |

Package suites were run separately, not relabelled as a recursive test run. Their latest recorded results total **1,210 passing tests**, excluding opt-in real checks and overlapping focused runs. Steward/protocol/preview-machine ran earlier; their implementation did not change during the Connector fixes. Live tests remain opt-in and are skipped in the default suite.

Earlier acceptance toolchain: Node 26.0.0, pinned pnpm 10.33.0, macOS, desktop-bundled `codex-cli 0.166.0-alpha.6` with the existing login. Those runs adjusted only test-process PATH. They did not certify an independent CLI installation.

## Independent CLI installation — 2026-11-07

Installed the official npm package with `npm install -g @openai/codex@0.167.0`, the stable release available during this acceptance. The normal shell PATH now resolves `codex` to the standalone npm package launcher; its resolved path is outside the desktop app bundle. `codex --version` reports `codex-cli 0.167.0`, and `codex login status` confirms the existing ChatGPT login. No authentication copy, global Codex configuration edit, shell-profile change or desktop replacement was needed. Connector service setup captures PATH; a previously running service must be restarted after installation to discover the CLI.

Ran both opt-in acceptance files without a desktop PATH override or an `ORBIT_CODEX_COMMAND` override:

```bash
ORBIT_CODEX_LIVE=1 pnpm --dir apps/connector exec vitest run test/codex-live.test.ts test/codex-connector-live.test.ts --no-file-parallelism
```

Result: **2 files, 6 tests passed in 193.93 seconds**. Probe and task evidence report `codex-cli 0.167.0`; all three separate Connector boots advertise that version. Real checks passed for handshake/config reads, isolated worktree write and structured report, rejection of a second writer before input, same-thread continuation after release, local history, steer, interruption, owned-process cleanup and no delayed shell write. The native sandbox denied a real write under `readOnly` and allowed the same command under the restricted writable policy.

The Connector subprocess test successfully cold-continued while an unrelated real app-server stayed alive. History reconstruction matched the original local record across **31 pages, 60 fragments and 35 split fragments**. Uncertain-crash recovery preserved receipts, rejected duplicate/retry commands and observed exactly one start-marker execution. No runtime changes were required for the stable CLI.

Independent installation does not imply isolated configuration: this CLI still uses the existing Codex home, including inherited external integrations. The readonly preflight again returned `unsupported_capability` before model input, recorded as `refused_unverifiable_external_tools`. That expected refusal is one of the six passing checks; it is not proof of a clean readonly model turn. Clean readonly model acceptance remains a separate gate. The browser acceptance below used the earlier desktop-bundled version and was not repeated for this installation.

## Local browser acceptance

After explicit owner authorization, the real Machines UI created a one-time pairing command and paired a foreground Connector with isolated state. The browser registered a temporary Git repository, and the configured local Steward dispatched an explicitly requested Codex write task into an isolated worktree. No background service or cloud deployment was installed.

The first task returned a real structured report, wrote exactly the requested single-line acceptance marker plus its trailing newline, and left the original checkout unchanged. Agent sessions loaded the original session records. Direct continuation and steer were durably accepted, and the UI displayed both interruption status and native `turn_aborted` history.

That run exposed an actual cancellation defect: a native background shell wrote its finish marker **after** the model turn was interrupted. The adapter now retires the owned app-server and identity-checked descendants before emitting interrupted settlement. The strengthened live adapter test starts a real shell with a delayed write, steers, interrupts and waits beyond the original deadline; the finish file remains absent and the app-server is stopped.

The rebuilt application's final browser run used a new worker and a 90-second shell. After the real start marker appeared, browser controls immediately submitted steer and interrupt. Both receipts were delivered to the same turn. At 95 seconds after shell start, the finish marker remained absent, the owned app-server was gone, SQLite recorded `idle / aborted`, and the native record contained `turn_aborted`. The browser displayed `Up to date · 24 entries` and `Interrupted.`.

An earlier post-fix browser task finished naturally before the controls were exercised. It is not counted as cancellation evidence. The final run triggered browser actions from the observed shell start and waited beyond the original deadline.

After the cold-continuation fix, the rebuilt foreground Connector reopened this paired local state. The browser sent a file-inspection follow-up to the previously interrupted worker. It returned a new structured report, retained the original native thread ID, and settled `idle / reported`. The page showed `Sent.` and `Up to date · 51 entries`, including the new report; the original start marker remained present and the cancelled shell's finish marker remained absent. A browser wait initially timed out because its chosen status label was no longer rendered; the subsequent snapshot showed completion, and the local lifecycle record confirmed it. This was a continuation, not a replacement worker.

Local acceptance does not certify a deployed cloud environment. Post-interrupt continuation is cold and remains subject to exact-thread occupancy checks. Interrupting local execution cannot undo external side effects.

## Restart, history and uncertain delivery

The subprocess acceptance test uses actual separate Node ConnectorApp/LocalStore/CodexAdapter processes and real Codex. Only the Steward server is mocked. Business commands and history travel over real WebSocket frames; IPC is lifecycle-only.

Three distinct Connector processes and boot IDs reopened the same store. A real Codex task wrote the expected bytes in its assigned worktree, reported done and left the original checkout unchanged. Thread identity, worktree and last event sequence survived restart.

History was reconstructed solely through `history_chunk` / `history_ack`: **30 pages, 59 fragments, 34 split fragments** in the latest run, with every offset/length checked and the reconstructed records equal to the original local file.

For the uncertain-crash case, a second task reached a real shell marker. The test suspended only its identity-checked owned app-server, then killed the Connector. This prevents the CLI's normal stdin-EOF handler from recording an abort. Production startup reaped the orphan and classified the untouched real record as `unknown / delivery_ambiguous`. Receipts remained unchanged, the marker executed once, no finish file appeared, send/resume were rejected, and the original command ID was deduplicated. A real post-recovery heartbeat allowed time to observe erroneous replay. No rollout or receipt was edited.

An earlier kill-only attempt produced a genuine aborted record and was not counted as unknown evidence. The original acceptance run also returned `session_in_use` during cold continuation because the manager rejected any unrelated Codex process. That historical refusal was not counted as successful continuation and is superseded by the checks below.

### Cold-continuation repair

The manager retains recorded owner PID/start-time checks but no longer vetoes every Codex process. The owned app-server explicitly uses `experimental_thread_store.type="local"`. The native local store acquires an atomic per-thread writer lock during resume, before input. Only the exact requested thread's native conflict becomes retryable `session_in_use`; generic RPC errors retain their meaning. This retryability survives both cold-send wrapping and manual-resume WebSocket responses.

- A real second app-server was refused while the original idle thread still had an owner, before session persistence or input delivery. After the original server stopped, the same thread resumed and reported successfully.
- A real unrelated app-server remained alive while a restarted Connector cold-continued its own thread, read the previous turn's file, and returned a structured report. The native thread ID remained unchanged, exactly one new acceptance receipt appeared, and event sequences remained contiguous. The test now requires this success; safe refusal no longer passes this case.
- Deterministic regressions cover unrelated-process coexistence, both send/resume conflict responses, no delivery on conflict, exact error matching and CLI version gating.

The first native-lock live attempt stopped earlier with `workspace routing discovery timed out`; it did not reach contention and is not counted as locking evidence. A subsequent unchanged-account/configuration run passed. Native exclusion is scoped to compatible local-store writers sharing `CODEX_HOME`, not copied rollouts in different homes or older nonparticipating writers.

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

- `0.166.0-alpha.6` from the desktop bundle and independently installed `0.167.0` were live-tested. Discovery accepts the narrow 0.166/0.167 family; other accepted releases and platforms are not thereby certified.
- A clean Codex configuration is still needed to certify readonly model execution; installing an independent binary does not isolate inherited configuration.
- Cold continuation and same-thread exclusion were verified with separate real app-servers using the existing home. This does not certify every desktop storage mode; native exclusion requires compatible local-store writers sharing `CODEX_HOME`.
- Images remain unsupported, and monetary cost is not inferred from token usage.
- No deployed cloud environment was tested.

See [Codex support](codex-cli.md), [ADR-0013](adr/0013-codex-cli-workers.md), and the [implementation plan](plans/codex-cli-integration.md). Routing prompts/model selection/tool definitions were not changed, so ADR-0001's routing-evaluation trigger does not apply. Pi-to-Codex handoff is checked as a new session, not reuse of a Pi session ID.
