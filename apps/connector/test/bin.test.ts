// Subprocess tests against the built bin (bin/orbit.js → dist/cli.js), which pretest
// builds. This is the `npx @sclfcz/orbit` surface: the Node gate, --version, usage, and
// the read-only subcommands on a clean SIG_HOME.
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeGitRepo } from "./helpers.ts";
import { VERSION } from "../src/version.ts";
import { LocalStore } from "../src/store.ts";

const exec = promisify(execFile);
const bin = join(import.meta.dirname, "..", "bin", "orbit.js");

let home: string;
let stateDir: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "sig-bin-home-"));
  stateDir = mkdtempSync(join(tmpdir(), "sig-bin-state-"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(stateDir, { recursive: true, force: true });
});

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

function run(args: string[], extraEnv: Record<string, string | undefined> = {}): Promise<RunResult> {
  return exec(process.execPath, [bin, ...args], {
    env: { ...process.env, HOME: home, SIG_HOME: stateDir, ...extraEnv },
    timeout: 30_000,
  }).then(
    ({ stdout, stderr }) => ({ code: 0, stdout, stderr }),
    (err: { code?: number; stdout?: string; stderr?: string }) => ({
      code: err.code ?? 1,
      stdout: err.stdout ?? "",
      stderr: err.stderr ?? "",
    }),
  );
}

function seedRegisteredRepo(repo: string, directory = stateDir): void {
  const path = realpathSync(repo);
  const store = new LocalStore(join(directory, "connector.sqlite"));
  try {
    store.addRepo({ repoId: path, name: basename(path), path, capability: { kind: "git", gitRoot: path, defaultBranch: "main", remote: null } });
  } finally {
    store.close();
  }
}

/** A `codex` executable for PATH-based discovery; optionally pins a fake version. */
function fakeCodexBin(version?: string): string {
  const dir = join(home, "codex-bin");
  mkdirSync(dir, { recursive: true });
  const fake = join(import.meta.dirname, "fake-codex.mjs");
  const pin = version ? ` --fake-version="codex-cli ${version}"` : "";
  writeFileSync(join(dir, "codex"), `#!/bin/sh\nexec "${process.execPath}" "${fake}" "$@"${pin}\n`, { mode: 0o755 });
  return dir;
}

/** A `pi` executable that answers `--version` like the real CLI; `exitCode` makes it fail. */
function fakePiBin(dir = join(home, "pi-bin"), exitCode = 0): string {
  mkdirSync(dir, { recursive: true });
  const body = exitCode === 0 ? "echo 1.2.0" : `echo "Error: Cannot find module 'dist/bundle/cli.js'" >&2\nexit ${exitCode}`;
  writeFileSync(join(dir, "pi"), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return dir;
}

/** Writes the installed unit shape each service manager uses, recording `path`. */
function seedServicePath(path: string): void {
  if (process.platform === "darwin") {
    const dir = join(home, "Library", "LaunchAgents");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "dev.sig.connector.plist"),
      `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>dev.sig.connector</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>${path}</string>
    </dict>
</dict>
</plist>
`,
    );
  } else if (process.platform === "linux") {
    const dir = join(home, ".config", "systemd", "user");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "dev.sig.connector.service"),
      `[Service]\nEnvironment="PATH=${path}"\n`,
    );
  } else {
    throw new Error(`unsupported test platform: ${process.platform}`);
  }
}

function seedCredentials(serverUrl: string): void {
  const store = new LocalStore(join(stateDir, "connector.sqlite"));
  try {
    store.saveCredentials({ serverUrl, deviceId: "dev_test", token: "test-token" });
  } finally {
    store.close();
  }
}

async function withReachableSteward(body: (url: string) => Promise<void>): Promise<void> {
  const server = createServer((_req, res) => {
    res.writeHead(401, { "content-type": "text/plain" });
    res.end("login required");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("expected a TCP address");
  try {
    await body(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe("bin/orbit.js (skipped when dist has not been built)", () => {
  beforeEach(() => {
    if (!existsSync(join(import.meta.dirname, "..", "dist", "cli.js"))) {
      throw new Error("dist/cli.js missing; run `npm run build` (pretest does this)");
    }
  });

  it("prints the version", async () => {
    const res = await run(["--version"]);
    expect(res.stdout.trim()).toBe(VERSION);
  });

  it("prints usage and exits 2 for unknown commands", async () => {
    const res = await run(["bogus"]);
    expect(res.code).toBe(2);
    expect(res.stderr).toContain("usage:");
    expect(res.stderr).toContain("connect");
  });

  it("directs registration to the web workspace in help", async () => {
    const res = await run(["--help"]);
    expect(res.code).toBe(0);
    expect(res.stderr).toContain("Machines > Add directory");
    expect(res.stderr).not.toContain("add-repo");
  });

  it("rejects add-repo without creating local state", async () => {
    const repo = await makeGitRepo(home);
    const res = await run(["add-repo", repo]);
    expect(res.code).toBe(2);
    expect(res.stderr).toContain("Machines > Add directory");
    expect(existsSync(join(stateDir, "connector.sqlite"))).toBe(false);
    expect(existsSync(join(home, ".sig", "connector.sqlite"))).toBe(false);
  });

  it("rejects add-repo without changing existing registrations or local settings", async () => {
    const repo = await makeGitRepo(home);
    seedRegisteredRepo(repo);
    const store = new LocalStore(join(stateDir, "connector.sqlite"));
    try {
      store.setWritePolicy(realpathSync(repo), { concurrency: "serial" });
      store.setApproved(realpathSync(repo), true);
      const before = store.listRepos();
      const newRepo = await makeGitRepo(home, "repo-b");
      expect((await run(["add-repo", newRepo])).code).toBe(2);
      expect((await run(["add-repo", repo])).code).toBe(2);
      expect(store.listRepos()).toEqual(before);
    } finally {
      store.close();
    }
  });

  it("status on a clean machine reports unpaired and not installed", async () => {
    const res = await run(["status"]);
    expect(res.code).toBe(0);
    expect(res.stdout).toContain(`orbit ${VERSION}`);
    expect(res.stdout).toContain("not installed");
    expect(res.stdout).toContain("not paired");
  });

  it("doctor reports pi for this shell and for the installed service PATH", async () => {
    const binPath = fakePiBin();
    seedServicePath(binPath);
    const res = await run(["doctor"], { PATH: binPath });

    expect(res.stdout).toMatch(/pi \(this shell\):\s+1\.2\.0/);
    expect(res.stdout).toMatch(/pi \(service PATH\):\s+1\.2\.0/);
    expect(res.stdout).not.toContain("pi-coding-agent");
    expect(res.stdout).not.toContain("orbit upgrade");
  });

  it("doctor explains how to install a missing pi", async () => {
    // An interrupted global install leaves a dangling `pi` link: spawn sees ENOENT.
    const empty = join(home, "no-pi");
    mkdirSync(empty);
    symlinkSync(join(home, "gone", "cli.js"), join(empty, "pi"));
    seedServicePath(empty);
    const res = await run(["doctor"], { PATH: empty });

    expect(res.stdout).toMatch(/pi \(this shell\):\s+not found/);
    expect(res.stdout).toMatch(/pi \(service PATH\):\s+not found/);
    expect(res.stdout).toContain("pi (the default agent) is not on this shell's PATH");
    expect(res.stdout).toContain("`npm install -g @earendil-works/pi-coding-agent`");
    expect(res.stdout).toContain(`once \`pi --version\` works here, run \`orbit upgrade --version ${VERSION}\` from this shell`);
  });

  it("doctor explains how to refresh a service PATH that misses pi", async () => {
    const binPath = fakePiBin();
    const empty = join(home, "empty-path");
    mkdirSync(empty);
    seedServicePath(empty);
    const res = await run(["doctor"], { PATH: binPath });

    expect(res.stdout).toMatch(/pi \(this shell\):\s+1\.2\.0/);
    expect(res.stdout).toMatch(/pi \(service PATH\):\s+not found/);
    expect(res.stdout).toContain(
      `pi works in this shell but not on the installed service PATH — if it was installed after the service, run \`orbit upgrade --version ${VERSION}\` from this shell`,
    );
    expect(res.stdout).not.toContain("pi-coding-agent");
  });

  it("doctor reports a pi that is on PATH but does not run", async () => {
    const binPath = fakePiBin(join(home, "broken-pi"), 1);
    seedServicePath(binPath);
    const res = await run(["doctor"], { PATH: binPath });

    expect(res.stdout).toMatch(/pi \(this shell\):\s+broken — pi --version exited 1: Error: Cannot find module/);
    expect(res.stdout).toMatch(/pi \(service PATH\):\s+broken — pi --version exited 1/);
    expect(res.stdout).toContain("pi is on this shell's PATH but does not run");
    expect(res.stdout).toContain("`npm install -g @earendil-works/pi-coding-agent`");
  });

  it("doctor reports Codex for this shell and for the installed service PATH", async () => {
    const binPath = fakeCodexBin();
    seedServicePath(binPath);
    const res = await run(["doctor"], { PATH: binPath });

    expect(res.stdout).toMatch(/codex \(this shell\):\s+codex-cli 0\.166\.0-alpha\.6/);
    expect(res.stdout).toMatch(/codex \(service PATH\):\s+codex-cli 0\.166\.0-alpha\.6/);
    expect(res.stdout).not.toContain("codex works in this shell but not on the installed service PATH");
  });

  it("doctor explains how to refresh a service PATH that misses Codex", async () => {
    const binPath = fakeCodexBin();
    const empty = join(home, "empty-path");
    mkdirSync(empty);
    seedServicePath(empty);
    const res = await run(["doctor"], { PATH: binPath });

    expect(res.stdout).toMatch(/codex \(this shell\):\s+codex-cli 0\.166\.0-alpha\.6/);
    expect(res.stdout).toMatch(/codex \(service PATH\):\s+not found/);
    expect(res.stdout).toContain(`run \`orbit upgrade --version ${VERSION}\` from this shell`);
    expect(res.stdout).toContain("for a source install, repeat the source install steps");
    expect(res.stdout).toContain("`orbit restart` keeps the recorded PATH");
  });

  it("doctor reports an incompatible Codex version in either environment", async () => {
    const binPath = fakeCodexBin("0.168.0");
    seedServicePath(binPath);
    const res = await run(["doctor"], { PATH: binPath });

    expect(res.stdout).toMatch(/codex \(this shell\):\s+incompatible — Unsupported Codex CLI protocol: codex-cli 0\.168\.0/);
    expect(res.stdout).toMatch(/codex \(service PATH\):\s+incompatible — Unsupported Codex CLI protocol: codex-cli 0\.168\.0/);
  });

  it("doctor readiness and exit code do not depend on Codex or pi", async () => {
    await withReachableSteward(async (url) => {
      seedCredentials(url);
      const binPath = fakeCodexBin();
      seedServicePath(binPath);
      const withCodex = await run(["doctor"], { PATH: binPath });
      expect(withCodex.code).toBe(0);
      expect(withCodex.stdout).toMatch(/codex \(this shell\):\s+codex-cli 0\.166\.0-alpha\.6/);

      const empty = join(home, "no-codex");
      mkdirSync(empty);
      seedServicePath(empty);
      const withoutCodex = await run(["doctor"], { PATH: empty });
      expect(withoutCodex.code).toBe(withCodex.code);
      expect(withoutCodex.stdout).toMatch(/codex \(this shell\):\s+not found/);
      expect(withoutCodex.stdout).toMatch(/codex \(service PATH\):\s+not found/);
      expect(withoutCodex.stdout).toMatch(/pi \(this shell\):\s+not found/);
    });
  });

  it("daemon without credentials exits 1 with a pairing hint", async () => {
    const res = await run(["daemon"]);
    expect(res.code).toBe(1);
    expect(res.stderr).toContain("connect");
  });

  it("logs without a log file exits 1 and lists what exists", async () => {
    const res = await run(["logs"]);
    expect(res.code).toBe(1);
    expect(res.stderr).toContain("no log file");
  });

  it("SIG_HOME overrides the ~/.sig default", async () => {
    const repo = await makeGitRepo(home);
    const defaultRepo = await makeGitRepo(home, "default-repo");
    seedRegisteredRepo(repo);
    seedRegisteredRepo(defaultRepo, join(home, ".sig"));
    const res = await run(["status"]);
    expect(res.code).toBe(0);
    expect(res.stdout).toContain("repo-a");
    expect(res.stdout).not.toContain("default-repo");
  });

  it("continues using ~/.sig when no home setting is present", async () => {
    const repo = await makeGitRepo(home);
    const customRepo = await makeGitRepo(home, "custom-repo");
    seedRegisteredRepo(repo, join(home, ".sig"));
    seedRegisteredRepo(customRepo);
    const res = await run(["status"], { SIG_HOME: undefined });
    expect(res.code).toBe(0);
    expect(res.stdout).toContain("repo-a");
    expect(res.stdout).not.toContain("custom-repo");
  });

  it("repo-config sets and shows the per-repo local settings (§8.2/§13, issue #16)", async () => {
    const repo = await makeGitRepo(home);

    // Not registered yet: refuse with the hint, never auto-register via a config call.
    const unregistered = await run(["repo-config", repo, "--concurrency", "serial"]);
    expect(unregistered.code).toBe(1);
    expect(unregistered.stderr).toContain("not registered");
    expect(unregistered.stderr).toContain("Machines > Add directory");
    const store = new LocalStore(join(stateDir, "connector.sqlite"));
    try {
      expect(store.listRepos()).toEqual([]);
    } finally {
      store.close();
    }

    seedRegisteredRepo(repo);

    // Invalid value is rejected with the valid vocabulary.
    const bad = await run(["repo-config", repo, "--isolation", "sometimes"]);
    expect(bad.code).toBe(1);
    expect(bad.stderr).toContain("worktree | in-place");

    const set = await run(["repo-config", repo, "--concurrency", "serial", "--approve"]);
    expect(set.code).toBe(0);
    expect(set.stdout).toContain("concurrency=serial");
    expect(set.stdout).toContain("approved=yes");

    // No flags: print the current configuration.
    const show = await run(["repo-config", repo]);
    expect(show.code).toBe(0);
    expect(show.stdout).toContain("capability:");
    expect(show.stdout).toContain("concurrency: serial");
    expect(show.stdout).toContain("--approve");

    // And status surfaces the per-repo settings.
    const status = await run(["status"]);
    expect(status.stdout).toContain("repo-a[worktree/serial, approved]");
  });

  it("repo-config parses flags in any position and both --isolation/--concurrency spellings (review finding 4)", async () => {
    const repo = await makeGitRepo(home);
    seedRegisteredRepo(repo);

    // Flags before the path: the path is still the path.
    const flagsFirst = await run(["repo-config", "--isolation", "in-place", repo]);
    expect(flagsFirst.code).toBe(0);
    expect(flagsFirst.stdout).toContain("isolation=in-place");

    // The --flag=value form is honored, not silently ignored.
    const eqForm = await run(["repo-config", repo, "--concurrency=serial"]);
    expect(eqForm.code).toBe(0);
    expect(eqForm.stdout).toContain("concurrency=serial");

    // A valueless --isolation and unknown flags fail loudly instead of degrading into a
    // read-only print with exit 0.
    const missingValue = await run(["repo-config", repo, "--isolation"]);
    expect(missingValue.code).toBe(1);
    expect(missingValue.stderr).toContain("requires a value");
    const unknown = await run(["repo-config", repo, "--isolationx"]);
    expect(unknown.code).toBe(1);
    expect(unknown.stderr).toContain("unknown option");
  });
});
