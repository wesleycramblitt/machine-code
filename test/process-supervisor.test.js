/**
 * Supervisor: record lifecycle, logs, events, and spawn failures.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { spawn } from "node:child_process";
import { ProcessSupervisor, terminateProcessRecord } from "../dist/processes/supervisor.js";
import { latestProcessRecords, readProcessRecords } from "../dist/processes/registry.js";

function tempDir() {
  return mkdtempSync(join(tmpdir(), "mc-proc-"));
}

test("supervised command records start/exit and keeps full logs", async () => {
  const dir = tempDir();
  try {
    const events = [];
    const supervisor = new ProcessSupervisor({
      runId: "run-1",
      runDir: dir,
      onEvent: (type, data) => events.push({ type, ...data }),
    });
    const ran = await supervisor.run(process.execPath, ["-e", 'process.stdout.write("hello"); process.stderr.write("err")'], {
      cwd: process.cwd(),
      timeoutMs: 10_000,
      origin: "command",
      name: "test:echo",
      toolCallId: "call-1",
    });
    assert.equal(ran.result.code, 0);
    assert.equal(ran.processId, "p-0001");
    assert.equal(ran.record.status, "exited");
    assert.equal(ran.record.toolCallId, "call-1");
    assert.equal(readFileSync(ran.record.stdoutLog, "utf8"), "hello");
    assert.equal(readFileSync(ran.record.stderrLog, "utf8"), "err");
    assert.equal(latestProcessRecords(readProcessRecords(dir)).length, 1);
    assert.deepEqual(events.map((event) => event.type), ["process_started", "process_exited"]);

    const second = await supervisor.run(process.execPath, ["-e", "process.exit(3)"], {
      cwd: process.cwd(),
      timeoutMs: 10_000,
      origin: "tool",
      name: "test:fail",
    });
    assert.equal(second.processId, "p-0002");
    assert.equal(second.record.status, "failed");
    assert.equal(second.record.exitCode, 3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("terminate escalates to SIGKILL after the grace period", async () => {
  const child = spawn(
    process.execPath,
    ["-e", "process.on('SIGTERM',()=>{}); process.stdout.write('ready'); setInterval(()=>{},1000)"],
    { detached: true, stdio: ["ignore", "pipe", "ignore"] },
  );
  try {
    assert.ok(child.pid);
    await new Promise((resolve) => child.stdout.once("data", resolve));
    const outcome = await terminateProcessRecord(
      {
        id: "p-test",
        runId: "run-test",
        origin: "command",
        name: "ignore-term",
        argv: ["node"],
        pid: child.pid,
        pgid: child.pid,
        status: "running",
        startedAt: new Date().toISOString(),
        stdoutLog: "/tmp/out",
        stderrLog: "/tmp/err",
      },
      150,
    );
    assert.equal(outcome, "kill");
  } finally {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      // already gone
    }
  }
});

test("start returns immediately and records the later exit", async () => {
  const dir = tempDir();
  try {
    const supervisor = new ProcessSupervisor({ runId: "run-start", runDir: dir });
    const started = await supervisor.start(process.execPath, ["-e", "setTimeout(()=>{},200)"], {
      cwd: process.cwd(),
      origin: "orchestrator",
      name: "delegated:build",
    });
    assert.equal(started.processId, "p-0001");
    assert.equal(started.record.status, "running");
    assert.ok(started.record.pid);
    await new Promise((resolve) => setTimeout(resolve, 800));
    const records = latestProcessRecords(readProcessRecords(dir));
    assert.equal(records[0].status, "exited");
    assert.equal(records[0].exitCode, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("attach registers an existing long-lived child", async () => {
  const dir = tempDir();
  try {
    const supervisor = new ProcessSupervisor({ runId: "run-attach", runDir: dir });
    const child = spawn(process.execPath, ["-e", "setTimeout(()=>{},100)"], {
      detached: true,
      stdio: "ignore",
    });
    const id = supervisor.attach(child, { origin: "lsp", name: "lsp:test" });
    assert.equal(id, "p-0001");
    await new Promise((resolve) => child.once("exit", resolve));
    const records = latestProcessRecords(readProcessRecords(dir));
    assert.equal(records[0].origin, "lsp");
    assert.equal(records[0].status, "exited");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("spawn failures are recorded without throwing", async () => {
  const dir = tempDir();
  try {
    const supervisor = new ProcessSupervisor({ runId: "run-2", runDir: dir });
    const ran = await supervisor.run("definitely-not-a-real-binary", [], {
      cwd: process.cwd(),
      timeoutMs: 5_000,
      origin: "command",
      name: "missing",
    });
    assert.equal(ran.result.outcome, "spawn-error");
    assert.equal(ran.record.status, "spawn-error");
    assert.match(ran.record.error, /not installed|ENOENT/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
