import * as NodeAssert from "node:assert/strict";
import * as NodePath from "node:path";
import * as NodeTest from "node:test";

import { loadConfig, main } from "./fork-updater.mjs";

const assert = NodeAssert;
const path = NodePath;
const test = NodeTest.test;

const BASE = "/tmp/fork-updater-test";
const START = Date.parse("2026-10-31T12:00:00.000Z");
const OLD_VERSION = "0.1.6-luke.1";
const NEW_VERSION = "0.1.7-luke.1";

function ok(stdout = "") {
  return { status: 0, stdout, stderr: "" };
}

function failed(stderr = "", stdout = "") {
  return { status: 1, stdout, stderr };
}

function createMemoryFs(initialFiles) {
  const files = new Map();
  const directories = new Set(["/"]);
  const addParents = (file) => {
    let current = path.dirname(file);
    while (current !== "/" && current !== ".") {
      directories.add(current);
      current = path.dirname(current);
    }
  };
  for (const [file, contents] of Object.entries(initialFiles)) {
    files.set(file, String(contents));
    addParents(file);
  }
  return {
    files,
    directories,
    async exists(target) {
      return files.has(target) || directories.has(target);
    },
    async readFile(file) {
      if (!files.has(file)) {
        const error = new Error(`ENOENT: ${file}`);
        error.code = "ENOENT";
        throw error;
      }
      return files.get(file);
    },
    async writeFile(file, contents) {
      files.set(file, String(contents));
      addParents(file);
    },
    async appendFile(file, contents) {
      files.set(file, `${files.get(file) ?? ""}${contents}`);
      addParents(file);
    },
    async mkdir(directory) {
      directories.add(directory);
      addParents(directory);
    },
    async readdir(directory) {
      const names = new Set();
      for (const file of files.keys()) {
        if (path.dirname(file) === directory) names.add(path.basename(file));
      }
      for (const entry of directories) {
        if (path.dirname(entry) === directory) names.add(path.basename(entry));
      }
      return [...names];
    },
    async stat(target) {
      if (!files.has(target) && !directories.has(target)) {
        const error = new Error(`ENOENT: ${target}`);
        error.code = "ENOENT";
        throw error;
      }
      return {
        mtimeMs: 0,
        isDirectory: () => directories.has(target),
        isFile: () => files.has(target),
      };
    },
    async rm(target) {
      files.delete(target);
      directories.delete(target);
      for (const file of files.keys()) {
        if (file.startsWith(`${target}/`)) files.delete(file);
      }
      for (const directory of directories) {
        if (directory.startsWith(`${target}/`)) directories.delete(directory);
      }
    },
    async rename(from, to) {
      if (!files.has(from)) throw new Error(`ENOENT: ${from}`);
      files.set(to, files.get(from));
      files.delete(from);
      addParents(to);
    },
  };
}

function config(overrides = {}) {
  return {
    ...loadConfig({
      HOME: BASE,
      FORK_UPDATER_HOME: `${BASE}/updater`,
      T3_HOME: `${BASE}/t3home`,
      T3_BIN: `${BASE}/.local/bin/t3`,
      SERVICE_PORT: "3773",
      FORK_REPO: `${BASE}/fork`,
      FORK_BRANCH: "feat/mic-button",
      NOTIFY_PROJECT: `${BASE}/project`,
      SWITCH_MODE: "service",
      NOTIFY_MODE: "stdout",
      FORK_UPDATER_UID: "501",
    }),
    ...overrides,
  };
}

function initialState(overrides = {}) {
  return {
    version: 1,
    current: OLD_VERSION,
    previous: null,
    lastBaseTag: "v0.1.6",
    lastRun: null,
    history: [
      {
        version: OLD_VERSION,
        baseTag: "v0.1.6",
        at: "2026-10-30T12:00:00.000Z",
        result: "ok",
      },
    ],
    versionCounters: { "0.1.6": 1 },
    failed: null,
    waitingSince: null,
    waitingNotifiedFor: null,
    lastDownNotifyAt: null,
    ...overrides,
  };
}

function createHarness(options = {}) {
  const configuration = options.configuration ?? config(options.config);
  const files = {
    ...options.files,
    ...(options.state === undefined
      ? {}
      : {
          [path.join(configuration.home, "state.json")]: JSON.stringify(options.state),
        }),
  };
  const fs = createMemoryFs(files);
  const calls = [];
  const notifications = [];
  const output = [];
  let clock = options.clock ?? START;
  const env = {
    config: configuration,
    fs,
    now: () => new Date(clock),
    sleep: async (milliseconds) => {
      clock += milliseconds;
    },
    run: async (command, args, opts = {}) => {
      calls.push({ command, args: [...args], opts });
      return options.run(command, args, opts);
    },
    httpGet: async (url, opts) => options.httpGet(url, opts),
    notify: async (notification) => {
      notifications.push(notification);
    },
    out: (line) => output.push(line),
    err: (line) => output.push(line),
  };
  return {
    env,
    fs,
    config: configuration,
    calls,
    notifications,
    output,
    readState: () =>
      JSON.parse(fs.files.get(path.join(configuration.home, "state.json")) ?? "null"),
    readLog: () => fs.files.get(path.join(configuration.home, "updater.log")) ?? "",
    updateCalls: () =>
      calls.filter(({ command, args }) => command === configuration.t3Bin && args[0] === "update"),
  };
}

function makeRunner(configuration, options = {}) {
  const flags = {
    installed: options.installed ?? OLD_VERSION,
    latestTag: options.latestTag ?? "v0.1.7",
    mergeConflict: options.mergeConflict ?? null,
    typecheckFail: options.typecheckFail ?? null,
    buildFail: options.buildFail ?? false,
    busy: options.busy ?? false,
    healthDown: options.healthDown ?? options.serviceDown ?? false,
    rollbackFails: options.rollbackFails ?? false,
    sqliteFail: options.sqliteFail ?? false,
    projects: options.projects ?? [{ id: "p1", title: "Project", workspaceRoot: "/tmp/project" }],
  };
  const isVp = (command) => command === "vp" || command.endsWith("/vp");
  const run = async (command, args) => {
    if (command === "gh") return ok(`${flags.latestTag}\n`);
    if (command === "git") {
      if (args.includes("merge") && args.includes("--no-edit")) {
        if (flags.mergeConflict) {
          return {
            status: 1,
            stdout: "",
            stderr: "CONFLICT (content): Merge conflict in apps/web/src/foo.ts",
          };
        }
        return ok("Merge made by the 'ort' strategy.\n");
      }
      if (args.includes("diff") && args.includes("--diff-filter=U")) {
        return ok(`${(flags.mergeConflict ?? []).join("\n")}\n`);
      }
      if (args.includes("symbolic-ref")) return ok("feat/mic-button\n");
      return ok("");
    }
    if (isVp(command)) {
      if (args[0] === "run" && flags.typecheckFail !== null && args[2] === flags.typecheckFail) {
        return failed(
          [
            "src/one.ts:1:1 - error TS1001: first",
            "src/two.ts:2:2 - error TS1002: second",
            "src/three.ts:3:3 - error TS1003: third",
            "src/four.ts:4:4 - error TS1004: fourth",
            "src/five.ts:5:5 - error TS1005: fifth",
            "src/six.ts:6:6 - error TS9999: boom",
          ].join("\n"),
        );
      }
      return ok("");
    }
    if (command === "bash" && String(args[0]).endsWith("build-fork-archive.sh")) {
      if (flags.buildFail) return failed("error: web build failed\nmore detail\n");
      return ok("built archive\n");
    }
    if (command === "python3") return { ...ok(), pid: 4242 };
    if (command === "kill") return ok();
    if (command === "launchctl") return failed("Could not find service");
    if (command === "/usr/bin/sqlite3") {
      if (flags.sqliteFail) return failed("Error: unable to open database file");
      return ok(JSON.stringify(flags.projects));
    }
    if (command === configuration.t3Bin) {
      if (args[0] === "update") {
        const version = args[1];
        if (version === OLD_VERSION && flags.rollbackFails) {
          return failed("the cached release is missing");
        }
        flags.installed = version;
        if (version === OLD_VERSION) flags.healthDown = false;
        return ok(`Background service restarted on ${version}\n`);
      }
      if (args[0] === "service" && args[1] === "status") {
        return ok(`T3 Code service\n  Status: installed · t3@${flags.installed}\n`);
      }
      if (args[0] === "service" && args[1] === "restart") return ok();
      if (args[0] === "thread" && args[1] === "list") {
        return ok(
          JSON.stringify(
            flags.busy
              ? [{ threadId: "t1", title: "Busy thread", status: "running" }]
              : [{ threadId: "t2", title: "Done thread", status: "completed" }],
          ),
        );
      }
      if (args[0] === "thread" && args[1] === "start") {
        if (args.includes("--wait")) {
          return ok(JSON.stringify({ status: "completed", reply: "OK" }));
        }
        return ok("thread-1\n");
      }
      if (args[0] === "voice" && args[1] === "transcribe") {
        return ok("hello from the mac mini\n");
      }
      if (args[0] === "--version") return ok(`t3 v${flags.installed}\n`);
    }
    if (command.includes("/runtime/versions/") && command.endsWith("/t3")) {
      if (args[0] === "--version") return ok(`t3 v${flags.installed}\n`);
      if (args[0] === "serve") return { ...ok(), pid: 5000 };
    }
    return ok();
  };
  const httpGet = async (url) => {
    if (url.startsWith("http://127.0.0.1:3773/")) {
      return flags.healthDown ? { status: 0, body: "" } : { status: 200, body: "ok" };
    }
    return { status: 200, body: "release listing" };
  };
  return { run, httpGet, flags };
}

function createReleaseHarness(options = {}) {
  const configuration = config(options.config);
  const runner = makeRunner(configuration, options);
  return createHarness({
    configuration,
    state: options.state ?? initialState(),
    run: runner.run,
    httpGet: runner.httpGet,
    files: options.files,
  });
}

test("no new upstream release is a no-op", async () => {
  const harness = createReleaseHarness({ latestTag: "v0.1.6" });
  const result = await main(["tick"], harness.env);
  assert.equal(result.result, "noop");
  assert.equal(harness.updateCalls().length, 0);
  assert.equal(
    harness.calls.some(
      ({ command, args }) =>
        command === "bash" && String(args[0]).endsWith("build-fork-archive.sh"),
    ),
    false,
  );
  assert.equal(harness.readState().lastRun.result, "noop");
  assert.equal(harness.notifications.length, 0);
});

test("merge conflict notifies FAIL and does not switch", async () => {
  const harness = createReleaseHarness({
    mergeConflict: ["apps/web/src/foo.ts", "scripts/bar.sh"],
  });
  const result = await main(["run-now", "--force"], harness.env);
  assert.equal(result.result, "fail");
  assert.equal(harness.updateCalls().length, 0);
  assert.equal(harness.notifications.length, 1);
  assert.equal(harness.notifications[0].kind, "fail");
  assert.match(harness.notifications[0].title, /merge conflict in apps\/web\/src\/foo\.ts/);
  assert.equal(harness.readState().failed.tag, "v0.1.7");
  assert.equal(
    harness.calls.some(({ command, args }) => command === "git" && args.includes("--abort")),
    true,
  );
});

test("a typecheck failure notifies FAIL with the step and keeps the log", async () => {
  const harness = createReleaseHarness({ typecheckFail: "@t3tools/contracts" });
  const result = await main(["run-now", "--force"], harness.env);
  assert.equal(result.result, "fail");
  assert.equal(harness.updateCalls().length, 0);
  assert.equal(harness.notifications.length, 1);
  assert.match(harness.notifications[0].title, /typecheck @t3tools\/contracts failed/);
  assert.match(harness.readLog(), /TS9999: boom/);
  assert.equal(harness.readState().failed.reason, "typecheck @t3tools/contracts failed");
});

test("a build failure notifies FAIL and does not switch", async () => {
  const harness = createReleaseHarness({ buildFail: true });
  const result = await main(["run-now", "--force"], harness.env);
  assert.equal(result.result, "fail");
  assert.equal(harness.updateCalls().length, 0);
  assert.equal(harness.notifications.length, 1);
  assert.match(
    harness.notifications[0].title,
    /building release archive for 0\.1\.7-luke\.1 failed/,
  );
  assert.match(harness.readLog(), /web build failed/);
});

test("a busy thread leaves the update waiting without switching", async () => {
  const harness = createReleaseHarness({ busy: true });
  const result = await main(["run-now"], harness.env);
  assert.equal(result.result, "waiting");
  assert.equal(harness.updateCalls().length, 0);
  assert.equal(harness.notifications.length, 0);
  assert.match(harness.readLog(), /waiting for idle/);
  assert.equal(harness.readState().lastRun.result, "waiting");
  assert.notEqual(harness.readState().waitingSince, null);
});

test("the success path installs, updates state, and fast-forwards the branch", async () => {
  const harness = createReleaseHarness();
  const result = await main(["run-now", "--force"], harness.env);
  assert.equal(result.result, "ok");
  const updates = harness.updateCalls();
  assert.equal(updates.length, 1);
  assert.equal(updates[0].args[1], NEW_VERSION);
  const archive = harness.calls.find(
    ({ command, args }) => command === "bash" && String(args[0]).endsWith("build-fork-archive.sh"),
  );
  assert.equal(archive.args[2], NEW_VERSION);
  const state = harness.readState();
  assert.equal(state.current, NEW_VERSION);
  assert.equal(state.previous, OLD_VERSION);
  assert.equal(state.lastBaseTag, "v0.1.7");
  assert.equal(state.versionCounters["0.1.7"], 1);
  assert.equal(state.history.at(-1).version, NEW_VERSION);
  assert.equal(state.history.at(-1).result, "ok");
  assert.equal(harness.notifications.length, 1);
  assert.equal(harness.notifications[0].kind, "ok");
  assert.match(harness.notifications[0].title, /T3 update: 0\.1\.7-luke\.1 installed/);
  assert.equal(
    harness.calls.some(
      ({ command, args }) =>
        command === "git" && args.includes("--ff-only") && args.includes("fork/v0.1.7"),
    ),
    true,
  );
  assert.equal(
    harness.calls.some(({ command, args }) => command === "kill" && args[0] === "4242"),
    true,
  );
});

test("a health check failure rolls back and names the previous version", async () => {
  const harness = createReleaseHarness({ healthDown: true });
  const result = await main(["run-now", "--force"], harness.env);
  assert.equal(result.result, "rolled-back");
  const updates = harness.updateCalls();
  assert.equal(updates.length, 2);
  assert.equal(updates[0].args[1], NEW_VERSION);
  assert.equal(updates[1].args[1], OLD_VERSION);
  assert.equal(harness.notifications.length, 1);
  assert.equal(harness.notifications[0].kind, "fail");
  assert.match(harness.notifications[0].title, /still on 0\.1\.6-luke\.1/);
  assert.equal(harness.readState().current, OLD_VERSION);
});

test("a failed rollback notifies ROLLBACK ALSO FAILED", async () => {
  const harness = createReleaseHarness({ healthDown: true, rollbackFails: true });
  const result = await main(["run-now", "--force"], harness.env);
  assert.equal(result.result, "rollback-failed");
  assert.equal(harness.notifications.length, 1);
  assert.match(harness.notifications[0].title, /ROLLBACK ALSO FAILED/);
  assert.equal(harness.readState().lastRun.result, "fail");
});

test("a down service is restarted once and then reported", async () => {
  const harness = createReleaseHarness({ serviceDown: true });
  const result = await main(["tick"], harness.env);
  assert.equal(result.result, "down");
  const restarts = harness.calls.filter(
    ({ command, args }) =>
      command === harness.config.t3Bin && args[0] === "service" && args[1] === "restart",
  );
  assert.equal(restarts.length, 1);
  assert.equal(
    harness.calls.some(({ command }) => command === "gh"),
    false,
  );
  assert.equal(harness.notifications.length, 1);
  assert.match(harness.notifications[0].message, /T3 service is DOWN and a restart did not help/);
  assert.notEqual(harness.readState().lastDownNotifyAt, null);
});

test("a stale lock is ignored", async () => {
  const configuration = config();
  const staleAt = new Date(START - 4 * 60 * 60 * 1000).toISOString();
  const runner = makeRunner(configuration, { latestTag: "v0.1.6" });
  const harness = createHarness({
    configuration,
    state: initialState(),
    files: {
      [path.join(configuration.home, "lock")]: JSON.stringify({ pid: 1, at: staleAt }),
    },
    run: runner.run,
    httpGet: runner.httpGet,
  });
  const result = await main(["tick"], harness.env);
  assert.notEqual(result.result, "locked");
  assert.equal(
    harness.calls.some(({ command }) => command === "gh"),
    true,
  );
  assert.match(harness.readLog(), /stale lock/);
  assert.equal(harness.readState().lastRun.result, "noop");
});

test("the version counter increments per base version", async () => {
  const harness = createReleaseHarness({
    state: initialState({ versionCounters: { "0.1.6": 1, "0.1.7": 4 } }),
  });
  const result = await main(["run-now", "--force"], harness.env);
  assert.equal(result.result, "ok");
  const archive = harness.calls.find(
    ({ command, args }) => command === "bash" && String(args[0]).endsWith("build-fork-archive.sh"),
  );
  assert.equal(archive.args[2], "0.1.7-luke.5");
  assert.equal(harness.readState().versionCounters["0.1.7"], 5);
  assert.equal(harness.readState().current, "0.1.7-luke.5");
});

test("waiting for 12 hours notifies once, even across rebuilt versions", async () => {
  const waitingSince = new Date(START - 13 * 60 * 60 * 1000).toISOString();
  const harness = createReleaseHarness({
    busy: true,
    state: initialState({ waitingSince }),
  });
  const first = await main(["run-now"], harness.env);
  assert.equal(first.result, "waiting");
  assert.equal(harness.notifications.length, 1);
  assert.match(harness.notifications[0].message, /ready but threads are busy/);
  const second = await main(["run-now"], harness.env);
  assert.equal(second.result, "waiting");
  assert.equal(harness.notifications.length, 1);
});

test("a failed tag waits six hours before retrying, and run-now ignores it", async () => {
  const harness = createReleaseHarness({
    state: initialState({
      failed: {
        tag: "v0.1.7",
        at: new Date(START - 60 * 60 * 1000).toISOString(),
        reason: "typecheck @t3tools/contracts failed",
      },
    }),
  });
  const skipped = await main(["tick"], harness.env);
  assert.equal(skipped.result, "backoff");
  assert.equal(
    harness.calls.some(
      ({ command, args }) =>
        command === "bash" && String(args[0]).endsWith("build-fork-archive.sh"),
    ),
    false,
  );
  const forced = await main(["run-now", "--force"], harness.env);
  assert.equal(forced.result, "ok");
  assert.equal(harness.updateCalls().length, 1);
});

test("run-now --force skips the busy-thread wait", async () => {
  const harness = createReleaseHarness({ busy: true });
  const result = await main(["run-now", "--force"], harness.env);
  assert.equal(result.result, "ok");
  assert.equal(harness.updateCalls().length, 1);
});

test("sandbox mode updates with --base-dir and restarts the sandbox server", async () => {
  const harness = createReleaseHarness({
    config: {
      switchMode: "sandbox",
      t3Home: `${BASE}/sandbox-t3home`,
    },
    files: {
      [`${BASE}/updater/sandbox.pid`]: "4242\n",
    },
  });
  const result = await main(["run-now", "--force"], harness.env);
  assert.equal(result.result, "ok");
  const update = harness.updateCalls()[0];
  assert.equal(update.args.includes("--base-dir"), true);
  assert.equal(update.args[update.args.indexOf("--base-dir") + 1], `${BASE}/sandbox-t3home`);
  const serve = harness.calls.find(
    ({ command, args }) => command.includes("/runtime/versions/") && args[0] === "serve",
  );
  assert.notEqual(serve, undefined);
  assert.deepEqual(serve.args, [
    "serve",
    "--host",
    "127.0.0.1",
    "--port",
    "3773",
    "--base-dir",
    `${BASE}/sandbox-t3home`,
    "--no-browser",
  ]);
  assert.equal(
    harness.calls.some(({ command, args }) => command === "kill" && args[0] === "4242"),
    true,
  );
  assert.equal(harness.readState().current, NEW_VERSION);
});

test("the default t3 binary is the pinned runtime launcher", () => {
  const loaded = loadConfig({ HOME: "/Users/example" });
  assert.equal(loaded.t3Bin, "/Users/example/.local/bin/t3");
});

test("status shows the t3 binary it would run", async () => {
  const harness = createReleaseHarness();
  const result = await main(["status"], harness.env);
  assert.equal(result.exitCode, 0);
  assert.equal(
    harness.output.join("\n").split("\n").includes(`  t3 binary: ${harness.config.t3Bin}`),
    true,
  );
});

test("busy reads projects from the sqlite database and lists busy threads", async () => {
  const harness = createReleaseHarness({ busy: true });
  const result = await main(["busy"], harness.env);
  assert.equal(result.exitCode, 0);
  const sqlite = harness.calls.find(({ command }) => command === "/usr/bin/sqlite3");
  assert.notEqual(sqlite, undefined);
  assert.deepEqual(sqlite.args.slice(0, 3), [
    "-readonly",
    `file:${BASE}/t3home/userdata/statev2.sqlite?mode=ro`,
    "-json",
  ]);
  assert.match(sqlite.args[3], /from projection_projects/);
  const threadList = harness.calls.find(
    ({ command, args }) =>
      command === harness.config.t3Bin && args[0] === "thread" && args[1] === "list",
  );
  assert.deepEqual(threadList.args, ["thread", "list", "--project", "p1", "--json"]);
  assert.equal(
    harness.calls.some(
      ({ command, args }) => command === harness.config.t3Bin && args[0] === "project",
    ),
    false,
  );
  assert.deepEqual(JSON.parse(harness.output.join("\n")), [
    { project: "Project", title: "Busy thread", status: "running" },
  ]);
});

test("a failed sqlite read falls back to checking only the notify project", async () => {
  const harness = createReleaseHarness({ sqliteFail: true });
  const result = await main(["run-now"], harness.env);
  assert.equal(result.result, "ok");
  assert.match(harness.readLog(), /could not read projects .*checking only .*project/);
  const threadList = harness.calls.find(
    ({ command, args }) =>
      command === harness.config.t3Bin && args[0] === "thread" && args[1] === "list",
  );
  assert.equal(
    threadList.args[threadList.args.indexOf("--project") + 1],
    harness.config.notifyProject,
  );
  assert.equal(
    harness.calls.some(
      ({ command, args }) => command === harness.config.t3Bin && args[0] === "project",
    ),
    false,
  );
});

test("sandbox mode checks nothing when its database is absent", async () => {
  const harness = createReleaseHarness({
    config: { switchMode: "sandbox", t3Home: `${BASE}/sandbox-t3home` },
  });
  const result = await main(["busy"], harness.env);
  assert.equal(result.exitCode, 0);
  assert.equal(harness.output.at(-1), "[]");
  assert.equal(
    harness.calls.some(({ command }) => command === "/usr/bin/sqlite3"),
    false,
  );
  assert.equal(
    harness.calls.some(
      ({ command, args }) => command === harness.config.t3Bin && args[0] === "thread",
    ),
    false,
  );
});

test("sandbox mode reads its own database when present", async () => {
  const harness = createReleaseHarness({
    busy: true,
    config: { switchMode: "sandbox", t3Home: `${BASE}/sandbox-t3home` },
    files: {
      [`${BASE}/sandbox-t3home/userdata/statev2.sqlite`]: "",
    },
  });
  const result = await main(["busy"], harness.env);
  assert.equal(result.exitCode, 0);
  const sqlite = harness.calls.find(({ command }) => command === "/usr/bin/sqlite3");
  assert.equal(sqlite.args[1], `file:${BASE}/sandbox-t3home/userdata/statev2.sqlite?mode=ro`);
  assert.deepEqual(JSON.parse(harness.output.join("\n")), [
    { project: "Project", title: "Busy thread", status: "running" },
  ]);
});

test("every external command in the pipeline carries a timeout", async () => {
  const harness = createReleaseHarness();
  const result = await main(["run-now", "--force"], harness.env);
  assert.equal(result.result, "ok");
  const untimed = harness.calls.filter(({ opts }) => typeof opts?.timeoutMs !== "number");
  assert.deepEqual(untimed, []);
});

test("an unexpected tick error is logged and notifies at most once per six hours", async () => {
  const configuration = config();
  const runner = makeRunner(configuration);
  const harness = createHarness({
    configuration,
    state: initialState(),
    run: runner.run,
    httpGet: async () => {
      throw new Error("boom");
    },
  });
  const first = await main(["tick"], harness.env);
  assert.equal(first.result, "crashed");
  assert.equal(first.exitCode, 1);
  assert.match(harness.readLog(), /unexpected error during tick/);
  assert.match(harness.readLog(), /boom/);
  assert.equal(harness.notifications.length, 1);
  assert.equal(harness.notifications[0].kind, "fail");
  assert.notEqual(harness.readState().lastCrashNotifyAt, null);

  const second = await main(["tick"], harness.env);
  assert.equal(second.result, "crashed");
  assert.equal(harness.notifications.length, 1);

  const later = createHarness({
    configuration,
    state: harness.readState(),
    clock: START + 7 * 60 * 60 * 1000,
    run: runner.run,
    httpGet: async () => {
      throw new Error("boom again");
    },
  });
  const third = await main(["tick"], later.env);
  assert.equal(third.result, "crashed");
  assert.equal(later.notifications.length, 1);
  assert.match(later.notifications[0].message, /boom again/);
});

test("SANDBOX-FINDINGS.txt selects the version scheme", async () => {
  const harness = createReleaseHarness({
    files: {
      [`${BASE}/fork/scripts/fork-updater/SANDBOX-FINDINGS.txt`]:
        "Version scheme: {base}+luke.{n}\n",
    },
  });
  const result = await main(["run-now", "--force"], harness.env);
  assert.equal(result.result, "ok");
  const archive = harness.calls.find(
    ({ command, args }) => command === "bash" && String(args[0]).endsWith("build-fork-archive.sh"),
  );
  assert.equal(archive.args[2], "0.1.7+luke.1");
  assert.equal(harness.readState().current, "0.1.7+luke.1");
});
