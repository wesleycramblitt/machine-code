/**
 * Run state: facts, working set, artifacts, ingestion, prompt rendering, and
 * the explicit `context` tool.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
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

test("a non-content read note never becomes read coverage", () => {
  const dir = tempDir();
  try {
    const store = new RunStateStore({ runDir: dir, runId: "r-note", goal: "plan" });
    store.ingestTurn(
      [
        system,
        user,
        assistant({ id: "n1", name: "read", args: { path: "src/big.ts" } }),
        result({
          id: "n1",
          name: "read",
          text: "[src/big.ts is 900 lines / 30000 bytes; full read exceeds 24576 bytes]\nexport function run()",
        }),
      ],
      1,
    );
    const block = store.renderBlock();
    assert.equal(store.getState().facts.filter((fact) => fact.key.startsWith("read:")).length, 0);
    assert.doesNotMatch(block, /Read coverage:/);
    assert.equal(store.getState().workingSet.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the evidence ledger caches unchanged reads and drops changed paths", () => {
  const dir = tempDir();
  const root = tempDir("mc-ledger-");
  try {
    const file = join(root, "src.ts");
    writeFileSync(file, "export const a = 1;\n", "utf8");
    const stat = statSync(file);
    const sig = `${stat.mtimeMs}:${stat.size}`;
    const store = new RunStateStore({ runDir: dir, runId: "r-ledger", goal: "goal", repoRoot: root });
    store.rememberRead({
      key: "src.ts#symbol:a",
      path: "src.ts",
      label: "src.ts#a",
      kind: "symbol",
      content: "1: export const a = 1;",
      fileSig: sig,
    });
    assert.equal(store.cachedRead("src.ts#symbol:a", sig), "1: export const a = 1;");
    assert.equal(store.cachedRead("src.ts#symbol:a", "different"), null);

    const ledger = store.renderLedger({ maxChars: 2_000 });
    assert.match(ledger, /<ledger>/);
    assert.match(ledger, /src\.ts#a/);
    assert.match(ledger, /export const a = 1/);

    const excluded = store.renderLedger({ maxChars: 2_000, excludePaths: new Set(["src.ts"]) });
    assert.equal(excluded, "");

    store.addChangeFact("src.ts", { path: "src.ts" }, 2, "edited src.ts");
    assert.equal(store.cachedRead("src.ts#symbol:a", sig), null);
    assert.equal(store.renderLedger({ maxChars: 2_000 }), "");
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test("the evidence ledger hides a stale file signature", () => {
  const dir = tempDir();
  const root = tempDir("mc-ledger-stale-");
  try {
    const file = join(root, "src.ts");
    writeFileSync(file, "one\n", "utf8");
    const first = statSync(file);
    const store = new RunStateStore({ runDir: dir, runId: "r-ledger-stale", goal: "goal", repoRoot: root });
    store.rememberRead({
      key: "src.ts#full",
      path: "src.ts",
      label: "src.ts",
      kind: "file",
      content: "1: one",
      fileSig: `${first.mtimeMs}:${first.size}`,
    });
    assert.match(store.renderLedger({ maxChars: 2_000 }), /1: one/);

    writeFileSync(file, "two\n", "utf8");
    const second = statSync(file);
    store.rememberRead({
      key: "src.ts#full",
      path: "src.ts",
      label: "src.ts",
      kind: "file",
      content: "1: two",
      fileSig: `${second.mtimeMs}:${second.size}`,
    });
    const ledger = store.renderLedger({ maxChars: 2_000 });
    assert.match(ledger, /1: two/);
    assert.doesNotMatch(ledger, /1: one/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
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

test("render keeps state and the last two complete steps", () => {
  const dir = tempDir();
  try {
    const store = new RunStateStore({ runDir: dir, runId: "r4", goal: "the goal" });
    store.note("decision", "Use the map first.");
    const older = [
      assistant({ id: "older", args: { path: "older.ts", offset: 1, limit: 1 } }),
      result({ id: "older", text: "OLDER-TOOL-BODY" }),
    ];
    const old = [
      assistant({ id: "old", args: { path: "old.ts", offset: 1, limit: 1 } }),
      result({ id: "old", text: "OLD-TOOL-BODY" }),
    ];
    const last = [
      assistant({ id: "new", args: { path: "new.ts", offset: 1, limit: 1 } }),
      result({ id: "new", text: "NEW-TOOL-BODY" }),
    ];
    const rendered = renderPromptMessages([system, user, ...older, ...old, ...last], store, "MAP-INDEX");
    const serialized = JSON.stringify(rendered.messages);
    assert.match(serialized, /the goal/);
    assert.match(serialized, /Use the map first/);
    assert.match(serialized, /MAP-INDEX/);
    assert.match(serialized, /OLD-TOOL-BODY/);
    assert.match(serialized, /NEW-TOOL-BODY/);
    assert.doesNotMatch(serialized, /OLDER-TOOL-BODY/);
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

test("command describe is not a gate run or a verification", () => {
  const dir = tempDir();
  try {
    const store = new RunStateStore({ runDir: dir, runId: "r-describe", goal: "goal" });
    const ingested = store.ingestTurn(
      [
        system,
        user,
        assistant({ id: "d1", name: "command", args: { action: "describe", name: "typescript:test" } }),
        result({ id: "d1", name: "command", text: '{"name":"typescript:test"}' }),
      ],
      1,
    );
    assert.equal(ingested.changed, false);
    assert.equal(store.getState().phase, "orient");
    assert.equal(store.getState().facts.find((fact) => fact.key === "command:typescript:test:true"), undefined);
    assert.doesNotMatch(store.renderBlock(), /Next: Verify the change/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an edit invalidates only overlapping read coverage", () => {
  const dir = tempDir();
  const root = tempDir("mc-state-range-");
  try {
    execFileSync("git", ["init", "-q"], { cwd: root });
    const file = join(root, "src.ts");
    const lines = Array.from({ length: 200 }, (_, index) => `line ${index + 1}`);
    writeFileSync(file, `${lines.join("\n")}\n`, "utf8");
    const store = new RunStateStore({ runDir: dir, runId: "r-range", goal: "goal", repoRoot: root });

    store.ingestTurn(
      [
        system,
        user,
        assistant({ id: "r1", name: "read", args: { path: "src.ts", offset: 1, limit: 10 } }),
        result({ id: "r1", name: "read", text: "src.ts:1-10\n1: line 1\n10: line 10" }),
      ],
      2,
    );
    store.ingestTurn(
      [
        system,
        user,
        assistant({ id: "r2", name: "read", args: { path: "src.ts", offset: 100, limit: 21 } }),
        result({ id: "r2", name: "read", text: "src.ts:100-120\n100: line 100\n120: line 120" }),
      ],
      3,
    );

    lines[109] = "line 110 changed";
    writeFileSync(file, `${lines.join("\n")}\n`, "utf8");
    store.ingestTurn(
      [
        system,
        user,
        assistant({
          id: "e1",
          name: "edit",
          args: { path: "src.ts", oldString: "line 110", newString: "line 110 changed" },
        }),
        result({ id: "e1", name: "edit", text: "edited src.ts (1 replacement)" }),
      ],
      4,
    );

    const block = store.renderBlock();
    assert.match(block, /src\.ts: 1-10/);
    assert.doesNotMatch(block, /src\.ts:.*100-120/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test("working context seeds task files and follows edits", () => {
  const dir = tempDir();
  const root = tempDir("mc-state-working-");
  try {
    execFileSync("git", ["init", "-q"], { cwd: root });
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "a.ts"), "export const a = 1;\n", "utf8");
    const store = new RunStateStore({ runDir: dir, runId: "r-working", goal: "goal", repoRoot: root });

    store.seedWorkingFiles(["src/a.ts"], 0);
    let working = store.renderWorkingContext();
    assert.match(working, /<working-context>/);
    assert.match(working, /preloaded task file/);
    assert.match(working, /1: export const a = 1;/);
    assert.match(JSON.stringify(renderPromptMessages([system, user, assistant()], store, "MAP").messages), /<working-context>/);

    writeFileSync(join(root, "src", "a.ts"), "export const a = 2;\n", "utf8");
    store.ingestTurn(
      [
        system,
        user,
        assistant({
          id: "e1",
          name: "edit",
          args: { path: "src/a.ts", oldString: "export const a = 1;", newString: "export const a = 2;" },
        }),
        result({ id: "e1", name: "edit", text: "edited src/a.ts (1 replacement)" }),
      ],
      1,
    );

    working = store.renderWorkingContext();
    assert.match(working, /current after change/);
    assert.match(working, /1: export const a = 2;/);
    assert.doesNotMatch(working, /1: export const a = 1;/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test("working context stays within its budget on large files", () => {
  const dir = tempDir();
  const root = tempDir("mc-state-working-big-");
  try {
    const lines = Array.from(
      { length: 500 },
      (_, i) => `const pad${i} = "padding line number ${i} to pass sixty bytes easily";`,
    );
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "big.ts"), lines.join("\n") + "\n", "utf8");
    execFileSync("git", ["init", "-q"], { cwd: root });
    const store = new RunStateStore({ runDir: dir, runId: "r-working-big", goal: "goal", repoRoot: root });
    store.seedWorkingFiles(["src/big.ts"], 0);
    const working = store.renderWorkingContext();
    assert.match(working, /<working-context>/);
    assert.ok(working.length <= 8200, `working context is capped near 8k chars (got ${working.length})`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
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


test("context tool treats strict-schema null optionals as absent", async () => {
  const dir = tempDir();
  try {
    const store = new RunStateStore({ runDir: dir, runId: "r-null", goal: "goal" });
    const tool = contextTool({ root: dir, commands: CORE_COMMANDS, state: store });
    const outcome = await tool.execute("1", {
      action: "note",
      kind: null,
      text: "Null optional fields are absent.",
      refs: null,
      id: null,
    });
    assert.equal(outcome.isError, undefined);
    assert.equal(store.getState().facts[0]?.kind, "finding");
    assert.match(store.renderBlock(), /Null optional fields are absent/);
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
    const block = store.renderBlock();
    assert.doesNotMatch(block, /Next: Verify the change/);
    assert.match(block, /Tree changes \(not from this run\):/);
    assert.doesNotMatch(block, /^Changes:$/m);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("working context keeps early tool reads on long runs (no recency eviction)", () => {
  const dir = tempDir();
  const root = tempDir("mc-state-noreevict-");
  try {
    execFileSync("git", ["init", "-q"], { cwd: root });
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "early.ts"), "export const early = 1;\nexport const late = 2;\n", "utf8");
    const store = new RunStateStore({ runDir: dir, runId: "r-noreevict", goal: "goal", repoRoot: root });
    store.ingestTurn(
      [
        system,
        user,
        assistant({ id: "r1", name: "read", args: { path: "src/early.ts", offset: 1, limit: 2 } }),
        result({ id: "r1", name: "read", text: "1: export const early = 1;\n2: export const late = 2;" }),
      ],
      0,
    );
    let working = store.renderWorkingContext();
    assert.match(working, /early\.ts/);
    // Advance the clock far past the old 8-turn eviction window.
    store.note("next", "keep surveying", [], 20);
    working = store.renderWorkingContext();
    assert.match(working, /early\.ts/, "early paged read stays pinned instead of forcing a re-read");
    assert.match(working, /export const early = 1;/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test("seedWorkingFiles skips oversized files", () => {
  const dir = tempDir();
  const root = tempDir("mc-state-seedcap-");
  try {
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "small.ts"), "export const s = 1;\n", "utf8");
    writeFileSync(join(root, "src", "big.ts"), `export const b = 1;\n// ${"x".repeat(70 * 1024)}\n`, "utf8");
    const store = new RunStateStore({ runDir: dir, runId: "r-seedcap", goal: "goal", repoRoot: root });
    store.seedWorkingFiles(["src/small.ts", "src/big.ts", "src/missing.ts"], 0);
    const working = store.renderWorkingContext();
    assert.match(working, /small\.ts/);
    assert.doesNotMatch(working, /big\.ts/, "files over the seed cap stay discoverable, not pinned");
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});
