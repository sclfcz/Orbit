# Codex CLI implementation validation — 2026-11-07

Overall: **package regressions, local browser workflow, cold continuation, clean readonly execution through both the adapter and Connector manager path, and deployed staging acceptance pass**. Real-CLI evidence covers worktree writes, structured reports, steer, interruption with shell cleanup, local history, Connector restart, networking recovery, and uncertain-crash no-replay recovery. Manager-level cold continuation succeeds while an unrelated real app-server remains alive; same-thread competing writers are refused before input. Readonly acceptance uses a separately authenticated clean Codex home; inherited external integrations remain rejected.

This public record contains aggregate results and reproducible test names. Raw session records, machine identifiers, local paths, credentials and detailed process evidence remain local. The owner merged the feature into main on 2026-11-07 and separately authorized the staging deployment below; the production deployment and npm release have not been performed.

## Final checks

| Check | Result |
| --- | --- |
| `pnpm --dir apps/connector test`, including build | **474 passed, 9 skipped**; 47 files passed, 3 skipped; 30.07 s |
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
| Clean-home readonly model acceptance, npm CLI `0.167.0` | **1 passed**, 5 deselected; 40.59 s; actual read, correlated write denial and structured report |
| Clean-home readonly through Connector/WS manager path, npm CLI `0.167.0` | **1 passed**, 1 skipped; 18.58 s; default home refused before model input |
| Deployed Cloudflare staging acceptance, new and old Connector compatibility | Passed; all required Codex and Pi scenarios completed |
| Adapter regressions and default live-test gating after readonly addition | **27 passed, 6 skipped**, 6.12 s; Connector typecheck passed |
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

Independent installation does not imply isolated configuration: this CLI still uses the existing Codex home, including inherited external integrations. The readonly preflight again returned `unsupported_capability` before model input, recorded as `refused_unverifiable_external_tools`. That expected refusal is one of the six passing checks; it is not proof of a clean readonly model turn. The subsequent clean-home model check is recorded separately under Readonly boundary. The browser acceptance below used the earlier desktop-bundled version and was not repeated for this installation.

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

This standalone `command/exec` check proves native local command sandbox enforcement; it was not counted as a readonly model turn. This machine's default home inherits desktop MCP/plugin configuration, which empty-table overrides did not remove. Readonly preflight correctly refused before task delivery.

A separate clean-home model acceptance subsequently passed with independent `codex-cli 0.167.0`: **1 test passed in 40.59 seconds**, with five other live cases deselected. A new private `CODEX_HOME` used native ChatGPT login and a local configuration disabling apps, plugins, hooks, browser/computer use, multi-agent and web search. No authentication file was copied or linked; no existing global configuration was edited. Effective `config/read` returned empty MCP/plugin tables and null apps/hooks/browser/computer entries. The normal home still reported its existing ChatGPT login afterward.

The test created a random marker in an input file, without revealing it in the model prompt. Through the production CodexAdapter in readonly mode, the model invoked the requested shell command to read that file and attempt a write. Its exact native call ID was correlated with the corresponding tool result: the output contained the random marker, an OS permission-denial message and a nonzero exit code. The input bytes remained unchanged, the output file was absent, and the model returned the required structured `done` report containing the marker. Refusal before model execution, a model-authored claim of denial, or file absence alone cannot pass this test. No runtime or preflight protection was changed.

The new case requires both `ORBIT_CODEX_LIVE=1` and `ORBIT_CODEX_READONLY_HOME` pointing at the separately authenticated clean home. It is skipped by default. The existing inherited-config refusal case remains separate. See [Codex support](codex-cli.md#clean-readonly-acceptance) for the reproducible setup. This acceptance covers the clean local configuration on the tested platform, not arbitrary external integrations or the deployed browser/cloud environment.

The managed-path acceptance then passed through a real Connector subprocess, `WorkerManager`, and WebSocket dispatch: **1 test passed in 18.58 seconds**, with one skipped. The clean-home worker returned a structured `done` report containing the undisclosed marker; the repository stayed clean, input bytes were unchanged, the output file was absent, and the matching native shell call showed the expected permission denial and nonzero exit code. A default-home control Connector was refused with `unsupported_capability`; recorded app-server stdin contained initialization and account reads but no `turn/start` and no control prompt. No production protection or preflight logic was changed.

A later adapter-level rerun after extracting the shared native-rollout helper stopped at the account usage limit before model completion (`usage_limit_exceeded`). It is not counted as a pass; the managed-path test exercised the same helper successfully, and the earlier adapter-level clean-home result above remains separately recorded.

## Deployed staging acceptance — 2026-11-08

An isolated Cloudflare staging Worker was deployed from the pre-Codex main commit and then from the feature branch. The Owner configured the browser password and model key directly; no secret or pairing code transited the agent. The formal Worker was not deployed, modified, or used by this acceptance.

- Both versions returned the expected unauthenticated gates: `/app` `200`, `/api/messages` `401`.
- Between the two deployed versions, only browser UI assets changed (Codex session rendering and the `Codex` label). The Steward server and protocol code are identical, so the compatibility results below do not depend on whether the Steward or the npm package ships first.
- The acceptance machine's PATH resolved `codex` to the independently installed `codex-cli 0.167.0`. The Machines page lists agent names but not versions, so the advertised version was not captured separately.
- New Connector (built from the feature branch; its package version is still `0.1.3` until the release bump) connected to the old Steward and received `welcome`. The old Steward accepted the extra `codex` capability advertisement, and a Pi task completed with the exact expected file bytes.
- Old npm Connector `0.1.3` connected to the new Steward and reported only `pi, claude-code` capabilities; Codex was correctly absent. Its Pi task also completed with the exact expected file bytes.
- Pi `1.2.0` came from the repository's devDependency in both compatibility runs. An initial Pi launch failed with `spawn pi ENOENT` because that directory was not on the foreground Connector's PATH; restarting with the repository `node_modules/.bin` on PATH fixed the test environment. It was not a product failure.
- An explicitly requested Codex write task ran in an isolated worktree, returned a structured `done` report, wrote the exact expected bytes, and left the registered repository checkout clean.
- A second Codex task started a 120-second shell. Steer was delivered to the active turn, interruption settled the worker as `aborted`, the started marker remained, and no finish file appeared after the original deadline.
- Cold continuation reused the same worker and native thread/session identity and produced a new structured `done` report. The workspace session view grew from 46 to 75 entries.
- Restarting the foreground Connector with the same isolated state retained the worker state and the 75-entry session view. No new start, report, or settle events were emitted for the completed worker.
- A controlled network outage used a local HTTP proxy with WebSocket upgrade forwarding. Removing it produced repeated `1006` closes; restoring it produced `welcome` again. No command was replayed and the completed worker remained `idle/reported`.
- A default-home Codex readonly task was rejected with `unsupported_capability` before model input; the UI displayed the inherited-external-tools explanation. The corresponding worker had no Codex session identity.
- Acceptance Connectors were stopped, both test machine registrations were revoked, the temporary old-version worktree was removed, and the staging Worker was retained for Owner cleanup.

## Fault regressions and acceptance repairs

Adapter regressions cover fragmented/early/duplicate notifications, strict report validation, terminal-then-exit deduplication, failed-spawn cleanup, inherited environment preservation, known request-validation rejections versus uncertain server errors, owned descendant cleanup, and large identity headers. The focused adapter/header run passed 26 tests.

Shared delivery regressions cover write-ahead ordering, stop before/during launch, unresolved-input guards, manual-resume state, steer alongside deferred input, broken-worker queue returns, crash-recovery queue pumping, and fast-terminal FIFO/state preservation. The final focused run passed 49 tests, including 18 delivery-boundary regressions. The three fast-terminal cases failed before their fix and passed afterward.

The first post-fix full Connector run passed 467 tests and failed one older assertion. Manual resume now claims `recovering` before input; a racing send queues and interrupt returns it as `superseded`, instead of attempting another cold launch and hitting `lock_held`. The updated test checks the state, waits for the live transition, and proves no second process or prompt occurred. The subsequent complete suite passed all 468 tests.

Two stale rename assertions were repaired: the CLI test now launches `bin/orbit.js`, and the web pairing test expects the current `@sclfcz/orbit` package scope. No permission or recovery guard was weakened. A machine-local preview configuration was used for acceptance and excluded from the feature commit.

The original implementation snapshot had 426 Connector passes, 11 stale-bin failures and 5 skipped tests; Steward had 667 passes and one stale-scope failure. A recursive run also exposed load-sensitive heartbeat/watchdog failures that passed isolated checks and the later complete Connector suite. These earlier failures are not relabelled as successful runs.

## Remaining boundaries

- `0.166.0-alpha.6` from the desktop bundle and independently installed `0.167.0` were live-tested. Discovery accepts the narrow 0.166/0.167 family; other accepted releases and platforms are not thereby certified.
- Readonly model execution and the Connector subprocess/manager path passed in a separately authenticated clean home. The default home still contains external integrations and remains safely refused before model input; installing an independent binary does not isolate inherited configuration.
- Deployed staging acceptance passed for the tested Cloudflare account and platform. The formal production deployment and npm release were not performed.
- Cold continuation and same-thread exclusion were verified with separate real app-servers using the existing home. This does not certify every desktop storage mode; native exclusion requires compatible local-store writers sharing `CODEX_HOME`.
- Images remain unsupported, and monetary cost is not inferred from token usage.

See [Codex support](codex-cli.md), [ADR-0013](adr/0013-codex-cli-workers.md), and the [implementation plan](plans/codex-cli-integration.md). Routing prompts/model selection/tool definitions were not changed, so ADR-0001's routing-evaluation trigger does not apply. Pi-to-Codex handoff is checked as a new session, not reuse of a Pi session ID.
