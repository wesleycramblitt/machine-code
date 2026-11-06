/**
 * Orchestration ledger and lease: durable state, exclusive scheduling, and
 * stale-lease takeover.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  acquireLease,
  createOrchestration,
  listOrchestrations,
  readLease,
  readOrchestration,
  releaseLease,
  renewLease,
  updateOrchestration,
} from "../dist/orchestrator/state.js";

function setup() {
  const root = mkdtempSync(join(tmpdir(), "mc-orch-"));
  return {
    root,
    layout: {
      home: join(root, "home"),
      machineConfig: "",
      curation: "",
      catalogueFile: "",
      repoRoot: root,
      repoDir: join(root, ".machine_code"),
      localDir: join(root, ".machine_code", "local"),
      policyFile: "",
      runsDir: join(root, ".machine_code", "local", "runs"),
    },
  };
}

test("creates, reads, lists, and updates ledger state", () => {
  const { root, layout } = setup();
  try {
    const state = createOrchestration(layout, "epic", { provider: "github", repo: "o/r", number: 10 });
    assert.match(state.id, /^orch-/);
    assert.equal(readOrchestration(layout, state.id).scope, "epic");
    assert.equal(listOrchestrations(layout).length, 1);
    const updated = updateOrchestration(layout, state.id, { checkpoint: "before-build", lastTickAt: "2026-11-02T00:00:00.000Z" });
    assert.equal(updated.checkpoint, "before-build");
    assert.equal(readOrchestration(layout, state.id).lastTickAt, "2026-11-02T00:00:00.000Z");
    updateOrchestration(layout, state.id, { approvedPackets: [31, 32], checkpoint: "packet_approved" });
    assert.deepEqual(readOrchestration(layout, state.id).approvedPackets, [31, 32]);
    updateOrchestration(layout, state.id, { approvedResults: [32], checkpoint: "result_approved" });
    assert.deepEqual(readOrchestration(layout, state.id).approvedResults, [32]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("leases are exclusive and renew only for the owner", () => {
  const { root, layout } = setup();
  try {
    const state = createOrchestration(layout, "project");
    assert.equal(acquireLease(layout, state.id, "owner-a", 60_000, 1_000), true);
    assert.equal(acquireLease(layout, state.id, "owner-b", 60_000, 1_001), false);
    assert.equal(readLease(layout, state.id).owner, "owner-a");
    assert.equal(renewLease(layout, state.id, "owner-b", 60_000, 2_000), false);
    assert.equal(renewLease(layout, state.id, "owner-a", 60_000, 2_000), true);
    releaseLease(layout, state.id, "owner-a");
    assert.equal(existsSync(join(layout.localDir, "orchestrations", `${state.id}.lock`)), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an expired lease can be taken over", () => {
  const { root, layout } = setup();
  try {
    const state = createOrchestration(layout, "feature", { provider: "github", repo: "o/r", number: 11 });
    assert.equal(acquireLease(layout, state.id, "owner-a", 1_000, 1_000), true);
    assert.equal(acquireLease(layout, state.id, "owner-b", 1_000, 3_000), true);
    assert.equal(readLease(layout, state.id).owner, "owner-b");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("resume clears a stop reason; unknown ids stay unknown", async () => {
  const { resumeOrchestration } = await import("../dist/orchestrator/state.js");
  const { root, layout } = setup();
  try {
    const created = createOrchestration(layout, "feature", { provider: "github", repo: "o/r", number: 36 });
    updateOrchestration(layout, created.id, { stopReason: "task #99 blocked: boom" });
    assert.equal(readOrchestration(layout, created.id)?.stopReason, "task #99 blocked: boom");
    const resumed = resumeOrchestration(layout, created.id);
    assert.equal(resumed?.stopReason, undefined);
    assert.equal(readOrchestration(layout, created.id)?.stopReason, undefined);
    assert.equal(resumeOrchestration(layout, "orch-does-not-exist"), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
