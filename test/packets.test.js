/**
 * Packet-file work model: slugs, front-matter parsing, canonical render,
 * TaskPacket mapping, and the plans/plan.md index + annotation.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  addIndexEntry,
  ensureIndex,
  indexLine,
  isBuildable,
  isValidSlug,
  listPacketFiles,
  markIndexDone,
  packetBranch,
  parsePacketDoc,
  readPacketFile,
  removeIndexEntry,
  renderPacketFile,
  renderPlan,
  slugify,
  toTaskPacket,
  writePacketFile,
} from "../dist/plan/packets.js";

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

function temp(prefix) {
  const root = mkdtempSync(join(tmpdir(), `mc-packets-${prefix}-`));
  mkdirSync(join(root, "plans"), { recursive: true });
  return root;
}

const DOC = `---
status = "todo"
deps = ["rate-limiter"]
---
# login-token-refresh

## Deliverable
Repair the token-refresh race.

## Files
- src/auth/session.ts
- src/auth/token.ts

## Acceptance
- no flake in 100 runs

## Verify
npm run typecheck
`; // note: `npm run typecheck` maps to typescript:typecheck via packet.ts

test("slugify and isValidSlug", () => {
  assert.equal(slugify("Fix the Login Token Refresh!"), "fix-the-login-token-refresh");
  assert.equal(slugify("  A   B_C "), "a-b-c");
  assert.equal(packetBranch("login-token-refresh"), "mc/login-token-refresh");
  assert.ok(isValidSlug("login-token-refresh"));
  assert.ok(!isValidSlug("Bad Slugs"));
  assert.ok(!isValidSlug("-leading"));
  assert.ok(!isValidSlug("trailing-"));
  assert.ok(!isValidSlug(""));
});

test("parsePacketDoc reads front-matter and sections", () => {
  const parsed = parsePacketDoc("login-token-refresh", DOC);
  assert.equal(parsed.error, undefined);
  const packet = parsed.packet;
  assert.equal(packet.status, "todo");
  assert.deepEqual(packet.deps, ["rate-limiter"]);
  assert.equal(packet.deliverable, "Repair the token-refresh race.");
  assert.deepEqual(packet.files, ["src/auth/session.ts", "src/auth/token.ts"]);
  assert.deepEqual(packet.acceptance, ["no flake in 100 runs"]);
  assert.deepEqual(packet.verify, ["typescript:typecheck"]);
  assert.equal(isBuildable(packet), true);
});

test("parsePacketDoc survives a missing front-matter with defaults", () => {
  const parsed = parsePacketDoc("bare", "# bare\n\n## Deliverable\nDo the thing\n");
  assert.equal(parsed.packet.status, "todo");
  assert.deepEqual(parsed.packet.deps, []);
  assert.equal(parsed.packet.deliverable, "Do the thing");
});

test("parsePacketDoc reports invalid TOML", () => {
  const parsed = parsePacketDoc("x", "---\nstatus = [unclosed\n---\n\n# x\n");
  assert.match(parsed.error ?? "", /TOML/i);
});

test("renderPacketFile round-trips and is canonical", () => {
  const root = temp("render");
  const layout = fakeLayout(root);
  try {
    const source = parsePacketDoc("rt", DOC).packet;
    const file = writePacketFile(layout, source);
    assert.equal(file, join(root, "plans", "rt.md"));
    const text = renderPacketFile(source);
    assert.match(text, /^---\n/);
    assert.match(text, /rate-limiter/);
    // Re-parsing the canonical output yields the same packet.
    const again = parsePacketDoc("rt", text).packet;
    assert.deepEqual(again, source);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("listPacketFiles lists only valid slug packets, sorted", () => {
  const root = temp("list");
  const layout = fakeLayout(root);
  try {
    writePacketFile(layout, parsePacketDoc("a", "# a\n\n## Deliverable\nA\n").packet);
    writePacketFile(layout, parsePacketDoc("b", "# b\n\n## Deliverable\nB\n").packet);
    writeFileSync(join(root, "plans", "notes.txt"), "not a packet", "utf8");
    writeFileSync(join(root, "plans", "UPPER.md"), "# not a slug\n", "utf8");
    // The index and a topic note are not packets, even though their names
    // would be valid slugs.
    ensureIndex(layout);
    writeFileSync(join(root, "plans", "tui.md"), "# TUI\n\n## Later\n- polish\n", "utf8");
    assert.deepEqual(listPacketFiles(layout).map((p) => p.slug), ["a", "b"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("toTaskPacket maps deliverable/files/verify into the loop packet", () => {
  const packet = parsePacketDoc("x", DOC).packet;
  const task = toTaskPacket(packet);
  assert.equal(task.id, "x");
  assert.equal(task.goal, "Repair the token-refresh race.");
  assert.deepEqual(task.context, ["src/auth/session.ts", "src/auth/token.ts"]);
  assert.deepEqual(task.acceptance, [{ command: "typescript:typecheck" }]);
  assert.match(task.constraints[0] ?? "", /no flake in 100 runs/);
});

test("ensureIndex writes the standard skeleton exactly once", () => {
  const root = temp("index");
  const layout = fakeLayout(root);
  try {
    const file = ensureIndex(layout);
    const body = readFileSync(file, "utf8");
    assert.match(body, /# Plan/);
    assert.match(body, /## Features/);
    assert.match(body, /## Done/);
    assert.ok(!body.includes("## Done\n\n## Done"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("addIndexEntry inserts under a heading and replaces by slug", () => {
  const root = temp("entry");
  const layout = fakeLayout(root);
  try {
    addIndexEntry(layout, "Bugs", "login-token-refresh", "auth flaky");
    addIndexEntry(layout, "Bugs", "rate-limiter", "API limits");
    const body = readFileSync(join(root, "plans", "plan.md"), "utf8");
    assert.match(body, /- \[ \] login-token-refresh — auth flaky → plans\/login-token-refresh\.md/);
    assert.match(body, /- \[ \] rate-limiter — API limits/);
    // Replace renames the title in place: exactly one live bullet remains.
    addIndexEntry(layout, "Bugs", "login-token-refresh", "auth flaky, renamed");
    assert.doesNotMatch(body, /auth flaky, renamed/); // body is stale; re-read
    const after = readFileSync(join(root, "plans", "plan.md"), "utf8");
    assert.equal(after.split("\n").filter((line) => line.includes("- [ ] login-token-refresh")).length, 1);
    assert.match(after, /auth flaky, renamed/);
    assert.doesNotMatch(after, /auth flaky —/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("markIndexDone moves the line to Done and removeIndexEntry clears it", () => {
  const root = temp("done");
  const layout = fakeLayout(root);
  try {
    addIndexEntry(layout, "Features", "thermal-model", "the model");
    markIndexDone(layout, "thermal-model", "the model");
    let body = readFileSync(join(root, "plans", "plan.md"), "utf8");
    assert.match(body, /## Done/);
    // Done lines carry no dead packet link: exactly one bullet, checked.
    assert.match(body, /- \[x\] thermal-model — the model\n/);
    assert.doesNotMatch(body, /\[x\] thermal-model.*plans\/thermal-model/);
    assert.equal(body.split("\n").filter((line) => line.includes("thermal-model")).length, 1);
    removeIndexEntry(layout, "thermal-model");
    body = readFileSync(join(root, "plans", "plan.md"), "utf8");
    assert.doesNotMatch(body, /thermal-model/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("renderPlan annotates item status, deps, and blockers", () => {
  const root = temp("view");
  const layout = fakeLayout(root);
  try {
    addIndexEntry(layout, "Bugs", "payments", "vendor payouts");
    const packet = parsePacketDoc("payments", DOC).packet;
    packet.status = "blocked";
    packet.blocked = "waiting on vendor API key";
    writePacketFile(layout, packet);
    const view = renderPlan(layout);
    assert.match(view.text, /payments/);
    assert.match(view.text, /blocked/);
    assert.match(view.text, /waiting on vendor API key/);
    assert.match(view.text, /deps: rate-limiter/);
    const item = view.items.find((entry) => entry.slug === "payments");
    assert.equal(item.status, "blocked");
    assert.equal(item.hasPacket, true);
    // The index line itself is untouched; annotation is additive.
    assert.equal(indexLine("payments", "vendor payouts"), "- [ ] payments — vendor payouts → plans/payments.md");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("readPacketFile and writePacketFile are symmetric", () => {
  const root = temp("roundtrip");
  const layout = fakeLayout(root);
  try {
    assert.equal(readPacketFile(layout, "missing"), null);
    const packet = parsePacketDoc("sym", DOC).packet;
    writePacketFile(layout, packet);
    assert.deepEqual(readPacketFile(layout, "sym"), packet);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
