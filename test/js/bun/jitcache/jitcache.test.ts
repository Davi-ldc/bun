// JITCache in Bun (SPEC-integrator.md section 15.3): the flags of section 11.2, the host's warnings and its delta at
// exit, workers, bench reports and `bun jitcache` (SPEC-integrator.maintenance.md section 5), each consumer's output
// compared with a JITCache-off run's. Every check reads what any build of Bun shows: standard output and error, exit
// codes, the artifact's files and the bench report, whose start, install, capture and delta events say what each VM did
// (SPEC-integrator.harness.md section 9.2). JITCache runs only on Linux, where start configures a VM; elsewhere it
// returns Rejected at start.platform.
import { describe, expect, test } from "bun:test";
import { bunEnv, bunExe, isLinux, tempDir } from "harness";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

const app = join(import.meta.dir, "app-fixture.js");
const hold = join(import.meta.dir, "hold-fixture.js");
const macroBuild = join(import.meta.dir, "macro-build-fixture.js");

// With concurrent JIT off, each body compiles at the call that reaches its threshold, so what a producer commits does
// not depend on when a JIT thread finishes.
const env = { ...bunEnv, BUN_JSC_useConcurrentJIT: "0" };

interface Run {
  stdout: string;
  stderr: string;
  exitCode: number;
}

async function bun(args: string[], cwd: string): Promise<Run> {
  await using proc = Bun.spawn({
    cmd: [bunExe(), ...args],
    cwd,
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
  return { stdout, stderr, exitCode };
}

// What the app prints with JITCache off, which every run with JITCache must print too; one run per argument list.
const offRuns = new Map<string, Promise<string>>();
function offOutput(appArgs: string[] = []): Promise<string> {
  const key = appArgs.join(" ");
  let output = offRuns.get(key);
  if (!output) {
    output = (async () => {
      using dir = tempDir("jitcache-off", {});
      const run = await bun([app, ...appArgs], String(dir));
      expect(run.exitCode).toBe(0);
      return run.stdout;
    })();
    offRuns.set(key, output);
  }
  return output;
}

// The lines the host writes when JITCache turns itself off or replaces a cache (section 11.2).
function warnings(stderr: string): string[] {
  return stderr.split("\n").filter(line => line.startsWith("warn: JITCache"));
}

// The worker's threadId, which the app writes to standard error; its VM's id is one more.
function workerId(stderr: string): number {
  const match = /^threadId (\d+)$/m.exec(stderr);
  expect(match).not.toBeNull();
  return Number(match![1]) + 1;
}

function benchEvents(path: string): Record<string, any>[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map(line => JSON.parse(line));
}

function eventsNamed(path: string, event: string): Record<string, any>[] {
  return benchEvents(path).filter(line => line.event === event);
}

function startEvents(path: string): { outcome: string; role: string }[] {
  return eventsNamed(path, "start").map(({ outcome, role }) => ({ outcome, role }));
}

// The bodies cache/pack lists, in key order: its root at 56 is its valid end, the 8 bytes before the valid end give the
// latest index block's offset, and its index is the full index that block's chain ends at, followed by the deltas in
// order. Each body is its record's offset plus the 64-byte record header, and its size.
interface PackedBody {
  key: string;
  start: number;
  size: number;
}
function packBodies(artifact: string): PackedBody[] {
  const path = join(artifact, "cache", "pack");
  if (!existsSync(path)) return [];
  const bytes = readFileSync(path);
  const view = dataView(bytes);
  expect(bytes.subarray(0, 8).toString("latin1")).toBe("JITCPACK");
  const u64 = (offset: number) => Number(view.getBigUint64(offset, true));
  const validEnd = u64(56);
  const chain: number[] = [];
  for (let at = u64(validEnd - 8); ; at = u64(at + 8)) {
    expect(bytes.subarray(at, at + 8).toString("latin1")).toBe("JITCINDX");
    chain.push(at);
    if (view.getUint32(at + 16, true) === 0) break;
  }
  const bodies = new Map<string, PackedBody>();
  for (const at of chain.reverse()) {
    if (view.getUint32(at + 16, true) === 0) bodies.clear();
    for (let index = 0; index < view.getUint32(at + 20, true); ++index) {
      const entry = at + 32 + 80 * index;
      const key = bytes.subarray(entry, entry + 40).toString("hex");
      const offset = u64(entry + 40);
      if (offset) bodies.set(key, { key, start: offset + 64, size: u64(entry + 48) });
      else bodies.delete(key);
    }
  }
  return [...bodies.values()].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

// Rewrites cache/pack in place with fix applied to the bytes of every body it lists.
function rewritePackedBodies(artifact: string, fix: (body: Buffer) => void) {
  const path = join(artifact, "cache", "pack");
  const bodies = packBodies(artifact);
  expect(bodies.length).toBeGreaterThan(0);
  const bytes = readFileSync(path);
  for (const body of bodies) fix(bytes.subarray(body.start, body.start + body.size));
  writeFileSync(path, bytes);
}

// A producer of the app, which must start, warn nothing, print what the JITCache-off run prints and commit bodies.
async function produce(artifact: string, cwd: string, appArgs: string[] = [], flags: string[] = []): Promise<Run> {
  const args = [`--jitcache=${artifact}`, "--jitcache-mode=p", "--jitcache-strict", ...flags, app, ...appArgs];
  const run = await bun(args, cwd);
  expect(warnings(run.stderr)).toEqual([]);
  expect(run.stdout).toBe(await offOutput(appArgs));
  expect(run.exitCode).toBe(0);
  expect(packBodies(artifact).length).toBeGreaterThan(0);
  return run;
}

// A consumer of the app with a bench report, which must print what the JITCache-off run prints, warn nothing and
// install bodies.
async function consume(artifact: string, cwd: string, report: string, flags: string[] = ["--jitcache-strict"]) {
  const run = await bun([`--jitcache=${artifact}`, ...flags, `--jitcache-bench-report=${report}`, app], cwd);
  expect(warnings(run.stderr)).toEqual([]);
  expect(run.stdout).toBe(await offOutput());
  expect(run.exitCode).toBe(0);
  expect(eventsNamed(report, "install").length).toBeGreaterThan(0);
}

// A process that produces on artifact and holds its producer lock while body runs: p creates the artifact, and p-c
// opens one that exists.
async function whileAnotherProcessProduces(artifact: string, cwd: string, mode: string, body: () => Promise<void>) {
  await using holder = Bun.spawn({
    cmd: [bunExe(), `--jitcache=${artifact}`, `--jitcache-mode=${mode}`, "--jitcache-strict", hold],
    cwd,
    env,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  const reader = holder.stdout.getReader();
  const decoder = new TextDecoder();
  let ready = "";
  while (!ready.includes("\n")) {
    const { value, done } = await reader.read();
    if (done) break;
    ready += decoder.decode(value, { stream: true });
  }
  reader.releaseLock();
  expect(ready).toBe("ready\n");
  try {
    await body();
  } finally {
    holder.stdin.end();
  }
  const [stderr, exitCode] = await Promise.all([holder.stderr.text(), holder.exited]);
  expect(warnings(stderr)).toEqual([]);
  expect(exitCode).toBe(0);
}

// `bun jitcache compact 1 <artifact>` on a pseudo-terminal, where a plan that deletes the whole artifact asks before it
// applies (maintenance sub-SPEC section 5). answer is what the user types once the question appears, and beforeAnswer
// runs while compact waits, the producer lock released (section 4.4). Standard input, output and error all go through
// the terminal, which turns each line's end into \r\n.
async function compactOnTerminal(artifact: string, cwd: string, answer: string, beforeAnswer = () => {}) {
  const summaryLine = /compact: [a-z-]+, \d+ temporaries removed, \d+ bodies evicted, \d+ bytes reclaimed/;
  const decoder = new TextDecoder();
  let output = "";
  const asked = Promise.withResolvers<void>();
  const summarized = Promise.withResolvers<void>();
  await using proc = Bun.spawn({
    cmd: [bunExe(), "jitcache", "compact", "1", artifact],
    cwd,
    env,
    terminal: {
      data(_terminal, chunk) {
        output += decoder.decode(chunk, { stream: true });
        if (output.includes("Ok? (y/n)")) asked.resolve();
        if (summaryLine.test(output)) summarized.resolve();
      },
    },
  });
  const first = await Promise.race([asked.promise.then(() => "asked"), proc.exited.then(() => "exited")]);
  if (first !== "asked") throw new Error(`compact exited without asking: ${JSON.stringify(output)}`);
  beforeAnswer();
  proc.terminal!.write(answer);
  const exitCode = await proc.exited;
  // The summary is the last line compact writes, and the terminal can deliver it after the exit.
  await summarized.promise;
  proc.terminal!.close();
  return { output, exitCode };
}

// CRC-32C, the checksum of the artifact's header and body files (container sub-SPEC section 4.4).
const crc32cTable = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; ++n) {
    let c = n;
    for (let k = 0; k < 8; ++k) c = c & 1 ? 0x82f63b78 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32c(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const byte of bytes) c = crc32cTable[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function dataView(bytes: Buffer): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

// Rewrites the artifact's header as another build of Bun would have written it: the main executable's build ID differs
// in its first byte, and the CRC covers the new bytes, so the header is well formed but incompatible (container
// sub-SPEC sections 3.1 and 3.2). Returns the header's bytes before the rewrite.
function rewriteHeaderAsAnotherBuild(artifact: string): Buffer {
  const path = join(artifact, "cache", "header");
  const original = readFileSync(path);
  const header = Buffer.from(original);
  const view = dataView(header);
  expect(header.subarray(0, 8).toString("latin1")).toBe("JITCHEAD");
  const size = view.getUint32(12, true);
  expect(size).toBe(header.length);
  expect(view.getUint32(size - 8, true)).toBe(crc32c(header.subarray(0, size - 8)));
  // The first build-ID record, the main executable's: its role, the ID's length, then the ID from byte 8 of the record.
  expect(header[32]).toBe(1);
  expect(header[33]).toBeGreaterThan(0);
  header[40] ^= 0xff;
  view.setUint32(size - 8, crc32c(header.subarray(0, size - 8)), true);
  writeFileSync(path, header);
  return original;
}

// Sets ucb.feedback's reserved byte 39 (SPEC-ucb.md section 5.2) in a body file and reseals the section's, the
// directory's and the envelope's CRCs (container sub-SPEC sections 4.1 and 4.2). The body keeps its integrity, which
// every mode checks, and breaks a rule only strict checks (SPEC-ucb.md section 10.2, SV1); with strict off nothing
// reads the byte.
function breakFeedbackRuleOnlyStrictChecks(bytes: Buffer) {
  const view = dataView(bytes);
  expect(bytes.subarray(0, 8).toString("latin1")).toBe("JITCBODY");
  const sectionCount = view.getUint16(12, true);
  const directory = bytes.subarray(128, 128 + 24 * sectionCount);
  expect(view.getUint32(96, true)).toBe(crc32c(directory));
  expect(view.getUint32(120, true)).toBe(crc32c(bytes.subarray(0, 120)));
  let feedbackSections = 0;
  for (let index = 0; index < sectionCount; ++index) {
    const entry = 128 + 24 * index;
    // ucb.feedback: type id 0x0103, tier 0 (SPEC-integrator.md section 6.1).
    if (view.getUint16(entry, true) !== 0x0103 || bytes[entry + 2] !== 0) continue;
    const offset = Number(view.getBigUint64(entry + 8, true));
    const size = Number(view.getBigUint64(entry + 16, true));
    const section = bytes.subarray(offset, offset + size);
    expect(view.getUint32(entry + 4, true)).toBe(crc32c(section));
    expect(section[39]).toBe(0);
    section[39] = 1;
    view.setUint32(entry + 4, crc32c(section), true);
    ++feedbackSections;
  }
  expect(feedbackSections).toBe(1);
  view.setUint32(96, crc32c(directory), true);
  view.setUint32(120, crc32c(bytes.subarray(0, 120)), true);
}

// A pack temporary, as a compaction killed before its rename leaves one.
function addTemporary(artifact: string, bytes: number): string {
  const path = join(artifact, "cache", ".pack.0123456789abcdef0123456789abcdef.tmp");
  writeFileSync(path, Buffer.alloc(bytes, 7));
  return path;
}

describe.skipIf(!isLinux)("JITCache", () => {
  test.concurrent("a consumer imports what a producer committed", async () => {
    using dir = tempDir("jitcache-import", {});
    const artifact = join(String(dir), "artifact");
    await produce(artifact, String(dir));
    await consume(artifact, String(dir), join(String(dir), "consumer.jsonl"));
  });

  test.concurrent("a worker of a producing main VM falls back to Consumer", async () => {
    using dir = tempDir("jitcache-worker", { reports: {} });
    const artifact = join(String(dir), "artifact");
    const report = join(String(dir), "reports", "report.jsonl");
    const run = await produce(artifact, String(dir), ["worker"], [`--jitcache-bench-report=${report}`]);
    expect(startEvents(report)).toEqual([{ outcome: "started", role: "producer" }]);
    // Busy for the lock its own main VM holds, then started again as a Consumer, with no warning.
    expect(startEvents(`${report}.${workerId(run.stderr)}`)).toEqual([
      { outcome: "busy", role: "producer" },
      { outcome: "started", role: "consumer" },
    ]);
  });

  test.concurrent("a p and a p-c beside another producer get Busy and warn once", async () => {
    using dir = tempDir("jitcache-busy", {});
    const artifact = join(String(dir), "artifact");
    await whileAnotherProcessProduces(artifact, String(dir), "p", async () => {
      for (const [mode, role] of [
        ["p", "producer"],
        ["p-c", "consumer-producer"],
      ]) {
        const reports = join(String(dir), `reports-${mode}`);
        mkdirSync(reports);
        const report = join(reports, "report.jsonl");
        const flags = [`--jitcache=${artifact}`, `--jitcache-mode=${mode}`, "--jitcache-strict"];
        const run = await bun([...flags, `--jitcache-bench-report=${report}`, app, "worker"], String(dir));
        // Once per process, though the worker met the same Busy and did not fall back, its main VM producing nothing.
        expect(warnings(run.stderr)).toEqual([`warn: JITCache is off: another process is writing ${artifact}`]);
        expect(run.stdout).toBe(await offOutput(["worker"]));
        expect(run.exitCode).toBe(0);
        // JITCache is off: each VM's report holds its start and no install, capture or delta.
        const files = readdirSync(reports).sort();
        expect(files).toEqual(["report.jsonl", `report.jsonl.${workerId(run.stderr)}`]);
        for (const file of files) {
          const lines = benchEvents(join(reports, file)).map(({ event, outcome, role }) => ({ event, outcome, role }));
          expect(lines).toEqual([{ event: "start", outcome: "busy", role }]);
        }
      }
    });
  });

  test.concurrent("a c refuses another build's artifact, and a p-c replaces it", async () => {
    using dir = tempDir("jitcache-incompatible", {});
    const artifact = join(String(dir), "artifact");
    await produce(artifact, String(dir));
    const header = rewriteHeaderAsAnotherBuild(artifact);

    const refused = await bun([`--jitcache=${artifact}`, "--jitcache-strict", app, "worker"], String(dir));
    const refusal = warnings(refused.stderr);
    expect(refusal).toHaveLength(1);
    expect(refusal[0]).toStartWith("warn: JITCache is off: start.incompatible: ");
    expect(refusal[0]).toContain("build ID");
    expect(refused.stdout).toBe(await offOutput(["worker"]));
    expect(refused.exitCode).toBe(0);

    const flags = [`--jitcache=${artifact}`, "--jitcache-mode=p-c", "--jitcache-strict"];
    const replacing = await bun([...flags, app, "worker"], String(dir));
    const replacement = warnings(replacing.stderr);
    expect(replacement).toHaveLength(1);
    expect(replacement[0]).toStartWith(`warn: JITCache replaced an incompatible cache at ${artifact}: `);
    expect(replacing.stdout).toBe(await offOutput(["worker"]));
    expect(replacing.exitCode).toBe(0);
    // The new artifact is this build's, and the p-c committed into it, which a later c imports.
    expect(readFileSync(join(artifact, "cache", "header"))).toEqual(header);
    expect(existsSync(join(artifact, ".cache.replaced"))).toBe(false);
    expect(packBodies(artifact).length).toBeGreaterThan(0);
    await consume(artifact, String(dir), join(String(dir), "consumer.jsonl"));
  });

  test.concurrent("invalid material warns once at exit, workers included", async () => {
    using dir = tempDir("jitcache-invalid", {});
    const artifact = join(String(dir), "artifact");
    await produce(artifact, String(dir), ["worker"]);
    // A flipped last byte, which lies in a body's last section, fails every body at its section checksum in both modes.
    rewritePackedBodies(artifact, body => {
      body[body.length - 1] ^= 0x5a;
    });

    for (const appArgs of [[], ["worker"]]) {
      const run = await bun([`--jitcache=${artifact}`, "--jitcache-strict", app, ...appArgs], String(dir));
      const lines = warnings(run.stderr);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toStartWith("warn: JITCache is off: container.checksum: ");
      expect(run.stdout).toBe(await offOutput(appArgs));
      expect(run.exitCode).toBe(0);
    }
  });

  test.concurrent("--jitcache-log and --jitcache-max-memory are no Bun flags", async () => {
    using dir = tempDir("jitcache-shell-flags", {});
    const artifact = join(String(dir), "artifact");
    const report = join(String(dir), "producer.jsonl");
    // The jsc shell's flags (section 11.1): Bun writes no log line, and a limit of one page, which would refuse the
    // writer's staging buffer and so every commit, does not apply.
    const flags = ["--jitcache-log", "--jitcache-max-memory=4096", `--jitcache-bench-report=${report}`];
    const run = await produce(artifact, String(dir), [], flags);
    expect(run.stderr.split("\n").filter(line => line.startsWith('{"jitcache"'))).toEqual([]);
    expect(eventsNamed(report, "capture").filter(capture => capture.outcome === "committed").length).toBeGreaterThan(0);
    const budgets = eventsNamed(report, "budget");
    expect(budgets.length).toBeGreaterThan(0);
    expect(budgets.every(budget => budget.limit > 4096)).toBe(true);
  });

  test.concurrent("bench reports: the main VM's at the path, a worker's suffixed with its id", async () => {
    using dir = tempDir("jitcache-reports", { reports: {} });
    const artifact = join(String(dir), "artifact");
    const reports = join(String(dir), "reports");
    const flags = [`--jitcache-bench-report=${join(reports, "report.jsonl")}`];
    const run = await produce(artifact, String(dir), ["worker"], flags);
    const id = workerId(run.stderr);
    expect(id).toBeGreaterThan(1);
    expect(readdirSync(reports).sort()).toEqual(["report.jsonl", `report.jsonl.${id}`]);
    for (const file of readdirSync(reports)) {
      expect(eventsNamed(join(reports, file), "start").length).toBeGreaterThan(0);
    }
  });

  test.concurrent("a macro the bundler runs writes no bench report", async () => {
    using dir = tempDir("jitcache-macro", { reports: {} });
    const artifact = join(String(dir), "artifact");
    const reports = join(String(dir), "reports");
    const report = join(reports, "report.jsonl");
    // bun build reads no runtime flag, so JITCache is off in every VM it creates. Bun.build runs the same bundler in a
    // process whose flags Bun read: the main VM produces, and the macro runs in a VM the bundler creates on a thread of
    // its pool, which configureVM must leave alone (section 11.2).
    const flags = [`--jitcache=${artifact}`, "--jitcache-mode=p", "--jitcache-strict"];
    const run = await bun([...flags, `--jitcache-bench-report=${report}`, macroBuild], String(dir));
    expect(warnings(run.stderr)).toEqual([]);
    // The macro returns 42 outside the main thread's VM, and the bundle inlines it.
    expect(run.stdout).toContain("console.log(42)");
    expect(run.exitCode).toBe(0);
    // A macro VM taken for a worker's would have written report.jsonl.<its id>, and one taken for the main VM's would
    // have met the main VM's producer lock: a warning, and a second start event, busy, in report.jsonl.
    expect(readdirSync(reports)).toEqual(["report.jsonl"]);
    expect(startEvents(report)).toEqual([{ outcome: "started", role: "producer" }]);
  });

  test.concurrent("a producer calls delta at exit unless --jitcache-delta-at-exit=0, and nothing else does", async () => {
    using dir = tempDir("jitcache-delta", {});
    // With =0, the last occurrence included, a producer keeps the captures its baseline compilations committed and calls
    // no delta.
    for (const [index, flags] of [["--jitcache-delta-at-exit=0"], ["--jitcache-delta-at-exit", "--jitcache-delta-at-exit=0"]].entries()) {
      const plainReport = join(String(dir), `plain-${index}.jsonl`);
      await produce(join(String(dir), `plain-${index}`), String(dir), [], [...flags, `--jitcache-bench-report=${plainReport}`]);
      expect(eventsNamed(plainReport, "delta")).toHaveLength(0);
    }

    // Without the flag, delta at exit is on.
    const artifact = join(String(dir), "artifact");
    const report = join(String(dir), "producer.jsonl");
    await produce(artifact, String(dir), [], [`--jitcache-bench-report=${report}`]);
    // weigh and shape compiled with cold ICs, which their later calls filled, so the delta's captures beat the bodies
    // their compilations committed.
    const deltas = eventsNamed(report, "delta");
    expect(deltas).toHaveLength(1);
    expect(deltas[0].outcome).toBe("completed");
    expect(deltas[0].committedBodies).toBeGreaterThan(0);
    const captures = eventsNamed(report, "capture");
    const committed = captures.filter(capture => capture.trigger === "delta" && capture.outcome === "committed");
    expect(committed.length).toBe(deltas[0].committedBodies);
    // The pack lists every committed key once, its newest version winning. The delta's pack event reports the pack it
    // left, which it compacts exactly when the pack holds more than its live records and one full index (a 32-byte block
    // header, an 80-byte entry per body and an 8-byte trailer); the compaction leaves exactly those.
    const keys = new Set(committed.map(capture => capture.key));
    const listed = new Set(packBodies(artifact).map(body => body.key));
    for (const key of keys) expect(listed.has(key)).toBe(true);
    const packs = eventsNamed(report, "pack");
    expect(packs).toHaveLength(1);
    expect(packs[0].bytes).toBe(packs[0].liveBytes + packs[0].deadBytes);
    const denseBytes = packs[0].liveBytes + 32 + 80 * packs[0].bodies + 8;
    expect(packs[0].compacted).toBe(packs[0].bytes > denseBytes ? 1 : 0);
    if (packs[0].compacted) expect(packs[0].compactedBytes).toBe(denseBytes);
  });

  test.concurrent("bun jitcache compact: exit codes, --yes, --no and no terminal", async () => {
    using dir = tempDir("jitcache-maintenance", {});
    const artifact = join(String(dir), "artifact");
    const missing = join(String(dir), "missing");
    // Without delta at exit, which ends in a compaction, the pack keeps the index blocks of the producer's commits.
    await produce(artifact, String(dir), [], ["--jitcache-delta-at-exit=0"]);
    const maintenance = (...args: string[]) => bun(["jitcache", ...args], String(dir));
    const summary = (run: Run) => run.stdout.split("\n").filter(line => /^compact: /.test(line));
    const header = join(artifact, "cache", "header");
    const pack = join(artifact, "cache", "pack");

    // A first argument that is no number is the path, and the ratio is 0, which evicts nothing: it removes the temporary
    // and drops the pack's dead bytes, and reports both.
    const temporary = addTemporary(artifact, 100);
    const bodies = packBodies(artifact).length;
    const packBytes = statSync(pack).size;
    const cleanup = await maintenance("compact", artifact);
    const reclaimed = /^compact: done, 1 temporaries removed, 0 bodies evicted, (\d+) bytes reclaimed$/.exec(summary(cleanup)[0] ?? "");
    expect(Number(reclaimed?.[1])).toBe(100 + packBytes - statSync(pack).size);
    expect(cleanup.exitCode).toBe(0);
    expect(existsSync(temporary)).toBe(false);
    expect(packBodies(artifact).length).toBe(bodies);

    // A second one, with the ratio named, finds nothing left to remove.
    const nothingLeft = await maintenance("compact", "0", artifact);
    expect(summary(nothingLeft)).toEqual(["compact: done, 0 temporaries removed, 0 bodies evicted, 0 bytes reclaimed"]);
    expect(nothingLeft.exitCode).toBe(0);

    const absent = await maintenance("compact", "0", missing);
    expect(summary(absent)).toEqual(["compact: no-artifact, 0 temporaries removed, 0 bodies evicted, 0 bytes reclaimed"]);
    expect(absent.exitCode).toBe(0);
    expect(existsSync(missing)).toBe(false);

    // A plan that deletes the whole artifact waits for confirmation; standard input is no terminal here, so compact
    // prints the plan, asks nothing and changes nothing.
    const unconfirmed = await maintenance("compact", "1", artifact);
    expect(unconfirmed.stdout).toContain("deletes the whole artifact");
    expect(unconfirmed.stdout).not.toContain("This operation will delete the entire cache");
    expect(summary(unconfirmed)).toEqual([
      "compact: needs-confirmation, 0 temporaries removed, 0 bodies evicted, 0 bytes reclaimed",
    ]);
    expect(unconfirmed.exitCode).toBe(4);
    const declined = await maintenance("compact", "1", artifact, "--no");
    expect(summary(declined)).toEqual([
      "compact: declined, 0 temporaries removed, 0 bodies evicted, 0 bytes reclaimed",
    ]);
    expect(declined.exitCode).toBe(4);
    expect(packBodies(artifact).length).toBe(bodies);
    expect(existsSync(header)).toBe(true);

    const badRatio = await maintenance("compact", "2", artifact);
    expect(badRatio.stderr).toContain("bad-ratio");
    expect(badRatio.exitCode).toBe(1);

    // A ratio after the path is a second path.
    const usageErrors = [
      [],
      ["frobnicate"],
      ["clean", artifact],
      ["compact", "0", artifact, missing],
      ["compact", artifact, "0.5"],
      ["compact", "1", artifact, "--maybe"],
    ];
    for (const args of usageErrors) {
      const usage = await maintenance(...args);
      expect(usage.stderr).toContain("usage: compact [<ratio>] [<path>] [--yes | --no]");
      expect(usage.exitCode).toBe(2);
    }

    await whileAnotherProcessProduces(artifact, String(dir), "p-c", async () => {
      const busy = await maintenance("compact", "0", artifact);
      expect(summary(busy)).toEqual(["compact: busy, 0 temporaries removed, 0 bodies evicted, 0 bytes reclaimed"]);
      expect(busy.exitCode).toBe(3);
    });

    // A tenth of the artifact's bytes takes at least one body and, with weigh and shape among them, not every body, so
    // the plan applies without confirmation, as a compaction that keeps the survivors.
    const before = packBodies(artifact).length;
    const partial = await maintenance("compact", "0.1", artifact);
    expect(partial.exitCode).toBe(0);
    const evictedLine = /^compact: done, 0 temporaries removed, (\d+) bodies evicted, \d+ bytes reclaimed$/m;
    const evicted = Number(evictedLine.exec(partial.stdout)?.[1]);
    expect(evicted).toBeGreaterThan(0);
    expect(packBodies(artifact).length).toBe(before - evicted);
    expect(existsSync(header)).toBe(true);

    const deleted = await maintenance("compact", "1", artifact, "--yes");
    expect(summary(deleted)[0]).toStartWith("compact: done, ");
    expect(deleted.exitCode).toBe(0);
    expect(existsSync(join(artifact, "cache"))).toBe(false);
    expect(existsSync(join(artifact, ".cache.producer.lock"))).toBe(true);
  });

  test.concurrent("bun jitcache compact asks on a terminal before it deletes the whole artifact", async () => {
    using dir = tempDir("jitcache-terminal", {});
    const artifact = join(String(dir), "artifact");
    await produce(artifact, String(dir));
    const bodies = packBodies(artifact);

    const declined = await compactOnTerminal(artifact, String(dir), "n\n");
    expect(declined.output).toContain("deletes the whole artifact");
    expect(declined.output).toContain("compact: declined, ");
    expect(declined.exitCode).toBe(4);
    expect(packBodies(artifact)).toEqual(bodies);

    // Bodies that go while compact waits change the plan, which the confirmed call then refuses to apply.
    const pack = join(artifact, "cache", "pack");
    const changed = await compactOnTerminal(artifact, String(dir), "y\n", () => rmSync(pack));
    expect(changed.output).toContain("compact: plan-changed, ");
    expect(changed.exitCode).toBe(5);
    expect(existsSync(pack)).toBe(false);

    const confirmed = await compactOnTerminal(artifact, String(dir), "y\n");
    expect(confirmed.output).toContain("compact: done, ");
    expect(confirmed.exitCode).toBe(0);
    expect(existsSync(join(artifact, "cache"))).toBe(false);
  });

  test.concurrent("a malformed JITCache flag value is a command-line error", async () => {
    using dir = tempDir("jitcache-malformed", {});
    const artifact = join(String(dir), "artifact");
    for (const [flag, value] of [
      ["--jitcache-mode", "x"],
      ["--jitcache-strict", "2"],
      ["--jitcache-delta-at-exit", "2"],
      ["--jitcache-delta-capture", "x"],
      ["--jitcache-bench-report", ""],
    ]) {
      const run = await bun([`--jitcache=${artifact}`, `${flag}=${value}`, app], String(dir));
      expect(run.stderr).toContain(`Invalid value for ${flag}`);
      expect(run.stdout).toBe("");
      expect(run.exitCode).toBe(1);
    }
    expect(existsSync(artifact)).toBe(false);
  });

  test.concurrent("a bare --jitcache opens .jitcache in the working directory, --cwd's included", async () => {
    using dir = tempDir("jitcache-bare", { project: {}, elsewhere: {} });
    const project = join(String(dir), "project");
    const elsewhere = join(String(dir), "elsewhere");

    const here = await bun(["--jitcache", "--jitcache-mode=p", "--jitcache-strict", app], project);
    expect(warnings(here.stderr)).toEqual([]);
    expect(here.exitCode).toBe(0);
    expect(statSync(join(project, ".jitcache", "cache", "header")).isFile()).toBe(true);

    // Had the second producer opened project/.jitcache, start would have rejected it at start.artifact-exists.
    const producerFlags = ["--jitcache", "--jitcache-mode=p", "--jitcache-strict"];
    const named = await bun([`--cwd=${elsewhere}`, ...producerFlags, app], project);
    expect(warnings(named.stderr)).toEqual([]);
    expect(named.exitCode).toBe(0);
    expect(statSync(join(elsewhere, ".jitcache", "cache", "header")).isFile()).toBe(true);
  });

  test.concurrent("a worker started after process.chdir opens the main VM's artifact", async () => {
    using dir = tempDir("jitcache-chdir", { other: {}, reports: {} });
    const other = join(String(dir), "other");
    const report = join(String(dir), "reports", "report.jsonl");
    // The path is relative: Bun resolves it against the working directory once, before any VM starts.
    const flags = ["--jitcache=relative", "--jitcache-mode=p", "--jitcache-strict"];
    const reportFlag = `--jitcache-bench-report=${report}`;
    const run = await bun([...flags, reportFlag, app, "worker", `chdir=${other}`], String(dir));
    expect(warnings(run.stderr)).toEqual([]);
    expect(run.stdout).toBe(await offOutput(["worker"]));
    expect(run.exitCode).toBe(0);
    expect(statSync(join(String(dir), "relative", "cache", "header")).isFile()).toBe(true);
    expect(existsSync(join(other, "relative"))).toBe(false);
    // The worker met the lock of the main VM's artifact and fell back to Consumer on it.
    expect(startEvents(`${report}.${workerId(run.stderr)}`)).toEqual([
      { outcome: "busy", role: "producer" },
      { outcome: "started", role: "consumer" },
    ]);
  });

  test.concurrent("bun jitcache compact without a path works on ./.jitcache, with or without a ratio", async () => {
    using dir = tempDir("jitcache-default-path", { project: {}, empty: {} });
    const project = join(String(dir), "project");
    const artifact = join(project, ".jitcache");
    const created = await bun(["--jitcache", "--jitcache-mode=p", "--jitcache-strict", app], project);
    expect(created.exitCode).toBe(0);
    const temporary = addTemporary(artifact, 64);

    const compacted = await bun(["jitcache", "compact", "0"], project);
    expect(compacted.stdout).toMatch(/compact: done, 1 temporaries removed, 0 bodies evicted, \d+ bytes reclaimed/);
    expect(compacted.exitCode).toBe(0);
    expect(existsSync(temporary)).toBe(false);
    expect(existsSync(join(artifact, "cache", "header"))).toBe(true);

    // Without a ratio, too, it is 0: the second temporary goes, and the pack, already compact, keeps every byte.
    const secondTemporary = addTemporary(artifact, 64);
    const cleaned = await bun(["jitcache", "compact"], project);
    expect(cleaned.stdout).toContain("compact: done, 1 temporaries removed, 0 bodies evicted, 64 bytes reclaimed");
    expect(cleaned.exitCode).toBe(0);
    expect(existsSync(secondTemporary)).toBe(false);
    expect(existsSync(join(artifact, "cache", "header"))).toBe(true);

    const empty = join(String(dir), "empty");
    for (const args of [["compact", "0"], ["compact"]]) {
      const nothing = await bun(["jitcache", ...args], empty);
      expect(nothing.stdout).toContain("compact: no-artifact, 0 temporaries removed, 0 bodies evicted, 0 bytes reclaimed");
      expect(nothing.exitCode).toBe(0);
    }
    expect(existsSync(join(empty, ".jitcache"))).toBe(false);
  });

  test.concurrent("--jitcache-strict: bare and =1 turn it on, =0 off, and the last one wins", async () => {
    using dir = tempDir("jitcache-strict", {});
    const artifact = join(String(dir), "artifact");
    await produce(artifact, String(dir));
    rewritePackedBodies(artifact, breakFeedbackRuleOnlyStrictChecks);

    const cases: [string[], boolean][] = [
      [["--jitcache-strict"], true],
      [["--jitcache-strict=1"], true],
      [["--jitcache-strict=0"], false],
      [["--jitcache-strict=1", "--jitcache-strict=0"], false],
      [["--jitcache-strict=0", "--jitcache-strict"], true],
      [[], false],
    ];
    for (const [index, [flags, strict]] of cases.entries()) {
      const report = join(String(dir), `consumer-${index}.jsonl`);
      if (!strict) {
        // Normal mode checks integrity, which the resealed CRCs keep, and reads nothing at byte 39: the bodies import.
        await consume(artifact, String(dir), report, flags);
        continue;
      }
      const args = [`--jitcache=${artifact}`, ...flags, `--jitcache-bench-report=${report}`, app];
      const run = await bun(args, String(dir));
      const lines = warnings(run.stderr);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toStartWith("warn: JITCache is off: ucb.feedback: ");
      expect(eventsNamed(report, "install")).toEqual([]);
      expect(run.stdout).toBe(await offOutput());
      expect(run.exitCode).toBe(0);
    }
  });

  test.concurrent("--jitcache-delta-capture: all, the default, also commits bodies without an image, compiled does not", async () => {
    using dir = tempDir("jitcache-delta-capture", {});
    // The app's top level runs once and never compiles, so with all the delta at exit commits it at tier 0 (THREAD
    // Capture); weigh and shape compile, so every value commits them with an image.
    const cases: [string[], boolean][] = [
      [[], true],
      [["--jitcache-delta-capture=all"], true],
      [["--jitcache-delta-capture=compiled"], false],
      [["--jitcache-delta-capture=compiled", "--jitcache-delta-capture=all"], true],
      [["--jitcache-delta-capture=all", "--jitcache-delta-capture=compiled"], false],
    ];
    for (const [index, [flags, imageless]] of cases.entries()) {
      const artifact = join(String(dir), `artifact-${index}`);
      const report = join(String(dir), `producer-${index}.jsonl`);
      const args = [`--jitcache=${artifact}`, "--jitcache-mode=p", "--jitcache-strict", "--jitcache-delta-at-exit", ...flags];
      const run = await bun([...args, `--jitcache-bench-report=${report}`, app], String(dir));
      expect(warnings(run.stderr)).toEqual([]);
      expect(run.stdout).toBe(await offOutput());
      expect(run.exitCode).toBe(0);
      const committed = eventsNamed(report, "capture").filter(capture => capture.outcome === "committed");
      expect(committed.some(capture => capture["committed.tier"] === 1)).toBe(true);
      expect(committed.some(capture => capture["committed.tier"] === 0)).toBe(imageless);
    }
  });
});
