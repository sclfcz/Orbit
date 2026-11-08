# ADR-0014: Image input from the web workspace to workers

Status: proposed (2026-11-09). Scope: issue #13. Amends ADR-0004's owner-input record (its decision 1 keeps only the text) and ADR-0011's text-only `worker_cmd`. Does not change ADR-0013's Codex contract, the connector's delivery/recovery rules, or any worker-protection logic.

## Context

The owner wants to attach images in the web workspace and have them reach a worker, either with a task or with a follow-up message. Today the path is text-only end to end: the composer sends `{id, text, threadId, replyTo}` (`apps/steward/ui/workspace.js`, `postMessage`), the Steward parses only those fields (`apps/steward/src/workspace-api.ts`, `parseMessage`), owner inputs are stored without attachments (`sh_inbound`), and the Pi adapter already understands images (`apps/connector/src/pi-adapter.ts`) but nothing upstream sends them. The session viewer can already render image blocks (`apps/steward/ui/session-model.js`), so display is the easy part; storage, transport and delivery semantics are the hard part.

Three existing bounds shape the design:

- `POST /app/api/messages` is JSON and capped at 70,000 bytes (`MAX_BODY_BYTES`), with 16,000 characters of text (`MAX_MESSAGE_CHARS`). Inline images cannot use this route.
- The protocol caps a whole command at 256 KiB (`docs/design/connector-do-protocol.md` §3.6 and §6.2), because each command is stored as one SQLite `payload` row and parsed as one WebSocket frame. Images above roughly 190 KB of raw bytes do not fit.
- The connector already rejects any image whose base64 string exceeds 4 MiB (`apps/connector/src/worker-manager.ts`, `startWorker` and `sendToWorker`). That is about 3 MiB of raw bytes per image.

The current message path also duplicates payloads: `sh_web_request.payload` keeps the whole request for idempotency, `outbox.payload` keeps the whole command, and `deferred_send.input` keeps the whole deferred input. Inline base64 would therefore be written, parsed and copied at least three times per image, and replayed on every reconnect.

### Verified constraints

1. **Cloudflare storage and transport limits.** Durable Object SQLite allows 8 MB per string, BLOB or row, and 10 GB per Durable Object; a Durable Object WebSocket message is capped at 32 MiB for received messages. Workers request bodies are capped by the zone's Cloudflare plan: 100 MB on Free and Pro, 200 MB on Business. Sources: [Durable Objects limits](https://developers.cloudflare.com/durable-objects/platform/limits/) and [Workers limits](https://developers.cloudflare.com/workers/platform/limits/). The "SQLite row is only 2 MB" note in `docs/design/connector-do-protocol.md` §3.6 is stale against the current limits page; this ADR uses 8 MB, but does not rely on approaching it.
2. **Steward → connector commands are one JSON frame, stored whole.** `enqueue` writes `JSON.stringify(args)` into `outbox.payload TEXT`; `deliver` reads the row, `JSON.parse`s it, rebuilds the `cmd` envelope and calls `connection.send(JSON.stringify(cmd))` (`apps/steward/src/steward.ts`, `apps/steward/src/schema.ts`). The connector's deferred queue stores the whole `{text, images}` input the same way (`apps/connector/src/store.ts`, `queueDeferred`). The 256 KiB command cap is a documented protocol rule, not an enforced check: no code rejects an oversized command today, and the 32 MiB WebSocket limit is the only hard ceiling.
3. **Pi RPC image shape.** `prompt`, `steer` and `follow_up` accept `images?: ImageContent[]`, where `ImageContent` is `{type:"image", data:<base64>, mimeType:<string>}`. Source: the pinned 1.2.0 package's `dist/modes/rpc/rpc-types.d.ts` and `dist/types.d.ts`, plus the adapter's actual calls in `apps/connector/src/pi-adapter.ts`. The RPC layer documents no size limit of its own; the model catalog applies resize limits (see fact 6).
4. **Codex app-server image input, 0.167.0.** Running `codex app-server generate-json-schema --out <dir>` with `codex-cli 0.167.0` produced a `UserInput` union containing `ImageUserInput` (`{type:"image", url} | {type:"image", fileId}, detail?: auto|low|high|original`) and `LocalImageUserInput` (`{type:"localImage", path, detail?: auto|low|high|original}`). The schema accepts a URL or an uploaded file id, not raw base64. Orbit's adapter declares `images: false` and refuses images on both start and send (`apps/connector/src/codex-adapter.ts`).
5. **Claude Code image input.** The CLI documents `--input-format stream-json` for print mode ([CLI reference](https://code.claude.com/docs/en/cli-reference)). The Agent SDK's streaming-input documentation shows user messages whose `content` is a list of `{type:"text"}` and `{type:"image", source:{type:"base64", media_type, data}}` blocks ([streaming input](https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode)). Orbit's Claude adapter runs `claude -p` with the prompt as stdin text, declares `images: false`, and has no stream-json input path (`apps/connector/src/claude-adapter.ts`). So the capability exists in the product, but not in Orbit, and it has not been validated here.
6. **The Steward's own model versus the Steward's pipeline.** The pinned `@earendil-works/pi-ai@1.3.0` catalog declares the default `deepseek/deepseek-flash` model as `input: ["text","image"]`, with image resize limits of 2000×2000 and 4.5 MB base64. But the Steward pipeline is text-only: `submitUserMessage` builds a string and calls `piHarness.submit(text, …)`, `sh_inbound` has only `text` and `threadId`, and the workspace message DTO has no attachment field. The model could accept an image; the current harness and storage cannot deliver one. Sig's model is also owner-configurable, so a vision assumption cannot be part of the contract.

## Decisions

1. **v1 is worker-bound, not general chat, and Pi-only.**
   Images are accepted only where the target worker is already determined without the Steward model: (a) the session view's direct send to the worker it is subscribed to, and (b) a reply in the main composer to an open worker question, which already has a deterministic relay path (`answerWorkerQuestion` → `Dispatcher.sendToWorker`). The composer shows the attach control only after the reply target is proven to be an open worker question; a reply to a closed report still goes through Sig and gets no attach control. Starting a brand-new worker with images is out of v1 because it needs an explicit agent choice and routing that the current composer does not have. v1 also requires text alongside an image: the existing dispatch path refuses empty text, and an image-only prompt needs a separate "describe this image" contract.
   Only Pi is enabled (`capabilities.images: true`). Codex and Claude keep `images: false`; their adapters continue to reject with `unsupported_capability`. The web disables the attach control for those workers and says "这个 agent 暂不支持图片，请改用 Pi 或去掉图片。" / "This agent can't take images yet — use Pi or remove the image." An old connector without the reference capability gets "请先在这台机器上运行 orbit upgrade 更新 Orbit，然后重试。" / "Update Orbit on this machine with orbit upgrade, then try again." The API rejects a forged request with `unsupported_capability`; the connector re-checks the capability, so a bad caller cannot make an agent silently drop an image. Starting a task with images is a later phase.
   Rejected: routing images through general main-chat messages (needs Sig vision or a second routing contract), and enabling Codex from schema support alone without live acceptance.

2. **Sig relays attachments; it does not look at them in v1.**
   The attachment belongs to the same message as the text and therefore to exactly one delivery intent. For session-view messages that intent is the subscribed worker; for a quoted open question it is that question's worker. No "nearest task" inference and no attachment-to-task matching by the model. Sig's prompt, tools and context stay text-only. Making Sig see images would require extending `PiHarness.submit` to image content, a vision-specific prompt/eval, and a cost decision; describing the image in text would be lossy and would still require storing it.
   Rejected: Sig vision, and "Sig describes the image to the worker" as a shortcut.

3. **Attachments live in Durable Object SQLite, chunked, with metadata separate from bytes.**
   A new `sh_attachment` row holds `id`, `mimeType`, `bytes`, `sha256`, `width`/`height` when known, `createdAt`, `expiresAt` and lifecycle state. Bytes go into `sh_attachment_chunk(attachmentId, position, data BLOB)` at 256 KiB per chunk. Links from an owner message or command are separate rows, so the same attachment can be referenced by a command and by the history view. This avoids a new R2 binding and bucket (and the deploy-button provisioning that would come with it) and stays far below the 8 MB row and 10 GB per-object limits. It also avoids writing base64 into `sh_web_request`, `outbox` and `deferred_send`. R2 remains the escape hatch if image volume or retention grows; it is not justified for a single-owner workspace yet.
   Rejected: inline base64 in the message/command (three copies, 70 KB body, 256 KiB command), R2 for v1 (new operational dependency), and a single BLOB row per image (needless coupling to one row limit).

4. **Limits and type validation are explicit.**
   Per image: at most 3 MiB of raw bytes, which is exactly 4 MiB of base64 and preserves the connector's existing 4 MiB check. At most 4 images per message, and at most 6 MiB of raw bytes per message. Allowed types: `image/png`, `image/jpeg`, `image/webp`, `image/gif`. The upload endpoint checks the declared type, then the magic bytes (PNG signature, JPEG `FF D8 FF`, `GIF87a`/`GIF89a`, `RIFF`…`WEBP`); a mismatch is rejected. SVG and any other type are rejected because they are active content, not because the viewer cannot draw them. The server does not decode pixels or dimensions in v1; the byte cap bounds the cost and the agent's own image pipeline applies its resize limits. The existing session viewer's four-type whitelist is the precedent for this list.
   Rejected: trusting `Content-Type` alone, allowing SVG, and silently re-encoding every upload (loses fidelity and adds CPU; can be a later option).

5. **Steward → connector carries references; the connector pulls bytes.**
   A `send` command carries `attachments: [{id, mimeType, bytes, sha256}]`, not base64. The connector fetches each id over HTTPS from the Steward, using the same per-device bearer token it already uses for its WebSocket (`apps/connector/src/client.ts`), scoped to the command's target device. It streams the response to a private temporary file in the connector state directory (never a registered repository or worktree), verifies byte length, SHA-256 and magic bytes, then hands the bytes to the adapter. Pi receives base64 in its RPC prompt; a future Codex path receives a `localImage` path to that temporary file. The command stays small, the 256 KiB rule stands, and no new WebSocket frame type is introduced.
   Because an old connector only understands inline `images`, the hello snapshot adds an explicit `imageInput: "reference"` capability for the Pi agent. The Steward refuses to send attachment references to a machine without it and shows the `orbit upgrade` hint, exactly as it does for `unsupported_command`. The connector also rejects a reference it cannot verify; it never falls back to sending text alone.
   Rejected: raising the command cap and inlining base64 (slow JSON, three copies, replay cost), R2 signed URLs (new infrastructure), and chunked WebSocket transfer (ordering and partial-delivery complexity).

6. **Image and text are one delivery intent.**
   The browser completes the upload before it creates the message. The message stores attachment ids; `sh_web_request`, `outbox.payload` and `deferred_send.input` store only those ids. Bytes are immutable and content-addressed by SHA-256. The connector fetches and verifies before it acknowledges the command; a bounded retry handles a transient fetch failure, and a permanent failure is a terminal `rejected` with `attachment_unavailable` (nothing is sent, and the owner is told to resend). A restart re-fetches by id, because the reference is durable and the bytes are still in the Steward. The deferred FIFO replays the same ids in the same order; if an attachment is unexpectedly unavailable, the deferred entry becomes `returned` with a reason and the owner is notified, never a text-only delivery.
   The existing ambiguity rule is unchanged: an uncertain delivery is not replayed automatically, and its bytes are retained as evidence. Ordering is per command; an image is never split from its text or delivered in a separate message.
   Rejected: uploading after the message is accepted (creates a window where the worker has text but no image), storing a second copy in the deferred queue, and "send text now, image later" as a degradation.

7. **Security follows the existing owner-session boundary.**
   Upload requires the owner session, the existing CSRF token and the same Origin check as the other `/app/api` mutations; the body is enforced while streaming, not after buffering. Only an authenticated owner can read an attachment: the browser uses its session, the connector uses its device bearer token and the command's target-device check. Responses are `Cache-Control: private, no-store` and `X-Content-Type-Options: nosniff`; images are never exposed as public URLs. Logs record only id, mime type, byte count and a short hash prefix; bytes and base64 never enter Steward or connector logs, and error messages never echo image data. Connector temporary files are created with owner-only permissions and deleted after the adapter consumes them or the worker settles. Images are never written into a repository checkout, a worktree, or a commit.
   Rejected: public/signed object URLs for v1, embedding `data:` URLs in the page, and putting the device token in a query string.

8. **Storage is reclaimed by lifecycle, and history degrades visibly.**
   An upload that is never referenced is deleted after 24 hours. Bytes referenced by a delivery intent are kept until that intent is terminal (including an owner decision on an ambiguous one) and then for 7 days for history, with a 30-day hard cap for an unresolved ambiguous intent. Metadata is kept after the bytes are gone so history can show "attachment expired" instead of a broken image. A Durable Object alarm performs the sweep; no browser tab is responsible for deletion.
   Rejected: indefinite retention (unbounded storage) and deleting as soon as the command is acknowledged (history would lose the image the owner just sent).

9. **History and display are metadata-first.**
   The workspace snapshot returns attachment metadata on the owner message, not bytes. The feed renders thumbnails by fetching the authenticated endpoint lazily and revoking the object URL on unmount; a click opens the full image. Uploading, sent, delivered, failed and expired states are visible per attachment. Session history keeps the existing image-block rendering (`session-model.js`'s `imageSrc`, four-type whitelist) for images that appear in a worker transcript, and uses the same attachment endpoint for images the owner sent. All new strings are added to both languages in `apps/steward/ui/i18n.js`, in the same style as the directory-removal group.
   Rejected: inlining data URLs into the rendered HTML (large DOM strings, needless memory copies, weaker CSP posture).

10. **The protocol surface is additive and capability-gated.**
    New endpoints: `POST /app/api/attachments` (raw image body, returns `{id, mimeType, bytes, sha256}`) and `GET /app/api/attachments/:id` (owner session; a device-authenticated variant for the connector). `POST /app/api/messages` and `worker_cmd`'s `send` args gain `attachments?: string[]`; the outbound `send` command gains the reference array described above. The hello capability gains `imageInput: "reference"`. No existing field changes meaning; old clients keep the text-only path.

## Consequences

- A message with images is either fully delivered or not delivered; there is no partial state where the worker sees the text but not the image.
- The Steward now stores binary data. That is a real new responsibility: chunk tables, an authenticated read path, an alarm sweep, and backup/restore behavior for those tables. It is bounded by the limits above.
- Sig cannot answer questions about an image. If the owner asks "what is in this screenshot?" without a worker target, v1 has no path; that is a deliberate scope cut, not a silent failure.
- Codex image support is technically close (the schema has both `image` and `localImage`), but it remains behind the same capability gate until a real turn reads a test image and the worktree/temporary-file cleanup is proven.
- Claude Code support requires moving the adapter from stdin text to `--input-format stream-json`; the SDK documentation shows the block shape, but the CLI path must be validated before the capability is flipped.

## Validation boundary

This ADR is design-only; no model calls, deployments or code changes were made. Before any phase ships, the following must be demonstrated:

- Upload tests for oversized bodies, wrong magic bytes, SVG, a mismatched declared type, duplicate request ids, missing CSRF/Origin, and an unauthenticated read.
- Steward tests that chunk and reassemble bytes exactly, that a message with an unknown or foreign attachment id is rejected, and that a retried message is one effect.
- Connector tests for successful fetch and SHA-256 verification, transient retry, permanent failure without a text-only send, deferred replay after restart, and cleanup on success, failure and interrupt.
- A real Pi acceptance run: a small image containing random text, a prompt asking for that text, and a structured report containing it. The repository worktree must remain clean and no temporary file may remain.
- A first live check that a Pi prompt with an image still produces the same report/adjudication path as text; the delivery-ambiguity rule must not change.

## Phased delivery

Each phase is a separate, independently mergeable PR.

1. **ADR and plan (this PR).** Add this ADR and the F-section pointer. No product code. Done when the owner accepts the scope and limits below.
2. **Steward storage and API.** Schema/migrations for attachments and links; chunked read/write; upload and authenticated read endpoints; `parseMessage`/`worker_cmd` attachment ids; capability check; retention fields. Tests: size/type/magic-byte rejection, chunk round-trip, idempotency, authorization, and no bytes in logs. Done when the API can be exercised without the UI and an oversized or forged request never reaches storage.
3. **Web composer and history.** Attach control, file picker, previews, upload progress, disabled states for unsupported/offline workers, send of ids, history thumbnails and expired placeholders, zh/en strings. Tests: UI module assertions and a snapshot/render test. Done when the owner can send from the session view and from an open question reply, and a refresh shows the same attachments.
4. **Connector pull and Pi integration.** Device-authenticated fetch client, streaming temp file, hash/magic verification, Pi `prompt`/`steer`/`follow_up` and the deferred path, restart re-fetch, cleanup, `imageInput` capability. Tests: every failure mode above, plus a fake RPC assertion of the exact `{type:"image", data, mimeType}` shape. Done when a real Pi turn reads a random-text image, the report contains the text, and the checkout is clean.
5. **Retention and observability.** Alarm sweep for the 24-hour/7-day/30-day rules, deletion tests with a fake clock, metadata-only history after deletion, and log/metric lines that contain no image data. Done when bytes are gone at the stated times and history still renders the expired state.
6. **Codex images (later).** Decode a verified attachment to a `localImage` temp path, pass it through `start`/`send`/deferred, flip `images` only after a real 0.167.0 acceptance run, update the Codex support doc. Separate PR and review.
7. **Claude Code images (later).** Move the adapter to `--input-format stream-json`, send image content blocks, validate against the real CLI, then flip the capability. Separate PR and review.

## Owner sign-off

These are product decisions this ADR should not make unilaterally:

- **Scope.** Confirm that v1 is worker-bound only (session view plus replies to open worker questions), with no general main-chat images and no "start a new task with an image".
- **Sig.** Confirm relay-only for v1, rather than letting Sig see and describe images.
- **Storage.** Confirm Durable Object SQLite chunks for v1, with R2 deferred until volume justifies it.
- **Limits and retention.** Confirm 3 MiB per image, 4 images and 6 MiB per message, the four-type whitelist, 7-day history retention and the 30-day ambiguity cap.
- **Codex timing.** Confirm that Codex image input waits for a separate live-acceptance PR even though the 0.167.0 schema supports it.
