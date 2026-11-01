/**
 * Phase 0 tests: packet resolver — canonical .json, legacy .md readability,
 * search order, and queue visibility of committed packets.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  packetPath,
  localPacketPath,
  readPacket,
  writePacket,
  listPackets,
  listCommittedPackets,
  newPacketId,
} from "../dist/packet.js";
import { listQueuedPackets } from "../dist/queue.js";

function fakeLayout(root) {
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

function tempDir(prefix) {
  return mkdtempSync(join(tmpdir(), `mc-pkt-${prefix}-`));
}

const SAMPLE = {
  id: "20261031-fix-parser",
  mode: "verified",
  goal: "fix the parser panic",
  context: ["src/parser.ts"],
  constraints: ["no new deps"],
  acceptance: [{ command: "typescript:test", args: { filter: "parser" } }],
};

test("writePacket writes canonical committed JSON and readPacket round-trips", () => {
  const root = tempDir("roundtrip");
  const layout = fakeLayout(root);
  try {
    const file = writePacket(layout, SAMPLE);
    assert.equal(file, packetPath(layout, SAMPLE.id));
    assert.ok(file.endsWith(".json"));
    const loaded = readPacket(layout, SAMPLE.id);
    assert.deepEqual(loaded, SAMPLE);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("writePacket local:true writes the gitignored snapshot path", () => {
  const root = tempDir("local");
  const layout = fakeLayout(root);
  try {
    const file = writePacket(layout, SAMPLE, { local: true });
    assert.equal(file, localPacketPath(layout, SAMPLE.id));
    assert.ok(file.includes(join(".machine_code", "local", "tasks")));
    assert.deepEqual(readPacket(layout, SAMPLE.id), SAMPLE);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("legacy .md files containing JSON remain readable", () => {
  const root = tempDir("legacy");
  const layout = fakeLayout(root);
  try {
    const dir = join(layout.repoDir, "tasks");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${SAMPLE.id}.md`), JSON.stringify(SAMPLE, null, 2) + "\n", "utf8");
    const loaded = readPacket(layout, SAMPLE.id);
    assert.deepEqual(loaded, SAMPLE);
    // Committed .json wins over legacy .md with the same id.
    const updated = { ...SAMPLE, goal: "updated goal" };
    writePacket(layout, updated);
    assert.equal(readPacket(layout, SAMPLE.id).goal, "updated goal");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("listPackets lists committed + local, deduped and sorted; committed wins", () => {
  const root = tempDir("list");
  const layout = fakeLayout(root);
  try {
    const committedDir = join(layout.repoDir, "tasks");
    const localDir = join(layout.localDir, "tasks");
    mkdirSync(committedDir, { recursive: true });
    mkdirSync(localDir, { recursive: true });
    writeFileSync(join(committedDir, "b.json"), JSON.stringify({ ...SAMPLE, id: "b", goal: "committed b" }), "utf8");
    writeFileSync(join(committedDir, "a.md"), JSON.stringify({ ...SAMPLE, id: "a", goal: "legacy a" }), "utf8");
    writeFileSync(join(localDir, "b.json"), JSON.stringify({ ...SAMPLE, id: "b", goal: "local b" }), "utf8");
    writeFileSync(join(localDir, "c.json"), JSON.stringify({ ...SAMPLE, id: "c" }), "utf8");
    writeFileSync(join(committedDir, "notes.txt"), "not a packet", "utf8");

    const all = listPackets(layout);
    assert.deepEqual(all.map((p) => p.id), ["a", "b", "c"]);
    assert.equal(all.find((p) => p.id === "b").goal, "committed b");

    const committed = listCommittedPackets(layout);
    assert.deepEqual(committed.map((p) => p.id), ["a", "b"]);

    // The queue processes exactly the committed set.
    assert.deepEqual(listQueuedPackets(layout).map((p) => p.id), ["a", "b"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("newPacketId produces a stable, filename-safe id", () => {
  const id = newPacketId("Fix the Parser Panic!");
  assert.match(id, /^\d{8}-\d{6}-fix-the-parser-panic/);
  assert.ok(!id.includes("!"));
});
