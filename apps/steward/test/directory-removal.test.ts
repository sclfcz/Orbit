import { SELF, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Steward } from "../src/steward.ts";
import type { MachineDirectoryRemovalInput, MachineDirectoryRemovalResult } from "../src/workspace-api.ts";
import { configureAndBind, ownerStub, pairFakeConnector, resetLedgerState, webLogin, type FakeConnector } from "./helpers.ts";

const BASE = "https://example.com";
const endpoint = `${BASE}/app/api/machines/directories/remove`;
const connectors: FakeConnector[] = [];
const repository = {
  repoId: "/srv/existing-project",
  name: "existing-project",
  path: "/srv/existing-project",
  defaultBranch: "main",
  remote: "",
};

beforeEach(async () => {
  await resetLedgerState();
  await configureAndBind("ou_owner");
});

afterEach(() => {
  for (const connector of connectors.splice(0)) connector.close();
});

async function browser() {
  const cookie = await webLogin();
  const snapshot = async (): Promise<{
    csrf: string;
    machines: Array<{ id: string; repos: string[]; repositories: Array<{ repoId: string; name: string; path: string }> }>;
  }> => (await SELF.fetch(`${BASE}/app/api/workspace`, { headers: { cookie } })).json();
  const { csrf } = await snapshot();
  const post = (input: MachineDirectoryRemovalInput) => SELF.fetch(endpoint, {
    method: "POST",
    headers: { cookie, origin: BASE, "content-type": "application/json", "x-csrf-token": csrf },
    body: JSON.stringify(input),
  });
  return { post, snapshot };
}

async function machine() {
  const connector = await pairFakeConnector("mac-studio", { repos: [repository], run: null, autorun: false });
  connectors.push(connector);
  await connector.connect();
  return connector;
}

async function operation(post: Awaited<ReturnType<typeof browser>>["post"], input: MachineDirectoryRemovalInput): Promise<MachineDirectoryRemovalResult> {
  const deadline = Date.now() + 3000;
  for (;;) {
    const response = await post(input);
    const result = await response.json<MachineDirectoryRemovalResult>();
    if (result.state !== "pending") return result;
    if (Date.now() > deadline) throw new Error("removal did not settle");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("removing a machine directory from the owner web session", () => {
  it("deduplicates one request and removes the registration after connector confirmation", async () => {
    const connector = await machine();
    const { post, snapshot } = await browser();
    const input = { id: "directory-remove-success", deviceId: connector.deviceId, repoId: repository.repoId };
    expect((await snapshot()).machines[0]?.repositories).toEqual([
      { repoId: repository.repoId, name: repository.name, path: repository.path },
    ]);
    expect((await post(input)).status).toBe(202);
    const [cmd] = await connector.waitForCmds(1);
    expect(cmd).toMatchObject({ kind: "unregister_repo", args: { repoId: repository.repoId } });
    expect((await post(input)).status).toBe(202);
    expect(connector.cmds).toHaveLength(1);
    expect((await post({ ...input, repoId: "/srv/another" })).status).toBe(409);
    expect((await post({ ...input, deviceId: "another-device" })).status).toBe(409);

    connector.send({ t: "cmd_result", re: cmd!.id, ok: true, data: { repoId: repository.repoId } });
    expect(await operation(post, input)).toEqual({ state: "done", id: input.id, repoId: repository.repoId });
    const after = await snapshot();
    expect(after.machines[0]?.repos).toEqual([]);
    expect(after.machines[0]?.repositories).toEqual([]);
  });

  it("rejects new operations for offline, unknown and revoked machines", async () => {
    const offline = await pairFakeConnector("offline", { repos: [repository], autorun: false });
    const { post } = await browser();
    expect((await post({ id: "remove-offline", deviceId: offline.deviceId, repoId: repository.repoId })).status).toBe(409);
    expect((await post({ id: "remove-missing", deviceId: "missing", repoId: repository.repoId })).status).toBe(404);
    const revoked = await machine();
    await ownerStub().revoke(revoked.deviceId);
    expect((await post({ id: "remove-revoked", deviceId: revoked.deviceId, repoId: repository.repoId })).status).toBe(404);
  });

  it("propagates a connector refusal without removing the registration", async () => {
    const connector = await machine();
    const { post, snapshot } = await browser();
    const input = { id: "remove-refused", deviceId: connector.deviceId, repoId: repository.repoId };
    await post(input);
    const [cmd] = await connector.waitForCmds(1);
    connector.send({ t: "cmd_result", re: cmd!.id, ok: false, error: { code: "repo_worker_active" } });
    expect(await operation(post, input)).toEqual({ state: "failed", id: input.id, code: "repo_worker_active" });
    expect((await snapshot()).machines[0]?.repositories).toHaveLength(1);
  });

  it("reports an unknown outcome when the accepted command deadline elapsed", async () => {
    const connector = await machine();
    const { post } = await browser();
    const input = { id: "remove-deadline", deviceId: connector.deviceId, repoId: repository.repoId };
    await post(input);
    const [cmd] = await connector.waitForCmds(1);
    connector.send({ t: "cmd_ack", re: cmd!.id, status: "accepted" });
    await runInDurableObject(ownerStub(), (_instance: Steward, state: DurableObjectState) => {
      state.storage.sql.exec("UPDATE outbox SET notAfter = ? WHERE cmdId = ?", Date.now() - 1, `web-directory-remove:${input.id}`);
    });
    expect(await operation(post, input)).toEqual({ state: "failed", id: input.id, code: "outcome_unknown" });
  });
});
