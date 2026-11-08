/**
 * Packet lifecycle: approvePacket merges the mc/<slug> branch into main, marks
 * the packet Done (deleting it), and commits; deletePacket removes every trace.
 * Uses temp git repos — no network, no model.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { approvePacket, deletePacket } from "../dist/tasks/packet.js";
import { writePacketFile, parsePacketDoc, readPacketFile } from "../dist/plan/packets.js";
import { writeIssue, findIssue } from "../dist/plan/issues.js";
import { RunRecorder } from "../dist/state/runs.js";

function git(dir, args) {
  return execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
}

function layout(root) {
  return {
    home: join(root, "home"),
    machineConfig: "",
    curation: "",
    catalogueFile: "",
    repoRoot: root,
    repoDir: join(root, ".machine_code"),
    localDir: join(root, ".machine_code", "local"),
    policyFile: "",
    runsDir: join(root, ".machine_code", "local", "runs"),
  };
}

function tempRepo() {
  const root = mkdtempSync(join(tmpdir(), "mc-pkt-life-"));
  git(root, ["init", "-q", "-b", "main"]);
  git(root, ["config", "user.email", "t@t.local"]);
  git(root, ["config", "user.name", "T"]);
  mkdirSync(join(root, "plans"), { recursive: true });
  return root;
}

function seedPacket(root) {
  const l = layout(root);
  const packet = parsePacketDoc("login-token-refresh", "# login-token-refresh\n\n## Deliverable\nRepair token refresh\n\n## Verify\ntypescript:test\n").packet;
  writePacketFile(l, packet);
  writeIssue(l, { kind: "bugs", status: "todo", slug: "login-token-refresh", prompt: "Repair token refresh", review: "human" });
  git(root, ["add", "-A"]);
  git(root, ["commit", "-qm", "seed packet"]);
  return l;
}

function fabricateBuildRun(l) {
  const recorder = new RunRecorder(l, {
    agent: "build",
    mode: "verified",
    request: "Repair token refresh",
    repoRoot: l.repoRoot,
    packetId: "login-token-refresh",
  });
  recorder.patchSummary({ branch: "mc/login-token-refresh", baseBranch: "main" });
  recorder.finalize("completed");
  return recorder.id;
}

test("deletePacket removes the file, index line, and branch, and commits", async () => {
  const root = tempRepo();
  const l = seedPacket(root);
  try {
    git(root, ["checkout", "-q", "-b", "mc/login-token-refresh"]);
    writeFileSync(join(root, "src.txt"), "x\n", "utf8");
    git(root, ["add", "-A"]);
    git(root, ["commit", "-qm", "work"]);
    git(root, ["checkout", "-q", "main"]);

    await deletePacket(l, "login-token-refresh");

    assert.equal(existsSync(join(root, "packets", "login-token-refresh.md")), false);
    assert.equal(findIssue(l, "login-token-refresh"), null);
    assert.equal(git(root, ["branch", "--list", "mc/login-token-refresh"]), "");
    assert.match(git(root, ["log", "--oneline", "-1"]), /delete login-token-refresh/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("approvePacket merges the branch, marks Done, and deletes the packet", async () => {
  const root = tempRepo();
  const l = seedPacket(root);
  try {
    git(root, ["checkout", "-q", "-b", "mc/login-token-refresh"]);
    writeFileSync(join(root, "src.txt"), "fixed\n", "utf8");
    git(root, ["add", "-A"]);
    git(root, ["commit", "-qm", "the fix"]);
    git(root, ["checkout", "-q", "main"]);

    fabricateBuildRun(l);
    await approvePacket(l, "login-token-refresh");

    // Packet file gone; the issue moved to done/.
    assert.equal(existsSync(join(root, "packets", "login-token-refresh.md")), false);
    assert.equal(findIssue(l, "login-token-refresh")?.status, "done");
    // Main now contains the branch's work (merge was --no-ff).
    assert.equal(readFileSync(join(root, "src.txt"), "utf8"), "fixed\n");
    assert.match(git(root, ["log", "--oneline", "-5"]), /Merge login-token-refresh/);
    assert.match(git(root, ["log", "--oneline", "-1"]), /complete login-token-refresh/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("approvePacket refuses without a completed build run", async () => {
  const root = tempRepo();
  const l = seedPacket(root);
  try {
    await assert.rejects(() => approvePacket(l, "login-token-refresh"), /no build run/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
