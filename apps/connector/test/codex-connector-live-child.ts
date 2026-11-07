// Bundled into the test's temporary directory; IPC is lifecycle-only, never a command seam.
import { join } from "node:path";
import { ConnectorApp } from "../src/connector-app.ts";
import { CodexAdapter, detectCodex } from "../src/codex-adapter.ts";
import { LocalStore } from "../src/store.ts";

const stateDir = process.argv[2]!;
const command = [process.env.ORBIT_CODEX_COMMAND || "codex"];
const version = detectCodex(command);
if (!version.installed) throw new Error(`Real Codex unavailable: ${version.diagnostic}`);
const store = new LocalStore(join(stateDir, "connector.sqlite"));
const app = new ConnectorApp({
  store, stateDir,
  adapters: [new CodexAdapter({ command, version: version.version, requestTimeoutMs: 30_000 })],
  log: (event, fields) => console.log(JSON.stringify({ event, ...fields })),
});
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  for (const worker of store.listWorkers()) await app.manager.stopProcess(worker.workerId);
  app.stop();
  store.close();
  process.exit(0);
}
process.on("SIGTERM", () => void stop().catch((error) => { console.error(error); process.exit(1); }));
process.on("SIGINT", () => void stop().catch((error) => { console.error(error); process.exit(1); }));
await app.start();
process.send?.({ type: "ready", pid: process.pid, version: version.version });
