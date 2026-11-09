# Codex CLI workers

Orbit drives the official [Codex app-server](https://developers.openai.com/codex/app-server) over stdio. Ask Orbit explicitly to use `codex` on a machine that advertises it. Pi remains the default. There is no desktop-window control, session import or promise that Orbit threads appear in the desktop app.

## Local setup

Install the independent CLI using the [official instructions](https://developers.openai.com/codex/cli). Pin a compatible version instead of following a moving latest tag: `npm install -g @openai/codex@0.167.0`. Run `command -v codex`, `codex --version`, and `codex login status` on the Connector machine. If not already logged in, the owner runs `codex login`. Orbit does not copy authentication files or alter global Codex configuration. Ensure `codex` is on the **daemon's** PATH, which may differ from an interactive shell. Restart the Connector after installation. The integration never hardcodes an app-bundle binary path; deployments should install a separate CLI.

`orbit doctor` prints `codex (this shell):` and `codex (service PATH):`, each showing the detected version, `not found`, or an incompatibility diagnostic. The service PATH is captured from the shell that runs `orbit connect` or `orbit upgrade` and stored in the launchd plist or systemd unit; installing Codex later does not update it. Run `orbit upgrade --version` with the version printed by `orbit --version` from a shell where `command -v codex` succeeds to record the current PATH; for a source install, repeat the source install steps instead. `orbit restart` reuses the recorded PATH and does not refresh it. When the installed unit cannot be read, doctor reports the service PATH as unknown instead of probing a guessed environment. Codex is optional, so neither line changes doctor's readiness result or exit code.

Native protocol and writer-lock implementation traced at **0.166.0-alpha.6**; real acceptance also passed with independently installed **0.167.0**. The stable CLI passed worktree writes/reports, competing-writer exclusion, continuation, steer/interrupt cleanup, local history, Connector restarts and uncertain-crash no-replay checks. A real readonly model turn also passed in a separately authenticated clean Codex home, including actual file reading and a tool-result-confirmed write denial; inherited external tools still trigger safe refusal. Discovery accepts stable and alpha releases within the 0.166/0.167 family, starting at 0.166.0-alpha.6; older or other versions produce `codex_unavailable` diagnostics. This is a compatibility gate, not certification of every accepted release. CLI discovery runs only `--version` with a five-second timeout, not a model task. A configured model is passed explicitly and persisted; an unspecified model is omitted when resuming so Codex retains its saved choice. Login/model availability must still be checked with a real turn.

## Behavior and recovery

- Work runs in the directory assigned by the existing worktree/write-policy mechanism. Readonly turns use `readOnly` with no network. Write turns use `workspaceWrite` with only the assigned directory in `writableRoots`, no network and no implicit temporary roots. These are local-tool policies, not a guarantee about arbitrary inherited external integrations. Readonly preflight rejects external MCP/apps/plugins/hooks/browser/computer configurations it cannot verify.
- Codex's `workspaceWrite` sandbox keeps Git metadata read-only, so a Codex worker cannot `git add` or commit: its changes stay uncommitted in the worktree for the owner to review and commit. Orbit does not widen the writable roots to include `.git`. Pi and Claude Code workers are not affected.
- Images are supported (ADR-0014 phase 6). The Connector fetches and verifies a referenced attachment, then copies it into a private `codex-images` directory under the Connector state directory (owner-only directory and files; never a repository checkout or worktree). The turn carries the text plus one app-server `localImage` entry per image, matching the 0.167.0 schema. A steer copies its images the same way. The local files are deleted when the turn ends, is interrupted, the worker stops, or the app-server exits unexpectedly; Connector startup purges anything a crash left behind. A durably queued `after` message stores only attachment references and re-fetches the bytes when it becomes a turn, so a restarted Connector never needs the old temporary file. Structured final JSON is validated before an Orbit report is emitted; failed, interrupted and unreported turns remain distinct. Token usage is optional; no dollar cost is inferred.
- Running `now` messages steer the exact active turn, including while future `after` input is queued. `after` messages are stored in the Connector's durable FIFO and start a new turn after settlement. Pi and Claude use the same queue. Interrupt waits for terminal evidence and stops the owned app-server plus identity-checked local descendants before reporting interruption: native background shell jobs can otherwise survive a cancelled turn. A natural completion can win the race. Continuation after interruption is cold, so the occupancy checks below still apply; interruption cannot undo external side effects.
- The real Codex thread ID is saved **before the first prompt**, even when its path is null. A successful turn-start/steer RPC is acceptance evidence, not exactly-once deduplication. An intent with no receipt is ambiguous and is never automatically replayed. Only JSON-RPC request-validation rejections (`-32600`, `-32601`, `-32602`) are recorded as known non-delivery; timeouts, disconnects and other server errors remain uncertain.
- After restart, a terminal event for the accepted turn can restore a completed report or an aborted/unreported outcome. Missing or incomplete evidence leaves the worker broken with `delivery_ambiguous`; inspect its local record and make an explicit decision about any new task. Automatic resume and stall replay are disabled for uncertain Codex work.
- A queued message survives restart. An uncertain sending item blocks FIFO successors. Known unsent items are explicitly returned when the worker is interrupted/stopped/broken. Return notification retries may repeat after a crash. Local SQLite retains uncertain input for inspection; do not retry it blindly.
- Cold continuation preserves the thread ID, model, directory and permission policy. A live recorded owning process still blocks relaunch. For other processes, Codex's native local thread store atomically acquires the exact thread's writer lock during `thread/resume`, before any work input. An occupied thread returns retryable `session_in_use`; unrelated desktop/CLI threads do not block continuation. Orbit forces the local store for its own invocation without changing global configuration. Keep the same `CODEX_HOME` across starts: native locks are home-scoped, and copying a rollout to another home or using an older nonparticipating writer is outside this ownership guarantee. Only recorded Orbit-owned processes with matching process identity may be reaped at startup.

## Local session records

Open the worker session in the workspace while its machine is online. The Connector verifies the local rollout header against the registered Codex thread ID and streams its original JSONL in bounded fragments. A null path may be resolved under the local `CODEX_HOME/sessions` or `archived_sessions` store by ID. Missing/replaced files and offline machines are explicit errors. The cloud does not archive a second session copy. Messages, tool calls/results, errors and compaction records are normalized; mirrored message events are metadata to avoid duplicate text, and unknown entries remain raw.

## Validation

Fake app-server and shared-path regressions cover handshake, fragmented/early/duplicate notifications, server-request refusal, timeout and early exit, strict reports, steer/interrupt races, identity persistence, missing-path and receipt windows, FIFO recovery, and full-history fragmentation/replacement. Run the pinned package-manager checks from the [implementation plan](plans/codex-cli-integration.md).

Image acceptance is opt-in in the same file: the test renders a PNG containing a random six-character label, sends it through `CodexAdapter` as an attachment, requires the structured report to contain exactly that label, requires the local image file to exist while the turn runs, and requires it to be gone after settlement. Real acceptance passed on 2026-11-09 with `codex-cli 0.167.0` (the model read a random `6D7P2P` label from the image). Run it with:

```bash
ORBIT_CODEX_LIVE=1 pnpm --dir apps/connector exec vitest run test/codex-live.test.ts -t 'reads a random label'
```

Real acceptance must separately cover a dedicated test repository: readonly enforcement and worktree writes, final report, steer and interrupt, process stop, cold continuation after restart, and local history. The opt-in `test/codex-live.test.ts` includes native sandbox denial/positive control and competing-writer refusal before input, followed by same-ID continuation after release. `test/codex-connector-live.test.ts` adds real Connector subprocess restarts, WS history reconstruction and uncertain-crash no-replay checks; cold continuation must now succeed while an unrelated real app-server stays alive. Run with `ORBIT_CODEX_LIVE=1` and a supported `codex` on the test process's PATH. The subprocess test also accepts `ORBIT_CODEX_COMMAND` as one executable path. The old blanket-refusal classification is no longer accepted as a passing cold-continuation result. Standalone command sandbox evidence does not certify a readonly model turn with inherited external tools. A desktop-bundled binary found on PATH and a successful `login status` alone do **not** establish this acceptance. See the [implementation validation record](codex-cli-validation.md) for actual outcomes and remaining gates.

### Clean readonly acceptance

Use a new private directory as `CODEX_HOME`, with its own `config.toml`:

```toml
web_search = "disabled"

[features]
apps = false
plugins = false
hooks = false
browser_use = false
computer_use = false
multi_agent = false
```

The owner authenticates that home through native login:

```bash
CODEX_HOME=/absolute/path/to/clean-codex-home codex login
```

A new home does not automatically share the old home's login. Both file credentials and [native keyring lookup](https://github.com/openai/codex/blob/rust-v0.167.0/codex-rs/login/src/auth/storage.rs#L302-L320) are home-scoped; do not copy or link authentication files. An empty-table CLI override merges with inherited configuration instead of clearing it, and a profile layers over the base configuration. The isolated setup leaves the existing home and desktop configuration intact.

Run the dedicated model acceptance from the repository root:

```bash
ORBIT_CODEX_LIVE=1 ORBIT_CODEX_READONLY_HOME=/absolute/path/to/clean-codex-home pnpm --dir apps/connector exec vitest run test/codex-live.test.ts -t 'reads through a clean readonly model turn'
```

This test requires actual model execution through CodexAdapter: it checks an undisclosed random file marker, correlates the shell call with its native permission-denied result and nonzero exit code, verifies unchanged input and absent output, and requires a structured report. It does not accept preflight refusal as success. `ORBIT_CODEX_READONLY_HOME` is a test-only input; it does not change the daemon's configured home. Continue using the original home for existing workers and threads; this acceptance creates new test threads in the isolated home.

The managed-path acceptance runs the same clean-home readonly check through a real Connector subprocess, `WorkerManager`, and WebSocket command dispatch:

```bash
ORBIT_CODEX_LIVE=1 ORBIT_CODEX_READONLY_HOME=/absolute/path/to/clean-codex-home pnpm --dir apps/connector exec vitest run test/codex-connector-live.test.ts --no-file-parallelism
```

It requires a structured `done` report containing the undisclosed marker, the matching native shell call and permission-denied result with a nonzero exit code, unchanged input, absent output, and a clean repository. A second Connector boot with the default `CODEX_HOME` must return `unsupported_capability` before `turn/start`; the test records app-server input and rejects the result if any prompt reaches the model. The test does not create, copy, or modify credentials or configuration in either home.
