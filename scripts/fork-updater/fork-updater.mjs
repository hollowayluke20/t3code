#!/usr/bin/env node
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

const fs = NodeFSP;
const path = NodePath;

const HOUR_MS = 60 * 60 * 1000;
const LOCK_STALE_MS = 3 * HOUR_MS;
const FAILED_TAG_RETRY_MS = 6 * HOUR_MS;
const BUSY_WAIT_NOTIFY_MS = 12 * HOUR_MS;
const HEALTH_TIMEOUT_MS = 150_000;
const DEFAULT_RUN_TIMEOUT_MS = 5 * 60_000;
const SQLITE3_BIN = "/usr/bin/sqlite3";
const PROJECTS_QUERY =
  "select project_id as id, title, workspace_root as workspaceRoot from projection_projects";
const BUSY_THREAD_STATUSES = new Set(["preparing", "queued", "starting", "running", "waiting"]);
const HISTORY_LIMIT = 50;
const FOCUSED_TEST_STEP = "focused voice, permission, and contract tests";
const FOCUSED_TEST_PATHS = [
  "apps/server/src/voice",
  "apps/web/src/voice",
  "apps/desktop/src/permissions",
  "packages/contracts",
];
const FAILURE_LINE_PATTERN =
  /(?:\b(?:FAIL|FAILED|Error|AssertionError|TypeError|error TS\d+)\b|✗|×)/;
const TEST_SUMMARY_PATTERN = /^(?:Test Files|Tests)\b/;
const MAX_FAILURE_SUMMARY_LINES = 6;
const MAX_FAILURE_LINE_LENGTH = 160;
const MAX_SHORT_REASON_LENGTH = 70;

const DEFAULTS = {
  forkUpdaterHome: "~/.t3-fork-updater",
  t3Home: "~/.t3",
  t3Bin: "~/.local/bin/t3",
  servicePort: 3773,
  forkRepo: "~/Development/t3code-luke",
  forkBranch: "feat/mic-button",
  upstreamRepo: "pingdotgg/t3code",
  notifyProject: "/Users/adminaccount/Development/grad-application-pipeline",
  switchMode: "service",
  notifyMode: "real",
  testWav: "~/Development/grad-pipeline-private/lanes/t3mic-fixtures/hello-from-the-mac-mini.wav",
  whisperBin: "~/Development/whisper.cpp/build/bin/whisper-cli",
  whisperModel: "~/.t3-voice/models/ggml-small.en.bin",
  toolsVp: "~/Development/t3code-tools/node_modules/.bin/vp",
  launchdLabel: "com.lukeholloway.t3-fork-updater",
};

const NO_RUN = "noop";

export function expandHome(value, home) {
  if (typeof value !== "string") return value;
  if (value === "~") return home;
  if (value.startsWith("~/")) return path.join(home, value.slice(2));
  return value;
}

export function loadConfig(envVars = process.env) {
  const home = envVars.HOME || NodeOS.homedir();
  const read = (name, fallback) => {
    const value = envVars[name];
    return value === undefined || value === "" ? fallback : value;
  };
  return {
    home: expandHome(read("FORK_UPDATER_HOME", DEFAULTS.forkUpdaterHome), home),
    t3Home: expandHome(read("T3_HOME", DEFAULTS.t3Home), home),
    t3Bin: expandHome(read("T3_BIN", DEFAULTS.t3Bin), home),
    servicePort: Number(read("SERVICE_PORT", String(DEFAULTS.servicePort))),
    forkRepo: expandHome(read("FORK_REPO", DEFAULTS.forkRepo), home),
    forkBranch: read("FORK_BRANCH", DEFAULTS.forkBranch),
    upstreamRepo: read("UPSTREAM_REPO", DEFAULTS.upstreamRepo),
    notifyProject: expandHome(read("NOTIFY_PROJECT", DEFAULTS.notifyProject), home),
    switchMode: read("SWITCH_MODE", DEFAULTS.switchMode),
    notifyMode: read("NOTIFY_MODE", DEFAULTS.notifyMode),
    testWav: expandHome(read("FORK_TEST_WAV", DEFAULTS.testWav), home),
    whisperBin: expandHome(read("T3CODE_WHISPER_BIN", DEFAULTS.whisperBin), home),
    whisperModel: expandHome(read("T3CODE_WHISPER_MODEL", DEFAULTS.whisperModel), home),
    toolsVp: expandHome(read("FORK_TOOLS_VP", DEFAULTS.toolsVp), home),
    launchdLabel: read("FORK_UPDATER_LABEL", DEFAULTS.launchdLabel),
    uid: Number(read("FORK_UPDATER_UID", String(process.getuid?.() ?? 0))),
    homeDir: home,
  };
}

function statePath(config) {
  return path.join(config.home, "state.json");
}

function logPath(config) {
  return path.join(config.home, "updater.log");
}

function lockPath(config) {
  return path.join(config.home, "lock");
}

function buildsDir(config) {
  return path.join(config.home, "builds");
}

function releasesDir(config) {
  return path.join(config.home, "releases");
}

function emptyState() {
  return {
    version: 1,
    current: null,
    previous: null,
    lastBaseTag: null,
    lastRun: null,
    history: [],
    versionCounters: {},
    failed: null,
    waitingSince: null,
    waitingNotifiedFor: null,
    lastDownNotifyAt: null,
    lastCrashNotifyAt: null,
  };
}

function normalizeState(parsed) {
  const base = emptyState();
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return base;
  return {
    ...base,
    ...parsed,
    history: Array.isArray(parsed.history) ? parsed.history : [],
    versionCounters:
      parsed.versionCounters !== null &&
      typeof parsed.versionCounters === "object" &&
      !Array.isArray(parsed.versionCounters)
        ? parsed.versionCounters
        : {},
  };
}

function createLogger(env) {
  const write = async (level, message) => {
    const line = `[${env.now().toISOString()}] ${level} ${message}\n`;
    try {
      await env.fs.mkdir(env.config.home);
      await env.fs.appendFile(logPath(env.config), line);
    } catch {
      // Logging must never take the updater down.
    }
  };
  return {
    info: (message) => write("INFO", message),
    warn: (message) => write("WARN", message),
    error: (message) => write("ERROR", message),
    step: (message) => write("STEP", message),
  };
}

const silentLogger = {
  info: async () => {},
  warn: async () => {},
  error: async () => {},
  step: async () => {},
};

function stderrLogger(env) {
  return {
    info: async () => {},
    step: async () => {},
    warn: async (message) => printErr(env, `WARN ${message}`),
    error: async (message) => printErr(env, `ERROR ${message}`),
  };
}

async function loadState(env, logger = silentLogger) {
  const file = statePath(env.config);
  if (!(await env.fs.exists(file))) return emptyState();
  try {
    return normalizeState(JSON.parse(await env.fs.readFile(file)));
  } catch (error) {
    await logger.error(`state.json could not be read (${error.message}); starting from defaults`);
    return emptyState();
  }
}

async function saveState(env, state) {
  const file = statePath(env.config);
  const temp = `${file}.tmp`;
  state.updatedAt = env.now().toISOString();
  if (state.history.length > HISTORY_LIMIT) {
    state.history = state.history.slice(-HISTORY_LIMIT);
  }
  await env.fs.mkdir(env.config.home);
  await env.fs.writeFile(temp, `${JSON.stringify(state, null, 2)}\n`);
  await env.fs.rename(temp, file);
}

function combineOutput(result) {
  return [result.stdout ?? "", result.stderr ?? ""].filter((part) => part !== "").join("\n");
}

export function lastLines(text, count = 5) {
  const lines = String(text ?? "")
    .trimEnd()
    .split(/\r?\n/)
    .filter((line) => line.trim() !== "");
  return lines.slice(-count);
}

function summarizeLine(line) {
  return line.trim().slice(0, MAX_FAILURE_LINE_LENGTH);
}

export function firstLines(text, count = 3) {
  const lines = String(text ?? "")
    .split(/\r?\n/)
    .map(summarizeLine)
    .filter((line) => line !== "");
  return lines.slice(0, count);
}

export function summarizeFailure(output) {
  const lines = String(output ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "");

  const summaryLines = [];
  let testFiles = null;
  let tests = null;
  for (const line of lines) {
    if (!TEST_SUMMARY_PATTERN.test(line)) continue;
    if (/^Test Files\b/.test(line)) testFiles = summarizeLine(line);
    else tests = summarizeLine(line);
  }
  if (testFiles) summaryLines.push(testFiles);
  if (tests && tests !== testFiles) summaryLines.push(tests);

  const seen = new Set(summaryLines);
  const matches = [];
  for (const line of lines) {
    if (!FAILURE_LINE_PATTERN.test(line)) continue;
    const candidate = summarizeLine(line);
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    matches.push(candidate);
  }

  const room = Math.max(0, MAX_FAILURE_SUMMARY_LINES - summaryLines.length);
  const selected = matches.slice(0, room);
  if (selected.length + summaryLines.length > 0) return [...selected, ...summaryLines];
  return lines.slice(-5).map(summarizeLine);
}

function oneLine(text) {
  return String(text ?? "")
    .replace(/\s*\n+\s*/g, " ")
    .trim();
}

function shortFailureReason(text) {
  const flat = oneLine(text);
  if (flat.length <= MAX_SHORT_REASON_LENGTH) return flat;
  return `${flat.slice(0, MAX_SHORT_REASON_LENGTH - 1).trimEnd()}…`;
}

function failureTitle(reason, oldVersion) {
  return `T3 update FAILED: ${shortFailureReason(reason)}, still on ${oldVersion}`;
}

function recoveryInstructions() {
  return [
    "Retry: node scripts/fork-updater/fork-updater.mjs run-now",
    "Roll back: node scripts/fork-updater/fork-updater.mjs rollback",
    "Reply to acknowledge in one short line.",
  ];
}

function failedTestPath(output) {
  const lines = String(output ?? "").split(/\r?\n/);
  for (const candidate of FOCUSED_TEST_PATHS) {
    if (lines.some((line) => line.includes("FAIL") && line.includes(candidate))) {
      return candidate;
    }
  }
  return null;
}

function describeStepFailure(step, output) {
  if (step.startsWith("typecheck ")) {
    const packageName = step.slice("typecheck ".length);
    return { reason: `${step} failed`, shortReason: `typecheck failed (${packageName})` };
  }
  if (step === FOCUSED_TEST_STEP) {
    const failedPath = failedTestPath(output);
    return {
      reason: `${step} failed`,
      shortReason: failedPath ? `tests failed (${failedPath})` : "tests failed",
    };
  }
  if (step.startsWith("building release archive")) {
    return { reason: `${step} failed`, shortReason: "build failed" };
  }
  if (step.startsWith("t3 update")) {
    return { reason: `${step} failed`, shortReason: "install failed" };
  }
  if (step.startsWith("installing dependencies")) {
    return { reason: `${step} failed`, shortReason: "dependency install failed" };
  }
  if (step.startsWith("locate the build vp")) {
    return { reason: `${step} failed`, shortReason: "build vp missing after install" };
  }
  if (step === "release server") {
    return { reason: `${step} failed`, shortReason: "release server failed" };
  }
  return { reason: `${step} failed`, shortReason: `${step} failed` };
}

async function bestEffort(logger, label, action) {
  try {
    return await action();
  } catch (error) {
    await logger.warn(`${label}: ${error.message}`);
    return undefined;
  }
}

class StepFailure extends Error {
  constructor(step, output, detail) {
    super(detail ?? `${step} failed`);
    this.name = "StepFailure";
    this.step = step;
    this.output = output;
  }
}

class MergeConflict extends Error {
  constructor(files, output) {
    const detail = files.length > 0 ? files.join(", ") : "unknown files";
    super(`merge conflict in ${detail}`);
    this.name = "MergeConflict";
    this.files = files;
    this.output = output;
  }
}

class HealthFailure extends Error {
  constructor(reason, detail = "") {
    super(detail ? `${reason}: ${detail}` : reason);
    this.name = "HealthFailure";
    this.reason = reason;
    this.detail = detail;
  }
}

export function parseStableTag(tag) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(String(tag ?? "").trim());
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function compareStableTags(left, right) {
  const a = parseStableTag(left);
  const b = parseStableTag(right);
  if (a === null) return b === null ? 0 : -1;
  if (b === null) return 1;
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] < b[index] ? -1 : 1;
  }
  return 0;
}

function isNewerTag(tag, lastBaseTag) {
  if (lastBaseTag === null || lastBaseTag === undefined || lastBaseTag === "") return true;
  return compareStableTags(tag, lastBaseTag) > 0;
}

function sanitizeScheme(value) {
  return String(value ?? "")
    .trim()
    .replace(/^["'`]+/, "")
    .replace(/["'`]+$/, "")
    .trim();
}

export function parseVersionScheme(text) {
  const lines = String(text ?? "").split(/\r?\n/);
  for (const line of lines) {
    const match = /^\s*(?:VERSION[\s_-]*)?SCHEME\s*[=:]\s*(.+?)\s*$/i.exec(line);
    if (match) return sanitizeScheme(match[1]);
  }
  for (const line of lines) {
    const match = /^\s*(?:VERSION[\s_-]*)?SUFFIX\s*[=:]\s*(.+?)\s*$/i.exec(line);
    if (match) {
      const suffix = sanitizeScheme(match[1]).replace(/[.]+$/, "");
      return `{base}${suffix}.{n}`;
    }
  }
  return null;
}

export function renderVersion(scheme, base, counter) {
  const template = sanitizeScheme(scheme) || "{base}-luke.{n}";
  const basePattern = /\{base\}|<base>|\$base/i;
  const counterPattern = /\{(?:n|N)\}|<(?:n|N)>|\$(?:n|N)/;
  const hasBase = basePattern.test(template);
  const hasCounter = counterPattern.test(template);
  let rendered = template;
  if (hasBase) {
    rendered = rendered.replace(/\{base\}|<base>|\$base/gi, base);
  } else if (/^\d+\.\d+\.\d+/.test(rendered)) {
    rendered = rendered.replace(/^\d+\.\d+\.\d+/, base);
  } else {
    rendered = `${base}${rendered}`;
  }
  if (hasCounter) {
    rendered = rendered.replace(/\{(?:n|N)\}|<(?:n|N)>|\$(?:n|N)/g, String(counter));
  } else if (/^\d+\.\d+\.\d+/.test(template) && /\d$/.test(rendered)) {
    rendered = rendered.replace(/\d+$/, String(counter));
  } else {
    rendered = `${rendered}.${counter}`;
  }
  return rendered;
}

function versionNumbersForBase(versions, base) {
  const numbers = [];
  const pattern = new RegExp(`^v?${base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[^0-9]*(\\d+)$`);
  for (const version of versions) {
    const match = pattern.exec(String(version));
    if (match) numbers.push(Number(match[1]));
  }
  return numbers;
}

export function highestUsedCounter(state, base, extraVersions = []) {
  let highest = Number(state.versionCounters?.[base] ?? 0);
  const versions = [
    ...(state.history ?? []).map((entry) => entry.version),
    ...extraVersions,
  ].filter(Boolean);
  for (const number of versionNumbersForBase(versions, base)) {
    if (number > highest) highest = number;
  }
  return Number.isFinite(highest) ? highest : 0;
}

async function readVersionScheme(env) {
  const candidates = [
    path.join(env.config.forkRepo, "scripts/fork-updater/SANDBOX-FINDINGS.txt"),
    path.join(env.config.home, "SANDBOX-FINDINGS.txt"),
  ];
  for (const candidate of candidates) {
    if (!(await env.fs.exists(candidate))) continue;
    try {
      const scheme = parseVersionScheme(await env.fs.readFile(candidate));
      if (scheme) return scheme;
    } catch {
      // A missing or unreadable findings file just means the default scheme.
    }
  }
  return null;
}

async function collectExistingVersions(env) {
  const versions = [];
  for (const directory of [
    releasesDir(env.config),
    path.join(env.config.t3Home, "runtime", "versions"),
  ]) {
    for (const name of await env.fs.readdir(directory)) {
      versions.push(name.startsWith("v") ? name.slice(1) : name);
    }
  }
  return versions;
}

async function chooseVersion(env, logger, state, baseTag) {
  const base = baseTag.replace(/^v/, "");
  const scheme = await readVersionScheme(env);
  const extraVersions = await collectExistingVersions(env);
  const counter = highestUsedCounter(state, base, extraVersions) + 1;
  const version = renderVersion(scheme, base, counter);
  state.versionCounters[base] = counter;
  await saveState(env, state);
  await logger.info(`version for ${baseTag}: ${version} (scheme ${scheme ?? "{base}-luke.{n}"})`);
  return version;
}

async function getLatestStableTag(env, logger = silentLogger) {
  await logger.step(`reading the latest stable release of ${env.config.upstreamRepo}`);
  const result = await env.run(
    "gh",
    ["api", `repos/${env.config.upstreamRepo}/releases/latest`, "--jq", ".tag_name"],
    { timeoutMs: 60_000 },
  );
  if (result.status !== 0) {
    throw new StepFailure("read latest upstream release", combineOutput(result));
  }
  const tag = (result.stdout ?? "").trim().split(/\r?\n/)[0]?.trim() ?? "";
  if (parseStableTag(tag) === null) {
    throw new StepFailure("read latest upstream release", `'${tag}' is not a stable release tag`);
  }
  return tag;
}

async function runChecked(env, logger, step, command, args, options = {}) {
  await logger.step(step);
  const result = await env.run(command, args, options);
  if ((result.status ?? 0) !== 0) {
    throw new StepFailure(step, combineOutput(result));
  }
  return result;
}

async function removeWorktree(env, config, directory, logger) {
  await env.run("git", ["-C", config.forkRepo, "worktree", "remove", "--force", directory], {
    timeoutMs: 120_000,
  });
  if (await env.fs.exists(directory)) {
    await env.fs.rm(directory, { recursive: true, force: true });
  }
  await env.run("git", ["-C", config.forkRepo, "worktree", "prune"], { timeoutMs: 120_000 });
  await logger.info(`removed build worktree ${directory}`);
}

async function prepareBuild(env, logger, tag) {
  const config = env.config;
  const directory = path.join(buildsDir(config), tag);
  await env.fs.mkdir(buildsDir(config));
  await env.run("git", ["-C", config.forkRepo, "worktree", "prune"], { timeoutMs: 120_000 });
  if (await env.fs.exists(directory)) {
    await logger.warn(`clearing a previous build at ${directory}`);
    await removeWorktree(env, config, directory, logger);
  }
  await runChecked(
    env,
    logger,
    `fetching ${tag} from upstream`,
    "git",
    ["-C", config.forkRepo, "fetch", "origin", "tag", tag],
    { timeoutMs: 10 * 60_000 },
  );
  await runChecked(
    env,
    logger,
    `creating branch fork/${tag} from ${config.forkBranch}`,
    "git",
    ["-C", config.forkRepo, "worktree", "add", "-B", `fork/${tag}`, directory, config.forkBranch],
    { timeoutMs: 10 * 60_000 },
  );
  await logger.step(`merging ${tag} into fork/${tag}`);
  const merge = await env.run("git", ["-C", directory, "merge", "--no-edit", tag], {
    timeoutMs: 10 * 60_000,
  });
  if ((merge.status ?? 0) !== 0) {
    const conflicts = await env.run(
      "git",
      ["-C", directory, "diff", "--name-only", "--diff-filter=U"],
      { timeoutMs: 60_000 },
    );
    const files = (conflicts.stdout ?? "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    await env.run("git", ["-C", directory, "merge", "--abort"], { timeoutMs: 60_000 });
    await removeWorktree(env, config, directory, logger);
    throw new MergeConflict(files, combineOutput(merge));
  }
  return directory;
}

async function findToolsVp(env) {
  if (await env.fs.exists(env.config.toolsVp)) return env.config.toolsVp;
  return "vp";
}

async function findBuildVp(env, buildDirectory) {
  const vp = path.join(buildDirectory, "node_modules", ".bin", "vp");
  if (await env.fs.exists(vp)) return vp;
  return null;
}

async function runGates(env, logger, buildDirectory) {
  const installVp = await findToolsVp(env);
  await logger.info(`installing dependencies with ${installVp}`);
  await runChecked(env, logger, "installing dependencies (vp i)", installVp, ["i"], {
    cwd: buildDirectory,
    timeoutMs: 30 * 60_000,
  });
  const vp = await findBuildVp(env, buildDirectory);
  if (vp === null) {
    throw new StepFailure(
      "locate the build vp after install",
      `missing ${path.join(buildDirectory, "node_modules", ".bin", "vp")}`,
    );
  }
  await logger.info(`using build vp at ${vp}`);
  for (const packageName of ["@t3tools/contracts", "t3", "@t3tools/web", "@t3tools/desktop"]) {
    await runChecked(
      env,
      logger,
      `typecheck ${packageName}`,
      vp,
      ["run", "--filter", packageName, "typecheck"],
      { cwd: buildDirectory, timeoutMs: 15 * 60_000 },
    );
  }
  await runChecked(
    env,
    logger,
    FOCUSED_TEST_STEP,
    vp,
    [
      "test",
      "run",
      "apps/server/src/voice",
      "apps/web/src/voice",
      "apps/desktop/src/permissions",
      "packages/contracts",
    ],
    {
      cwd: buildDirectory,
      timeoutMs: 30 * 60_000,
      env: {
        T3CODE_TEST_KEEP_PROVIDER_ENV: "1",
        T3CODE_WHISPER_BIN: env.config.whisperBin,
        T3CODE_WHISPER_MODEL: env.config.whisperModel,
      },
    },
  );
}

async function buildArchive(env, logger, buildDirectory, version) {
  const inBuild = path.join(buildDirectory, "scripts", "fork-updater", "build-fork-archive.sh");
  const inRepo = path.join(env.config.forkRepo, "scripts", "fork-updater", "build-fork-archive.sh");
  const script = (await env.fs.exists(inBuild)) ? inBuild : inRepo;
  await env.fs.mkdir(releasesDir(env.config));
  await runChecked(
    env,
    logger,
    `building release archive for ${version}`,
    "bash",
    [script, buildDirectory, version, releasesDir(env.config)],
    { cwd: buildDirectory, timeoutMs: 60 * 60_000 },
  );
}

async function pruneReleases(env, logger, keepVersion) {
  const directory = releasesDir(env.config);
  const entries = [];
  for (const name of await env.fs.readdir(directory)) {
    const location = path.join(directory, name);
    try {
      const stats = await env.fs.stat(location);
      if (stats.isDirectory()) entries.push({ name, location, mtime: stats.mtimeMs ?? 0 });
    } catch {
      // A vanished release directory needs no pruning.
    }
  }
  entries.sort((left, right) => right.mtime - left.mtime);
  for (const entry of entries.slice(3)) {
    if (entry.name === `v${keepVersion}` || entry.name === keepVersion) continue;
    await env.fs.rm(entry.location, { recursive: true, force: true });
    await logger.info(`pruned release ${entry.name}`);
  }
}

function parseJsonArray(text) {
  try {
    const parsed = JSON.parse(String(text ?? "").trim());
    if (Array.isArray(parsed)) return parsed;
    if (parsed !== null && typeof parsed === "object") {
      if (Array.isArray(parsed.projects)) return parsed.projects;
      if (Array.isArray(parsed.threads)) return parsed.threads;
    }
  } catch {
    // Not JSON; the caller treats unreadable output as unsafe and waits.
  }
  return null;
}

function fallbackProject(config) {
  return [{ id: config.notifyProject, workspaceRoot: config.notifyProject, title: "" }];
}

async function listProjects(env, logger) {
  const config = env.config;
  const sandbox = config.switchMode === "sandbox";
  const database = path.join(config.t3Home, "userdata", "statev2.sqlite");
  if (sandbox && !(await env.fs.exists(database))) {
    await logger.warn(`sandbox database ${database} does not exist; no projects to check`);
    return [];
  }
  const listed = await env.run(
    SQLITE3_BIN,
    ["-readonly", `file:${database}?mode=ro`, "-json", PROJECTS_QUERY],
    { timeoutMs: 30_000 },
  );
  const rows = (listed.status ?? 0) === 0 ? parseJsonArray(listed.stdout) : null;
  if (rows === null || rows.length === 0) {
    const detail = oneLine(combineOutput(listed)) || "no output";
    if (sandbox) {
      await logger.warn(`could not read projects from ${database} (${detail})`);
      return [];
    }
    await logger.warn(
      `could not read projects from ${database} (${detail}); checking only ${config.notifyProject}`,
    );
    return fallbackProject(config);
  }
  const projects = [];
  for (const row of rows) {
    const id = row?.id ?? row?.projectId ?? row?.workspaceRoot;
    if (id === undefined || id === null || String(id) === "") continue;
    projects.push({
      id: String(id),
      workspaceRoot: String(row.workspaceRoot ?? row.workspace_root ?? id),
      title: String(row.title ?? ""),
    });
  }
  if (projects.length === 0) {
    if (sandbox) return [];
    await logger.warn(`no projects found in ${database}; checking only ${config.notifyProject}`);
    return fallbackProject(config);
  }
  return projects;
}

async function busyThreads(env, logger) {
  const busy = [];
  for (const project of await listProjects(env, logger)) {
    const identifier = project.id ?? project.workspaceRoot;
    const listed = await env.run(
      env.config.t3Bin,
      ["thread", "list", "--project", String(identifier), "--json"],
      { timeoutMs: 60_000 },
    );
    if (listed.status !== 0) {
      await logger.warn(
        `could not list threads for ${identifier}: ${oneLine(combineOutput(listed)) || "no output"}`,
      );
      busy.push({
        project: project.title || String(identifier),
        title: "(unknown)",
        status: "unknown",
      });
      continue;
    }
    const threads = parseJsonArray(listed.stdout);
    if (threads === null) {
      await logger.warn(`thread list for ${identifier} was not JSON; treating it as busy`);
      busy.push({
        project: project.title || String(identifier),
        title: "(unreadable)",
        status: "unknown",
      });
      continue;
    }
    for (const thread of threads) {
      const status = String(thread.status ?? "");
      if (BUSY_THREAD_STATUSES.has(status)) {
        busy.push({
          project: project.title || String(identifier),
          title: String(thread.title ?? thread.threadId ?? "(untitled)"),
          status,
        });
      }
    }
  }
  return busy;
}

async function waitForIdle(env, logger, state, version) {
  const busy = await busyThreads(env, logger);
  if (busy.length === 0) {
    state.waitingSince = null;
    state.waitingNotifiedFor = null;
    await logger.info("no busy threads; continuing with the switch");
    return true;
  }
  const now = env.now().getTime();
  if (!state.waitingSince) state.waitingSince = env.now().toISOString();
  const waitingMs = now - Date.parse(state.waitingSince);
  const summary = busy
    .slice(0, 5)
    .map((thread) => `${thread.title} (${thread.status})`)
    .join(", ");
  await logger.info(`waiting for idle: ${busy.length} busy thread(s): ${summary}`);
  if (
    Number.isFinite(waitingMs) &&
    waitingMs >= BUSY_WAIT_NOTIFY_MS &&
    state.waitingNotifiedFor !== state.waitingSince
  ) {
    await env.notify({
      kind: "info",
      title: "T3 updater",
      message: `update ${version} ready but threads are busy`,
    });
    state.waitingNotifiedFor = state.waitingSince;
  }
  return false;
}

async function getInstalledVersion(env, logger, state) {
  const config = env.config;
  if (config.switchMode === "sandbox") {
    return state.current ?? (await latestInstalledSandboxVersion(env, state));
  }
  const status = await env.run(config.t3Bin, ["service", "status"], { timeoutMs: 30_000 });
  if (status.status === 0) {
    const match = /t3@([0-9][^\s)]*)/.exec(combineOutput(status));
    if (match) return match[1];
  }
  const version = await env.run(config.t3Bin, ["--version"], { timeoutMs: 15_000 });
  if (version.status === 0) {
    const match = /v([0-9][^\s]*)/.exec(combineOutput(version));
    if (match) return match[1];
  }
  await logger.warn("could not read the installed version; falling back to state.json");
  return state.current ?? null;
}

function serviceWasNotRestarted(output) {
  return /still running .*version|Run `t3 service restart`|was not restarted|did not restart/i.test(
    String(output ?? ""),
  );
}

async function getRunningVersion(env, version) {
  const config = env.config;
  if (config.switchMode === "sandbox") {
    const binary = path.join(config.t3Home, "runtime", "versions", version, "t3");
    const result = await env.run(binary, ["--version"], { timeoutMs: 15_000 });
    if (result.status !== 0) return null;
    const match = /v([0-9][^\s]*)/.exec(combineOutput(result));
    return match ? match[1] : null;
  }
  const status = await env.run(config.t3Bin, ["service", "status"], { timeoutMs: 30_000 });
  if (status.status !== 0) return null;
  const match = /t3@([0-9][^\s)]*)/.exec(combineOutput(status));
  return match ? match[1] : null;
}

async function startReleaseServer(env, logger, version) {
  const config = env.config;
  const probe = `/v${version}/SHA256SUMS`;
  const firstPort = 3810;
  for (let offset = 0; offset < 20; offset += 1) {
    const port = firstPort + offset;
    const url = `http://127.0.0.1:${port}`;
    await logger.step(`starting release server on ${url} for ${releasesDir(config)}`);
    const started = await env.run(
      "python3",
      [
        "-m",
        "http.server",
        String(port),
        "--bind",
        "127.0.0.1",
        "--directory",
        releasesDir(config),
      ],
      { detached: true, timeoutMs: 5_000 },
    );
    if (!started.pid) continue;
    let answered = false;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const response = await env.httpGet(`${url}${probe}`, { timeoutMs: 1_000 });
      if (response.status === 200) {
        answered = true;
        break;
      }
      await env.sleep(250);
    }
    if (answered) {
      return {
        url,
        pid: started.pid,
        stop: async () => {
          await env.run("kill", [String(started.pid)], { timeoutMs: 10_000 });
          await logger.info(`stopped release server pid ${started.pid}`);
        },
      };
    }
    await env.run("kill", [String(started.pid)], { timeoutMs: 10_000 });
  }
  throw new StepFailure("release server", "python3 -m http.server did not answer on 3810-3829");
}

async function installVersion(env, logger, version, { baseUrl, sandbox } = {}) {
  const config = env.config;
  const args = ["update", version, "--allow-downgrade", "--yes"];
  if (sandbox) args.push("--base-dir", config.t3Home);
  const options = { timeoutMs: 30 * 60_000 };
  if (baseUrl) options.env = { T3CODE_RELEASE_BASE_URL: baseUrl };
  await logger.step(`running t3 update ${version}`);
  const result = await env.run(config.t3Bin, args, options);
  const output = combineOutput(result);
  if ((result.status ?? 0) !== 0) throw new StepFailure(`t3 update ${version}`, output);
  if (sandbox) {
    await restartSandboxServer(env, logger, version);
  } else if (serviceWasNotRestarted(output)) {
    await logger.step("service was not restarted by update; restarting it");
    const restarted = await env.run(config.t3Bin, ["service", "restart"], {
      timeoutMs: 2 * 60_000,
    });
    if ((restarted.status ?? 0) !== 0) {
      await logger.warn(`t3 service restart failed: ${oneLine(combineOutput(restarted))}`);
    }
  }
  return output;
}

async function stopSandboxServer(env, logger) {
  const pidFile = path.join(env.config.home, "sandbox.pid");
  if (!(await env.fs.exists(pidFile))) return;
  const raw = (await env.fs.readFile(pidFile)).trim();
  if (/^\d+$/.test(raw)) {
    await logger.info(`stopping sandbox server pid ${raw}`);
    await env.run("kill", [raw], { timeoutMs: 10_000 });
  }
  await env.fs.rm(pidFile, { force: true });
}

async function latestInstalledSandboxVersion(env, state) {
  if (state.current) return state.current;
  const directory = path.join(env.config.t3Home, "runtime", "versions");
  const entries = [];
  for (const name of await env.fs.readdir(directory)) {
    if (!/^\d+\.\d+\.\d+/.test(name)) continue;
    try {
      const stats = await env.fs.stat(path.join(directory, name));
      entries.push({ name, mtime: stats.mtimeMs ?? 0 });
    } catch {
      // Skip an unreadable version directory.
    }
  }
  entries.sort((left, right) => right.mtime - left.mtime);
  return entries[0]?.name ?? null;
}

async function restartSandboxServer(env, logger, version) {
  if (path.resolve(env.config.t3Home) === path.resolve(path.join(env.config.homeDir, ".t3"))) {
    throw new StepFailure(
      "sandbox restart",
      `sandbox mode needs a sandbox T3_HOME, refusing to restart ${env.config.t3Home}`,
    );
  }
  await stopSandboxServer(env, logger);
  const origin = `http://127.0.0.1:${env.config.servicePort}/`;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const response = await env.httpGet(origin, { timeoutMs: 1_000 });
    if (response.status !== 200) break;
    await env.sleep(250);
  }
  const binary = path.join(env.config.t3Home, "runtime", "versions", version, "t3");
  await logger.step(`starting sandbox server ${binary} on port ${env.config.servicePort}`);
  const started = await env.run(
    binary,
    [
      "serve",
      "--host",
      "127.0.0.1",
      "--port",
      String(env.config.servicePort),
      "--base-dir",
      env.config.t3Home,
      "--no-browser",
    ],
    { detached: true, timeoutMs: 5_000 },
  );
  if (!started.pid) throw new StepFailure("sandbox restart", `could not start ${binary}`);
  await env.fs.mkdir(env.config.home);
  await env.fs.writeFile(path.join(env.config.home, "sandbox.pid"), `${started.pid}\n`);
}

async function waitUntil(env, reason, timeoutMs, attempt) {
  const deadline = env.now().getTime() + timeoutMs;
  let detail = "";
  while (true) {
    const result = await attempt();
    if (result.ok) return result.value;
    detail = result.detail ?? detail;
    if (env.now().getTime() >= deadline) {
      throw new HealthFailure(reason, detail);
    }
    await env.sleep(2_000);
  }
}

async function healthCheck(env, logger, version, { featureChecks = true } = {}) {
  const config = env.config;
  const origin = `http://127.0.0.1:${config.servicePort}/`;
  await logger.step(`health check: GET ${origin}`);
  await waitUntil(
    env,
    "health check failed (service did not answer)",
    HEALTH_TIMEOUT_MS,
    async () => {
      const response = await env.httpGet(origin, { timeoutMs: 3_000 });
      return {
        ok: response.status === 200,
        value: response.status,
        detail: `GET / returned ${response.status || "no response"}`,
      };
    },
  );

  await logger.step("health check: running version");
  await waitUntil(
    env,
    "health check failed (wrong version running)",
    HEALTH_TIMEOUT_MS,
    async () => {
      const running = await getRunningVersion(env, version);
      return {
        ok: running === version,
        value: running,
        detail: `running ${running ?? "an unknown version"}, wanted ${version}`,
      };
    },
  );

  if (!featureChecks) {
    await logger.info(`health check passed for ${version} (feature checks skipped)`);
    return;
  }

  if (config.switchMode === "sandbox") {
    await logger.info("health check: OK thread skipped (sandbox mode)");
  } else {
    await logger.step("health check: one-word OK thread");
    const thread = await env.run(
      config.t3Bin,
      [
        "thread",
        "start",
        "--provider",
        "claude_gateway_luke",
        "--model",
        "claude-haiku-5-5",
        "--wait",
        "--json",
        "--title",
        "T3 update health check",
        config.notifyProject,
        "Reply with the single word OK",
      ],
      { timeoutMs: HEALTH_TIMEOUT_MS },
    );
    const output = combineOutput(thread);
    if ((thread.status ?? 0) !== 0) {
      throw new HealthFailure(
        "health check failed (OK thread failed)",
        summarizeFailure(output).join(" | ") || "no output",
      );
    }
    let reply = thread.stdout ?? "";
    try {
      reply = String(JSON.parse(reply.trim()).reply ?? "");
    } catch {
      // Plain text output is fine too.
    }
    if (!/ok/i.test(reply)) {
      throw new HealthFailure(
        "health check failed (OK thread replied wrong)",
        oneLine(reply).slice(0, 160) || "(nothing)",
      );
    }
  }

  await logger.step("health check: transcription");
  const binary = path.join(config.t3Home, "runtime", "versions", version, "t3");
  const transcription = await env.run(binary, ["voice", "transcribe", config.testWav], {
    timeoutMs: HEALTH_TIMEOUT_MS,
  });
  const transcriptionOutput = combineOutput(transcription);
  if ((transcription.status ?? 0) !== 0 || !/hello/i.test(transcriptionOutput)) {
    const stderrLines = firstLines(transcription.stderr, 3);
    const detailLines = stderrLines.length > 0 ? stderrLines : firstLines(transcriptionOutput, 3);
    throw new HealthFailure("transcription check failed", detailLines.join(" | ") || "no output");
  }
  await logger.info(`health check passed for ${version}`);
}

async function noPreviousRollback(env, logger, state, reason, details = []) {
  const old = state.current ?? "the previously installed version";
  const title = failureTitle(reason, old);
  const message = [
    `${title}.`,
    "",
    "Rollback also failed: no previous version is recorded.",
    ...(details.length > 0 ? ["", ...details] : []),
    "",
    `Log: ${logPath(env.config)}`,
    "Retry: node scripts/fork-updater/fork-updater.mjs run-now",
    "Reply to acknowledge in one short line.",
  ].join("\n");
  await logger.error(`${title}; rollback also failed (no previous version recorded)`);
  state.lastRun = {
    result: "fail",
    message: `${reason}; rollback failed (no previous version recorded)`,
    at: env.now().toISOString(),
  };
  await saveState(env, state);
  await env.notify({ kind: "fail", title, message });
  return { exitCode: 1, result: "rollback-failed" };
}

async function performRollback(
  env,
  logger,
  state,
  { reason, shortReason, details = [], manual, tag = null },
) {
  const target = state.previous ?? state.previousVersion ?? null;
  if (tag) state.failed = { tag, at: env.now().toISOString(), reason };
  if (!target) return noPreviousRollback(env, logger, state, shortReason ?? reason, details);
  await logger.step(`rolling back to ${target}`);
  try {
    await installVersion(env, logger, target, { sandbox: env.config.switchMode === "sandbox" });
    await healthCheck(env, logger, target, { featureChecks: false });
  } catch (error) {
    const rollbackDetail =
      error instanceof StepFailure
        ? summarizeFailure(error.output).join(" | ") || oneLine(error.message)
        : oneLine(error.message);
    const title = failureTitle(shortReason ?? reason, target);
    const message = [
      `${title}.`,
      "",
      `Rollback to ${target} also failed: ${rollbackDetail}`,
      ...(details.length > 0 ? ["", ...details] : []),
      "",
      `Log: ${logPath(env.config)}`,
      "Retry: node scripts/fork-updater/fork-updater.mjs run-now",
      "Reply to acknowledge in one short line.",
    ].join("\n");
    await logger.error(`${title}; rollback to ${target} also failed (${rollbackDetail})`);
    state.lastRun = {
      result: "fail",
      message: `${reason}; rollback to ${target} failed`,
      at: env.now().toISOString(),
    };
    await saveState(env, state);
    await env.notify({ kind: "fail", title, message });
    return { exitCode: 1, result: "rollback-failed" };
  }

  state.current = target;
  state.previous = null;
  state.history.push({
    version: target,
    baseTag: null,
    at: env.now().toISOString(),
    result: "rollback",
  });
  state.lastRun = {
    result: "fail",
    message: `${reason}; rolled back to ${target}`,
    at: env.now().toISOString(),
  };
  await saveState(env, state);
  await logger.info(`rolled back to ${target}`);
  if (manual) {
    const title = `T3 update: rolled back to ${target}`;
    await env.notify({
      kind: "info",
      title,
      message: [
        `${title}.`,
        "",
        `Log: ${logPath(env.config)}`,
        "Reply to acknowledge in one short line.",
      ].join("\n"),
    });
  } else {
    const title = failureTitle(shortReason ?? reason, target);
    await env.notify({
      kind: "fail",
      title,
      message: [
        `${title}.`,
        "",
        `Rolled back to ${target}.`,
        ...(details.length > 0 ? ["", ...details] : []),
        "",
        `Log: ${logPath(env.config)}`,
        ...recoveryInstructions(),
      ].join("\n"),
    });
  }
  return { exitCode: manual ? 0 : 1, result: "rolled-back" };
}

async function recordFailure(
  env,
  logger,
  state,
  { tag, reason, shortReason, step, output, files = [], details, markTag, previous },
) {
  const summary = details ?? summarizeFailure(output);
  if (step) {
    await logger.error(`${step} failed`);
    for (const line of summary) await logger.error(`  ${line}`);
  }
  if (files.length > 0) await logger.error(`conflicted files: ${files.join(", ")}`);
  if (markTag && tag) {
    state.failed = { tag, at: env.now().toISOString(), reason };
  }
  state.lastRun = { result: "fail", message: reason, at: env.now().toISOString() };
  await saveState(env, state);
  const old = previous ?? state.current ?? "the previously installed version";
  const title = failureTitle(shortReason ?? reason, old);
  const message = [
    `${title}.`,
    ...(files.length > 0 ? [`Conflicted files: ${files.join(", ")}`] : []),
    ...(summary.length > 0 ? ["", ...summary] : []),
    "",
    `Log: ${logPath(env.config)}`,
    ...recoveryInstructions(),
  ].join("\n");
  await env.notify({ kind: "fail", title, message });
  return { exitCode: 1, result: "fail" };
}

async function fastForwardBranch(env, logger, tag) {
  const config = env.config;
  const current = await env.run("git", ["-C", config.forkRepo, "symbolic-ref", "--short", "HEAD"], {
    timeoutMs: 30_000,
  });
  if (current.status === 0 && current.stdout.trim() === config.forkBranch) {
    const merged = await env.run(
      "git",
      ["-C", config.forkRepo, "merge", "--ff-only", `fork/${tag}`],
      { timeoutMs: 60_000 },
    );
    if (merged.status !== 0) {
      await logger.warn(
        `could not fast-forward ${config.forkBranch}: ${oneLine(combineOutput(merged))}`,
      );
    } else {
      await logger.info(`fast-forwarded ${config.forkBranch} to fork/${tag}`);
    }
    return;
  }
  const forced = await env.run(
    "git",
    ["-C", config.forkRepo, "branch", "-f", config.forkBranch, `fork/${tag}`],
    { timeoutMs: 60_000 },
  );
  if (forced.status !== 0) {
    await logger.warn(`could not move ${config.forkBranch}: ${oneLine(combineOutput(forced))}`);
  }
}

async function pruneBuilds(env, logger) {
  const directory = buildsDir(env.config);
  const names = await env.fs.readdir(directory);
  const entries = [];
  for (const name of names) {
    const location = path.join(directory, name);
    try {
      const stats = await env.fs.stat(location);
      if (stats.isDirectory()) entries.push({ name, location, mtime: stats.mtimeMs ?? 0 });
    } catch {
      // A vanished build directory needs no pruning.
    }
  }
  entries.sort((left, right) => right.mtime - left.mtime);
  for (const entry of entries.slice(1)) {
    await removeWorktree(env, env.config, entry.location, logger);
  }
}

async function pruneForkVersions(env, logger, state) {
  const directory = path.join(env.config.t3Home, "runtime", "versions");
  const present = await env.fs.readdir(directory);
  const known = new Map();
  for (const entry of state.history) {
    if (entry.result === "ok" && entry.version && !known.has(entry.version)) {
      known.set(entry.version, entry.at ?? "");
    }
  }
  const existing = present
    .filter((name) => known.has(name))
    .sort((left, right) => String(known.get(left)).localeCompare(String(known.get(right))));
  const removeCount = Math.max(0, existing.length - 3);
  for (const version of existing.slice(0, removeCount)) {
    if (version === state.current || version === state.previous) continue;
    await env.fs.rm(path.join(directory, version), { recursive: true, force: true });
    await logger.info(`pruned runtime version ${version}`);
  }
}

async function recordSuccess(
  env,
  logger,
  state,
  { tag, version, previousVersion, buildDirectory },
) {
  const config = env.config;
  state.current = version;
  if (previousVersion && previousVersion !== version) state.previous = previousVersion;
  state.lastBaseTag = tag;
  state.failed = null;
  state.waitingSince = null;
  state.waitingNotifiedFor = null;
  state.lastRun = { result: "ok", message: `installed ${version}`, at: env.now().toISOString() };
  state.history.push({
    version,
    baseTag: tag,
    at: env.now().toISOString(),
    result: "ok",
  });
  await saveState(env, state);
  await fastForwardBranch(env, logger, tag);
  await bestEffort(logger, "removing the build worktree", () =>
    removeWorktree(env, config, buildDirectory, logger),
  );
  await bestEffort(logger, "pruning old builds", () => pruneBuilds(env, logger));
  await bestEffort(logger, "pruning old fork versions", () =>
    pruneForkVersions(env, logger, state),
  );
  await env.notify({
    kind: "ok",
    title: `T3 update: ${version} installed`,
    message: [
      `T3 update: ${version} installed.`,
      `Log: ${logPath(config)}`,
      "Roll back: node scripts/fork-updater/fork-updater.mjs rollback",
      "Reply to acknowledge in one short line.",
    ].join("\n"),
  });
  await logger.info(`installed ${version}`);
  return { exitCode: 0, result: "ok" };
}

async function runPipeline(env, logger, state, { force, ignoreBackoff }) {
  const config = env.config;
  let tag;
  try {
    tag = await getLatestStableTag(env, logger);
  } catch (error) {
    const reason = `could not read the latest upstream release: ${error.message}`;
    await logger.error(reason);
    state.lastRun = { result: "fail", message: reason, at: env.now().toISOString() };
    await saveState(env, state);
    return { exitCode: 1, result: "fail" };
  }
  await logger.info(`upstream latest stable tag: ${tag}`);
  if (!isNewerTag(tag, state.lastBaseTag)) {
    await logger.info(`no update: ${tag} is not newer than ${state.lastBaseTag ?? "nothing"}`);
    state.lastRun = {
      result: NO_RUN,
      message: `${tag} is not newer than ${state.lastBaseTag ?? "nothing"}`,
      at: env.now().toISOString(),
    };
    await saveState(env, state);
    return { exitCode: 0, result: NO_RUN };
  }

  if (!ignoreBackoff && state.failed?.tag === tag) {
    const retryAt = Date.parse(state.failed.at) + FAILED_TAG_RETRY_MS;
    if (Number.isFinite(retryAt) && env.now().getTime() < retryAt) {
      await logger.warn(
        `${tag} failed at ${state.failed.at}; retrying after ${new Date(retryAt).toISOString()} (run-now ignores this)`,
      );
      return { exitCode: 0, result: "backoff" };
    }
  }

  let buildDirectory;
  let version;
  try {
    buildDirectory = await prepareBuild(env, logger, tag);
    await runGates(env, logger, buildDirectory);
    version = await chooseVersion(env, logger, state, tag);
    await buildArchive(env, logger, buildDirectory, version);
    await bestEffort(logger, "pruning old releases", () => pruneReleases(env, logger, version));
  } catch (error) {
    if (buildDirectory) {
      await bestEffort(logger, "removing the failed build worktree", () =>
        removeWorktree(env, config, buildDirectory, logger),
      );
    }
    if (error instanceof MergeConflict) {
      const files = error.files ?? [];
      const reason = `merge conflict in ${files.join(", ") || "unknown files"}`;
      const shortReason =
        files.length === 0
          ? reason
          : files.length === 1
            ? reason
            : `merge conflict in ${files[0]} (+${files.length - 1} more)`;
      return recordFailure(env, logger, state, {
        tag,
        reason,
        shortReason,
        step: "git merge",
        output: error.output,
        files,
        details: [],
        markTag: true,
        previous: state.current,
      });
    }
    if (error instanceof StepFailure) {
      const { reason, shortReason } = describeStepFailure(error.step, error.output);
      return recordFailure(env, logger, state, {
        tag,
        reason,
        shortReason,
        step: error.step,
        output: error.output,
        markTag: true,
        previous: state.current,
      });
    }
    return recordFailure(env, logger, state, {
      tag,
      reason: "preparation failed",
      shortReason: shortFailureReason(error?.message ?? "preparation failed"),
      step: "preparation",
      output: "",
      markTag: true,
      previous: state.current,
    });
  }

  if (!force) {
    const idle = await waitForIdle(env, logger, state, version);
    if (!idle) {
      state.lastRun = {
        result: "waiting",
        message: `waiting for idle before installing ${version}`,
        at: env.now().toISOString(),
      };
      await saveState(env, state);
      return { exitCode: 0, result: "waiting" };
    }
  } else {
    await logger.info("run-now --force: skipping the idle wait");
  }

  let previousVersion = state.current;
  try {
    previousVersion = await getInstalledVersion(env, logger, state);
  } catch {
    // State is the fallback.
  }
  if (previousVersion && previousVersion !== version) state.previous = previousVersion;

  try {
    const releaseServer = await startReleaseServer(env, logger, version);
    try {
      await installVersion(env, logger, version, {
        baseUrl: releaseServer.url,
        sandbox: config.switchMode === "sandbox",
      });
    } finally {
      await releaseServer.stop();
    }
    await healthCheck(env, logger, version);
  } catch (error) {
    let reason;
    let details;
    if (error instanceof StepFailure) {
      reason = describeStepFailure(error.step, error.output).shortReason;
      details = summarizeFailure(error.output);
    } else if (error instanceof HealthFailure) {
      reason = error.reason ?? error.message;
      details = summarizeFailure(error.detail ?? error.message);
    } else {
      reason = shortFailureReason(error?.message ?? "switch or health check failed");
      details = summarizeFailure(error?.message ?? "");
    }
    await logger.error(`switch or health check failed: ${reason}`);
    for (const line of details) await logger.error(`  ${line}`);
    return performRollback(env, logger, state, { reason, details, manual: false, tag });
  }

  return recordSuccess(env, logger, state, {
    tag,
    version,
    previousVersion,
    buildDirectory,
  });
}

async function restartServer(env, logger, state) {
  if (env.config.switchMode === "sandbox") {
    const version = await latestInstalledSandboxVersion(env, state);
    if (!version) {
      throw new StepFailure("restart", "no installed sandbox version to start");
    }
    await restartSandboxServer(env, logger, version);
    return;
  }
  await logger.step("restarting the T3 service");
  const result = await env.run(env.config.t3Bin, ["service", "restart"], {
    timeoutMs: 2 * 60_000,
  });
  if ((result.status ?? 0) !== 0) {
    await logger.warn(`t3 service restart failed: ${oneLine(combineOutput(result))}`);
  }
}

async function detectDown(env, logger, state) {
  const origin = `http://127.0.0.1:${env.config.servicePort}/`;
  const first = await env.httpGet(origin, { timeoutMs: 3_000 });
  if (first.status === 200) return false;
  await logger.warn(
    `service did not answer ${origin} (${first.status || "no response"}); checking again in 10s`,
  );
  await env.sleep(10_000);
  const second = await env.httpGet(origin, { timeoutMs: 3_000 });
  if (second.status === 200) {
    await logger.info("service answered the second check; no restart needed");
    return false;
  }
  await logger.warn("service did not answer twice; restarting it once");
  try {
    await restartServer(env, logger, state);
  } catch (error) {
    await logger.error(`restart failed: ${error.message}`);
  }
  await env.sleep(60_000);
  const third = await env.httpGet(origin, { timeoutMs: 3_000 });
  if (third.status === 200) {
    await logger.info("service came back after the restart");
    await env.notify({
      kind: "info",
      title: "T3 updater",
      message: "T3 service was down, restarted OK",
    });
    return false;
  }
  const now = env.now().getTime();
  const lastNotified = state.lastDownNotifyAt ? Date.parse(state.lastDownNotifyAt) : 0;
  if (!Number.isFinite(lastNotified) || now - lastNotified >= FAILED_TAG_RETRY_MS) {
    await env.notify({
      kind: "fail",
      title: "T3 updater",
      message: "T3 service is DOWN and a restart did not help",
    });
    state.lastDownNotifyAt = env.now().toISOString();
    state.lastRun = {
      result: "fail",
      message: "T3 service is DOWN and a restart did not help",
      at: env.now().toISOString(),
    };
    await saveState(env, state);
  } else {
    await logger.warn("service is still down; notification suppressed (once per 6 hours)");
  }
  return true;
}

async function acquireLock(env, logger) {
  const file = lockPath(env.config);
  if (await env.fs.exists(file)) {
    let at = Number.NaN;
    try {
      const parsed = JSON.parse(await env.fs.readFile(file));
      at = Date.parse(parsed.at);
    } catch {
      try {
        at = (await env.fs.stat(file)).mtimeMs;
      } catch {
        at = Number.NaN;
      }
    }
    const age = env.now().getTime() - at;
    if (Number.isFinite(age) && age < LOCK_STALE_MS) {
      await logger.warn(
        `another run holds ${file} (${new Date(at).toISOString()}, ${Math.round(age / 60_000)}m old); skipping`,
      );
      return null;
    }
    await logger.warn(`ignoring a stale lock at ${file}`);
  }
  await env.fs.mkdir(env.config.home);
  await env.fs.writeFile(
    file,
    `${JSON.stringify({ pid: process.pid, at: env.now().toISOString() })}\n`,
  );
  return {
    release: async () => {
      try {
        await env.fs.rm(file, { force: true });
      } catch {
        // The next run treats a leftover lock as stale after three hours.
      }
    },
  };
}

async function launchdState(env) {
  const plist = path.join(
    env.config.homeDir,
    "Library",
    "LaunchAgents",
    `${env.config.launchdLabel}.plist`,
  );
  const plistExists = await env.fs.exists(plist);
  const printed = await env.run(
    "launchctl",
    ["print", `gui/${env.config.uid}/${env.config.launchdLabel}`],
    { timeoutMs: 10_000 },
  );
  return { plist, plistExists, loaded: printed.status === 0 };
}

async function commandStatus(env) {
  const config = env.config;
  const state = await loadState(env);
  const lines = ["T3 fork updater", `  home: ${config.home}`, `  mode: ${config.switchMode}`];
  lines.push(`  t3 binary: ${config.t3Bin}`);
  lines.push(`  installed fork version: ${state.current ?? "none"}`);

  const cli = await env.run(config.t3Bin, ["--version"], { timeoutMs: 15_000 });
  const cliVersion =
    cli.status === 0 ? (/v[0-9][^\s]*/.exec(combineOutput(cli))?.[0] ?? "unknown") : "unknown";
  lines.push(`  t3 CLI version: ${cliVersion}`);

  try {
    const latest = await getLatestStableTag(env);
    lines.push(`  upstream latest stable: ${latest}`);
    if (!isNewerTag(latest, state.lastBaseTag)) {
      lines.push(`  new release: no (last base tag ${state.lastBaseTag ?? "none"})`);
    } else {
      lines.push(`  new release: yes (${latest} is newer than ${state.lastBaseTag ?? "none"})`);
    }
  } catch (error) {
    lines.push(`  upstream latest stable: unknown (${oneLine(error.message)})`);
  }

  if (state.lastRun) {
    lines.push(
      `  last run: ${state.lastRun.result} — ${oneLine(state.lastRun.message)} at ${state.lastRun.at}`,
    );
  } else {
    lines.push("  last run: never");
  }
  if (state.failed) {
    lines.push(
      `  retry backoff: ${state.failed.tag} failed at ${state.failed.at} (${state.failed.reason})`,
    );
  }
  if (state.waitingSince) {
    lines.push(`  waiting for idle since: ${state.waitingSince}`);
  }

  const response = await env.httpGet(`http://127.0.0.1:${config.servicePort}/`, {
    timeoutMs: 3_000,
  });
  lines.push(
    `  service: ${
      response.status === 200
        ? `answering on 127.0.0.1:${config.servicePort} (HTTP 200)`
        : `not answering on 127.0.0.1:${config.servicePort}`
    }`,
  );

  try {
    const launchd = await launchdState(env);
    lines.push(
      `  launchd: ${launchd.loaded ? "loaded" : "not loaded"} (${config.launchdLabel}${
        launchd.plistExists ? "" : ", plist missing"
      })`,
    );
  } catch (error) {
    lines.push(`  launchd: unknown (${oneLine(error.message)})`);
  }

  printOut(env, lines.join("\n"));
  return { exitCode: 0 };
}

async function commandCheck(env) {
  const state = await loadState(env);
  let latest;
  try {
    latest = await getLatestStableTag(env);
  } catch (error) {
    printOut(env, `could not read the latest upstream release: ${oneLine(error.message)}`);
    return { exitCode: 1 };
  }
  const newer = isNewerTag(latest, state.lastBaseTag);
  printOut(env, `upstream latest stable: ${latest}`);
  printOut(env, `last base tag: ${state.lastBaseTag ?? "none"}`);
  printOut(
    env,
    newer
      ? `new upstream stable release available: yes (${latest})`
      : `new upstream stable release available: no`,
  );
  if (state.failed?.tag === latest) {
    printOut(
      env,
      `last attempt for ${latest} failed at ${state.failed.at}: ${state.failed.reason} (retried after 6 hours; run-now ignores this)`,
    );
  }
  return { exitCode: 0 };
}

async function commandBusy(env) {
  const busy = await busyThreads(env, stderrLogger(env));
  printOut(env, JSON.stringify(busy, null, 2));
  return { exitCode: 0 };
}

async function handleTickCrash(env, logger, error) {
  const detail = oneLine(error?.message ?? String(error));
  try {
    await bestEffort(logger, "logging an unexpected tick error", () =>
      logger.error(`unexpected error during tick: ${oneLine(error?.stack ?? detail)}`),
    );
    const state = await loadState(env);
    state.lastRun = {
      result: "fail",
      message: `unexpected error: ${detail}`,
      at: env.now().toISOString(),
    };
    const now = env.now().getTime();
    const lastNotified = state.lastCrashNotifyAt ? Date.parse(state.lastCrashNotifyAt) : 0;
    if (!Number.isFinite(lastNotified) || now - lastNotified >= FAILED_TAG_RETRY_MS) {
      state.lastCrashNotifyAt = env.now().toISOString();
      await bestEffort(logger, "notifying about an unexpected tick error", () =>
        env.notify({
          kind: "fail",
          title: "T3 updater crashed",
          message: `T3 updater crashed: ${detail}. Reply to acknowledge in one short line.`,
        }),
      );
    }
    await bestEffort(logger, "saving state after an unexpected tick error", () =>
      saveState(env, state),
    );
  } catch (secondary) {
    await bestEffort(logger, "reporting a tick error handler failure", () =>
      logger.error(
        `could not handle the tick error (${oneLine(secondary?.message ?? String(secondary))})`,
      ),
    );
  }
  return { exitCode: 1, result: "crashed" };
}

function printOut(env, line) {
  if (env.out) env.out(line);
  else process.stdout.write(`${line}\n`);
}

function printErr(env, line) {
  if (env.err) env.err(line);
  else process.stderr.write(`${line}\n`);
}

function usage(env) {
  printErr(env, "Usage: fork-updater.mjs <status|check|run-now [--force]|rollback|tick>");
}

export async function main(argv = process.argv.slice(2), env = createSystemEnv()) {
  const command = argv.find((argument) => !argument.startsWith("-"));
  const force = argv.includes("--force");
  if (argv.includes("--help") || argv.includes("-h") || command === "help") {
    usage(env);
    return { exitCode: 0 };
  }
  if (command === undefined) {
    usage(env);
    return { exitCode: 2 };
  }
  if (command === "status") return commandStatus(env);
  if (command === "check") return commandCheck(env);
  if (command === "busy") return commandBusy(env);
  if (!["run-now", "rollback", "tick"].includes(command)) {
    printErr(env, `unknown command: ${command}`);
    usage(env);
    return { exitCode: 2 };
  }
  if (env.config.switchMode !== "service" && env.config.switchMode !== "sandbox") {
    printErr(env, `SWITCH_MODE must be service or sandbox, got '${env.config.switchMode}'`);
    return { exitCode: 2 };
  }
  if (env.config.notifyMode !== "real" && env.config.notifyMode !== "stdout") {
    printErr(env, `NOTIFY_MODE must be real or stdout, got '${env.config.notifyMode}'`);
    return { exitCode: 2 };
  }

  const logger = createLogger(env);
  let lock = null;
  try {
    await env.fs.mkdir(env.config.home);
    lock = await acquireLock(env, logger);
    if (lock === null) return { exitCode: 0, result: "locked" };
    const state = await loadState(env, logger);
    if (command === "rollback") {
      return performRollback(env, logger, state, { reason: "manual rollback", manual: true });
    }
    if (command === "tick") {
      const down = await detectDown(env, logger, state);
      if (down) return { exitCode: 1, result: "down" };
      return runPipeline(env, logger, state, { force: false, ignoreBackoff: false });
    }
    return runPipeline(env, logger, state, { force, ignoreBackoff: true });
  } catch (error) {
    if (command === "tick") return handleTickCrash(env, logger, error);
    throw error;
  } finally {
    if (lock !== null) await lock.release();
  }
}

function appleScriptString(value) {
  return `"${String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function systemRun(command, args, options = {}) {
  const parts = (process.env.PATH ?? "").split(":").filter(Boolean);
  for (const directory of [
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
  ]) {
    if (!parts.includes(directory)) parts.push(directory);
  }
  const env = { ...process.env, ...options.env, PATH: parts.join(":") };
  if (options.detached) {
    const child = NodeChildProcess.spawn(command, args, {
      cwd: options.cwd,
      env,
      detached: true,
      stdio: "ignore",
    });
    child.on("error", () => {});
    child.unref();
    return { status: child.pid ? 0 : 1, stdout: "", stderr: "", pid: child.pid ?? null };
  }
  const timeoutMs = options.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS;
  const result = NodeChildProcess.spawnSync(command, args, {
    cwd: options.cwd,
    env,
    encoding: "utf8",
    timeout: timeoutMs,
    killSignal: "SIGTERM",
    maxBuffer: 64 * 1024 * 1024,
  });
  const timedOut = result.error?.code === "ETIMEDOUT";
  return {
    status: timedOut ? 124 : (result.status ?? (result.error ? 1 : 0)),
    stdout: result.stdout ?? "",
    stderr: timedOut
      ? `${result.stderr ?? ""}\n[timed out after ${timeoutMs}ms]`.trim()
      : (result.stderr ?? ""),
    error: result.error?.message,
  };
}

function systemHttpGet(url, { timeoutMs = 5_000 } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (!settled) {
        settled = true;
        resolve(value);
      }
    };
    let request;
    try {
      request = NodeHttp.get(url, (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          if (body.length < 100_000) body += chunk;
        });
        response.on("end", () => finish({ status: response.statusCode ?? 0, body }));
        response.on("error", (error) => finish({ status: 0, body: "", error: error.message }));
      });
    } catch (error) {
      finish({ status: 0, body: "", error: error.message });
      return;
    }
    request.setTimeout(timeoutMs, () => request.destroy(new Error("timeout")));
    request.on("error", (error) => finish({ status: 0, body: "", error: error.message }));
  });
}

function systemSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createSystemAppendLog(config) {
  return async (message) => {
    try {
      await fs.mkdir(config.home, { recursive: true });
      await fs.appendFile(logPath(config), `${message}\n`);
    } catch {
      // Ignore logging failures.
    }
  };
}

async function systemNotify(config, notification, appendLog) {
  const title = oneLine(notification.title ?? "T3 updater");
  const message = String(notification.message ?? "");
  if (config.notifyMode === "stdout") {
    process.stdout.write(`NOTIFY (macOS): ${title} — ${oneLine(message)}\n`);
    process.stdout.write(`NOTIFY (T3 thread): ${title} — ${message}\n`);
    return;
  }
  const mac = systemRun(
    "osascript",
    [
      "-e",
      `display notification ${appleScriptString(oneLine(message))} with title ${appleScriptString(title)}`,
    ],
    { timeoutMs: 15_000 },
  );
  if (mac.status !== 0) {
    await appendLog(
      `[${new Date().toISOString()}] WARN notification: osascript failed: ${oneLine(combineOutput(mac))}`,
    );
  }
  const thread = systemRun(
    config.t3Bin,
    [
      "thread",
      "start",
      "--provider",
      "claude_gateway_luke",
      "--model",
      "claude-haiku-5-5",
      "--title",
      title,
      config.notifyProject,
      message,
    ],
    { timeoutMs: 2 * 60_000 },
  );
  if (thread.status !== 0) {
    await appendLog(
      `[${new Date().toISOString()}] WARN notification: T3 thread notification failed: ${oneLine(
        combineOutput(thread),
      )}`,
    );
  }
}

export function createSystemEnv(envVars = process.env) {
  const config = loadConfig(envVars);
  const appendLog = createSystemAppendLog(config);
  const realFs = {
    exists: async (file) => {
      try {
        await fs.access(file);
        return true;
      } catch {
        return false;
      }
    },
    readFile: (file) => fs.readFile(file, "utf8"),
    writeFile: (file, data) => fs.writeFile(file, data, "utf8"),
    appendFile: (file, data) => fs.appendFile(file, data, "utf8"),
    mkdir: (directory) => fs.mkdir(directory, { recursive: true }),
    readdir: async (directory) => {
      try {
        return await fs.readdir(directory);
      } catch {
        return [];
      }
    },
    stat: (file) => fs.stat(file),
    rm: (file, options = {}) => fs.rm(file, { recursive: true, force: true, ...options }),
    rename: (from, to) => fs.rename(from, to),
  };
  return {
    config,
    fs: realFs,
    now: () => new Date(),
    sleep: systemSleep,
    run: systemRun,
    httpGet: systemHttpGet,
    notify: (notification) => systemNotify(config, notification, appendLog),
    out: (line) => process.stdout.write(`${line}\n`),
    err: (line) => process.stderr.write(`${line}\n`),
  };
}

if (import.meta.main) {
  main(process.argv.slice(2), createSystemEnv())
    .then(({ exitCode }) => {
      process.exitCode = exitCode ?? 0;
    })
    .catch((error) => {
      process.stderr.write(`${error?.stack ?? error}\n`);
      process.exitCode = 1;
    });
}
