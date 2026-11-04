/**
 * Run state: facts, working set, artifacts, ingestion, prompt rendering, and
 * the explicit `context` tool.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { RunStateStore } from "../dist/context/state.js";
import { renderPromptMessages } from "../dist/context/render.js";
import { contextTool } from "../dist/tools/context.js";
import { readSemanticChanges } from "../dist/map/changes.js";
import { CORE_COMMANDS } from "../dist/commands/registry.js";

function tempDir(prefix = "mc-state-") {
  return mkdtempSync(join(tmpdir(), prefix));
}

const system = { role: "system", content: "system prompt" };
const user = { role: "user", content: "original goal" };
const assistant = ({ id = "c1", name = "read", args = {}, text = "I will inspect the target." } = {}) => ({
  role: "assistant",
  content: [
    ...(text ? [{ type: "text", text }] : []),
    { type: "toolCall", id, name, arguments: args },
  ],
});
const result = ({ id = "c1", name = "read", text = "1: one\n2: two", isError = false } = {}) => ({
  role: "toolResult",
  toolCallId: id,
  toolName: name,
  content: [{ type: "text", text }],
  isError,
});

test("state records decisions, next, focus, and artifacts", () => {
  const dir = tempDir();
  try {
    const store = new RunStateStore({ runDir: dir, runId: "r1", goal: "fix the lag" });
    store.note("decision", "Cache modelPreview per draw.");
    store.note("next", "Read newRunInsert, then edit.");
    store.focus(["src/tui.ts:2216-2256"]);
    const block = store.renderBlock();
    assert.match(block, /Goal: fix the lag/);
    assert.match(block, /Cache modelPreview per draw/);
    assert.match(block, /Next: Read newRunInsert/);
    assert.match(block, /src\/tui\.ts:2216-2256/);
    assert.ok(existsSync(join(dir, "state.jsonl")));
    assert.ok(existsSync(join(dir, "state.md")));
    assert.match(readFileSync(join(dir, "state.md"), "utf8"), /Run state: r1/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("issue facts render in the state block and update by number", () => {
  const dir = tempDir();
  try {
    const store = new RunStateStore({ runDir: dir, runId: "r-issue", goal: "plan" });
    store.addIssueFact(12, '#12 epic "Plan"');
    store.addIssueFact(13, '#13 feature "Gates" parent #12');
    store.addIssueFact(13, '#13 feature "Gates" parent #12 plan ready');
    const block = store.renderBlock();
    assert.match(block, /Issues:/);
    assert.match(block, /#12 epic "Plan"/);
    assert.match(block, /#13 feature "Gates" parent #12 plan ready/);
    assert.equal(block.match(/#13 feature/g)?.length, 1, "same issue updates in place");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("state block drops body findings before issue facts", () => {
  const dir = tempDir();
  try {
    const store = new RunStateStore({ runDir: dir, runId: "r-cap", goal: "plan" });
    store.addIssueFact(1, '#1 epic "Plan"');
    for (let number = 2; number < 42; number++) {
      store.addIssueBodyFact(number, "x".repeat(1_000));
    }
    const block = store.renderBlock();
    assert.ok(block.length <= 10_000, `state block is ${block.length} chars`);
    assert.match(block, /#1 epic "Plan"/);
    assert.doesNotMatch(block, /body:/, "body findings are dropped first");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("issue body facts stay compact in the run-state block", () => {
  const dir = tempDir();
  try {
    const store = new RunStateStore({ runDir: dir, runId: "r-body", goal: "plan" });
    store.addIssueBodyFact(7, "x".repeat(1_000));
    const block = store.renderBlock();
    assert.match(block, /#7 body: x/);
    assert.ok(block.length < 500, "body excerpt is capped to 300 chars");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ingestTurn records read facts, artifacts, working set, and changes", () => {
  const dir = tempDir();
  try {
    const store = new RunStateStore({ runDir: dir, runId: "r2", goal: "goal" });
    store.ingestTurn(
      [system, user, assistant({ args: { path: "src/tui.ts", offset: 10, limit: 5 } }), result()],
      1,
    );
    const read = store.getState().facts.find((fact) => fact.key.startsWith("read:"));
    assert.ok(read);
    assert.equal(read.refs[0].path, "src/tui.ts");
    assert.deepEqual(read.refs[0].range, [10, 14]);
    assert.ok(read.refs[0].artifact);
    assert.equal(store.getArtifact(read.refs[0].artifact), "1: one\n2: two");
    assert.equal(store.getState().workingSet.length, 1);

    store.ingestTurn(
      [
        system,
        user,
        assistant({ id: "c2", name: "edit", args: { path: "src/tui.ts" } }),
        result({ id: "c2", name: "edit", text: "edited src/tui.ts (1 replacement)" }),
      ],
      2,
    );
    assert.equal(read.status, "stale", "older ref to the changed path is stale");
    const change = store.getState().facts.find((fact) => fact.kind === "change");
    assert.ok(change);
    assert.match(change.text, /edited src\/tui\.ts/);
    assert.equal(store.getState().phase, "act");

    store.ingestTurn(
      [
        system,
        user,
        assistant({ id: "c3", name: "command", args: { action: "run", name: "typescript:test" } }),
        result({ id: "c3", name: "command", text: "# tests 1\n# pass 1\n# fail 0" }),
      ],
      3,
    );
    const command = store.getState().facts.find((fact) => fact.key === "command:typescript:test:true");
    assert.ok(command);
    assert.match(command.text, /# tests 1/);
    assert.match(command.text, /# pass 1/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("search facts count file, outline, and map matches", () => {
  const dir = tempDir();
  try {
    const store = new RunStateStore({ runDir: dir, runId: "r-search", goal: "plan" });
    store.ingestTurn(
      [
        system,
        user,
        assistant({ id: "s1", name: "search", args: { mode: "files", pattern: "data/**/*.{md,toml}" } }),
        result({ id: "s1", name: "search", text: "data/a.md\ndata/b.toml" }),
      ],
      1,
    );
    store.ingestTurn(
      [
        system,
        user,
        assistant({ id: "s2", name: "search", args: { mode: "outline", pattern: "plans/plan.md" } }),
        result({ id: "s2", name: "search", text: "plans/plan.md (762 lines)\n(no symbols)" }),
      ],
      2,
    );
    store.ingestTurn(
      [
        system,
        user,
        assistant({ id: "s3", name: "search", args: { mode: "map", path: "src/map" } }),
        result({ id: "s3", name: "search", text: "src/map/ (4 files)\n  changes.ts (103) — x" }),
      ],
      3,
    );
    const searches = store.getState().facts.filter((fact) => fact.text.startsWith("search "));
    const text = searches.map((fact) => fact.text).join("\n");
    assert.match(text, /files data\/\*\*\/\*\.\{md,toml\}" -> 2 refs: data\/a\.md, data\/b\.toml/);
    assert.match(text, /outline plans\/plan\.md" -> 1 ref: plans\/plan\.md/);
    assert.match(text, /map src\/map" -> 2 refs: src\/map\/, src\/map\/changes\.ts/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ingestTurn ignores harness errors from read and search", () => {
  const dir = tempDir();
  try {
    const store = new RunStateStore({ runDir: dir, runId: "r-errors", goal: "plan" });
    store.ingestTurn(
      [
        system,
        user,
        assistant({ id: "e1", name: "search", args: { mode: "files", pattern: "src/tools" } }),
        result({
          id: "e1",
          name: "search",
          text: "Planner has made 10 research/verification calls without an issue write.",
          isError: true,
        }),
      ],
      1,
    );
    store.ingestTurn(
      [
        system,
        user,
        assistant({ id: "e2", name: "read", args: { path: "src/tools/index.ts" } }),
        result({
          id: "e2",
          name: "read",
          text: "Read limit reached for src/tools/index.ts.",
          isError: true,
        }),
      ],
      2,
    );
    const block = store.renderBlock();
    assert.doesNotMatch(block, /Planner has made/);
    assert.doesNotMatch(block, /Read limit reached/);
    assert.equal(store.getState().workingSet.length, 0);
    assert.equal(store.getState().facts.filter((fact) => fact.key.startsWith("search:")).length, 0);
    assert.equal(store.getState().facts.filter((fact) => fact.key.startsWith("read:")).length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("explicit context focus survives automatic ingestion", () => {
  const dir = tempDir();
  try {
    const store = new RunStateStore({ runDir: dir, runId: "r3", goal: "goal" });
    store.focus(["src/other.ts:1-3"]);
    const contextCall = assistant({ id: "c3", name: "context", args: { action: "focus" }, text: "" });
    store.ingestTurn(
      [system, user, contextCall, result({ id: "c3", name: "context", text: "focused 1 ref" })],
      1,
    );
    assert.equal(store.getState().workingSet[0].path, "src/other.ts");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("render keeps only state plus the last step", () => {
  const dir = tempDir();
  try {
    const store = new RunStateStore({ runDir: dir, runId: "r4", goal: "the goal" });
    store.note("decision", "Use the map first.");
    const old = [
      assistant({ id: "old", args: { path: "old.ts", offset: 1, limit: 1 } }),
      result({ id: "old", text: "OLD-TOOL-BODY" }),
    ];
    const last = [
      assistant({ id: "new", args: { path: "new.ts", offset: 1, limit: 1 } }),
      result({ id: "new", text: "NEW-TOOL-BODY" }),
    ];
    const rendered = renderPromptMessages([system, user, ...old, ...last], store, "MAP-INDEX");
    const serialized = JSON.stringify(rendered.messages);
    assert.match(serialized, /the goal/);
    assert.match(serialized, /Use the map first/);
    assert.match(serialized, /MAP-INDEX/);
    assert.match(serialized, /NEW-TOOL-BODY/);
    assert.doesNotMatch(serialized, /OLD-TOOL-BODY/);
    assert.equal(rendered.messages[0].role, "system");
    assert.equal(rendered.messages[1].role, "user");
    assert.equal(rendered.messages[2].role, "assistant");
    assert.equal(rendered.messages[3].role, "toolResult");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("render puts the task packet before the repo map", () => {
  const dir = tempDir();
  try {
    const store = new RunStateStore({ runDir: dir, runId: "r4b", goal: "the goal" });
    const rendered = renderPromptMessages(
      [system, user, assistant()],
      store,
      "MAP-INDEX",
      "<context-block kind=\"task\">PACKET-BODY</context-block>",
    );
    const first = rendered.messages[1];
    const block = String(first.content ?? "");
    assert.ok(block.indexOf("PACKET-BODY") < block.indexOf("MAP-INDEX"), "packet leads the map");
    assert.match(block, /run-state/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("state renders read coverage and expires a stale next action", () => {
  const dir = tempDir();
  try {
    const store = new RunStateStore({ runDir: dir, runId: "r-coverage", goal: "goal" });
    store.note("next", "Explore the whole tree", [], 1);
    store.ingestTurn(
      [
        system,
        user,
        assistant({ id: "r1", name: "read", args: { path: "src/a.ts", offset: 1, limit: 100 } }),
        result({ id: "r1", name: "read", text: "1: first\n100: last" }),
      ],
      2,
    );
    store.ingestTurn(
      [
        system,
        user,
        assistant({ id: "r2", name: "read", args: { path: "src/a.ts", offset: 50, limit: 100 } }),
        result({ id: "r2", name: "read", text: "50: mid\n150: last" }),
      ],
      10,
    );
    const block = store.renderBlock();
    assert.match(block, /Read coverage:/);
    assert.match(block, /src\/a\.ts: 1-149/);
    assert.match(block, /Next: unset/);
    assert.doesNotMatch(block, /Next: Explore the whole tree/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the first change replaces the plan's first-edit next action", () => {
  const dir = tempDir();
  try {
    const store = new RunStateStore({ runDir: dir, runId: "r-plan-next", goal: "goal" });
    store.note("decision", "Plan: 1) Edit src/a.ts. 2) Add a test.", [], 1);
    store.note("next", "Execute the plan: make the first edit.", [], 1);
    assert.match(store.renderBlock(), /Next: Execute the plan: make the first edit/);

    store.addChangeFact("src/a.ts", { path: "src/a.ts" }, 2, "edited src/a.ts");
    const block = store.renderBlock();
    assert.doesNotMatch(block, /make the first edit/);
    assert.match(block, /Next: Verify the change/);
    assert.match(block, /Changes:/);
    assert.match(block, /change src\/a\.ts/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("render never sends an orphan tool call", () => {
  const dir = tempDir();
  try {
    const store = new RunStateStore({ runDir: dir, runId: "r5", goal: "goal" });
    const rendered = renderPromptMessages([system, user, assistant()], store);
    assert.equal(rendered.messages.length, 2);
    assert.equal(rendered.messages[1].role, "user");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("context tool notes, focuses, recalls, and reports state", async () => {
  const dir = tempDir();
  try {
    const store = new RunStateStore({ runDir: dir, runId: "r6", goal: "goal" });
    const artifact = store.putArtifact("exact bytes");
    const tool = contextTool({ root: dir, commands: CORE_COMMANDS, state: store });
    let outcome = await tool.execute("1", {
      action: "note",
      kind: "decision",
      text: "Use the smallest range.",
    });
    assert.equal(outcome.isError, undefined);
    outcome = await tool.execute("2", { action: "focus", refs: ["src/a.ts:1-2"] });
    assert.equal(outcome.isError, undefined);
    outcome = await tool.execute("3", { action: "recall", id: artifact.id });
    assert.match(outcome.content.map((c) => c.text ?? "").join("\n"), /exact bytes/);
    outcome = await tool.execute("4", { action: "state" });
    const text = outcome.content.map((c) => c.text ?? "").join("\n");
    assert.match(text, /Use the smallest range/);
    assert.match(text, /src\/a\.ts:1-2/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});


test("ingestTurn records a bounded change digest with actor intent", () => {
  const root = tempDir();
  try {
    const store = new RunStateStore({
      runDir: join(root, "run"),
      runId: "r6",
      goal: "goal",
      repoRoot: root,
    });
    const ingested = store.ingestTurn(
      [
        system,
        user,
        assistant({ id: "c6", name: "edit", args: { path: "src/tui.ts", oldString: "old", newString: "new" } }),
        result({ id: "c6", name: "edit", text: "edited src/tui.ts (1 replacement)" }),
      ],
      1,
      { agent: "build", model: "test/model" },
    );
    assert.equal(ingested.changed, true);
    const changes = readSemanticChanges(root);
    assert.equal(changes.length, 1);
    assert.equal(changes[0].path, "src/tui.ts");
    assert.equal(changes[0].agent, "build");
    assert.equal(changes[0].model, "test/model");
    assert.match(changes[0].detail, /1->1 lines/);
    assert.match(changes[0].detail, /intent: I will inspect the target/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("failed edits do not mark a change or record a digest", () => {
  const root = tempDir();
  try {
    const store = new RunStateStore({
      runDir: join(root, "run"),
      runId: "r7",
      goal: "goal",
      repoRoot: root,
    });
    const ingested = store.ingestTurn(
      [
        system,
        user,
        assistant({ id: "c7", name: "edit", args: { path: "src/tui.ts" } }),
        result({ id: "c7", name: "edit", text: "no match in src/tui.ts", isError: true }),
      ],
      1,
      { agent: "build", model: "test/model" },
    );
    assert.equal(ingested.changed, false);
    assert.equal(store.getState().facts.find((fact) => fact.kind === "change"), undefined);
    assert.equal(readSemanticChanges(root).length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});


test("git status detects command-side mutations without duplicating edits", () => {
  const root = tempDir("mc-git-");
  try {
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src", "a.ts"), "export const a = 1;\n", "utf8");
    const git = (...args) => execFileSync("git", args, { cwd: root, stdio: "ignore" });
    git("init", "-q");
    git("config", "user.email", "test@example.com");
    git("config", "user.name", "test");
    git("add", ".");
    git("commit", "-qm", "init");

    const store = new RunStateStore({
      runDir: join(root, "run"),
      runId: "r8",
      goal: "goal",
      repoRoot: root,
    });
    writeFileSync(join(root, "src", "a.ts"), "export const a = 2;\n", "utf8");
    const ingested = store.ingestTurn(
      [
        system,
        user,
        assistant({ id: "g1", name: "command", args: { action: "run", name: "core:status" }, text: "" }),
        result({ id: "g1", name: "command", text: "ok" }),
      ],
      1,
      { agent: "build", model: "test/model" },
    );
    assert.equal(ingested.changed, true);
    const changes = readSemanticChanges(root);
    assert.equal(changes.length, 1);
    assert.equal(changes[0].path, "src/a.ts");
    assert.equal(changes[0].tool, "git");
    assert.match(changes[0].detail, /via core:status/);
    const change = store.getState().facts.find((fact) => fact.kind === "change");
    assert.ok(change);
    assert.match(change.text, /git status changed 1 path/);
    assert.equal(change.refs[0].path, "src/a.ts");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
