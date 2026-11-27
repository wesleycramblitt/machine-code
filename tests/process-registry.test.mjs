/**
 * Process ids are allocated in memory after one seed read.
 *
 * The registry is append-only for crash safety, but a spawn must not re-parse
 * the log: that made every git map probe O(records) and a run O(spawns²).
 * Ids stay monotonic across a fresh supervisor for the same run directory.
 *
 * No network or provider calls. Run with: npm test
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { allocateProcessId, lastProcessNumber, processesFile } from "../dist/processes/registry.js";

function runDir() {
  const dir = mkdtempSync(join(tmpdir(), "mc-procs-"));
  mkdirSync(join(dir, "processes"), { recursive: true });
  return dir;
}

describe("process registry allocation", () => {
  it("allocates monotonically without rereading the log", () => {
    const dir = runDir();
    try {
      assert.equal(allocateProcessId(dir), "p-0001");
      assert.equal(allocateProcessId(dir), "p-0002");
      // A supervisor for the same run dir seeds from its own instance map, so
      // it must not collide with ids already handed out in this process.
      assert.equal(allocateProcessId(dir), "p-0003");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("seeds from the tail of an existing log", () => {
    const dir = runDir();
    try {
      const lines = [];
      for (let i = 1; i <= 2_000; i += 1) {
        lines.push(JSON.stringify({ id: `p-${String(i).padStart(4, "0")}`, status: "exited" }));
      }
      appendFileSync(processesFile(dir), lines.join("\n") + "\n", "utf8");
      assert.equal(lastProcessNumber(dir), 2_000);
      assert.equal(allocateProcessId(dir), "p-2001");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("ignores a torn tail line", () => {
    const dir = runDir();
    try {
      appendFileSync(
        processesFile(dir),
        JSON.stringify({ id: "p-0007", status: "running" }) + "\n" + '{"id":"p-00',
        "utf8",
      );
      assert.equal(lastProcessNumber(dir), 7);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
