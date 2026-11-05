/**
 * Task context pack: model-derived budgets and symbol-aware file selection.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { contextBudget } from "../dist/context/budget.js";
import { buildTaskPack, renderContextPack } from "../dist/context/pack.js";
import { renderPromptMessages } from "../dist/context/render.js";
import { RunStateStore } from "../dist/context/state.js";

function tempRepo() {
  const root = mkdtempSync(join(tmpdir(), "mc-pack-"));
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(join(root, "test"), { recursive: true });
  return root;
}

test("input budget scales with the model window", () => {
  const small = contextBudget(32_000, 2_000);
  const large = contextBudget(1_000_000, 2_000);
  assert.ok(small.inputTokens > 8_000);
  assert.ok(large.inputTokens > small.inputTokens * 10);
  assert.equal(small.inputChars, small.inputTokens * 4);
  assert.equal(large.inputChars, large.inputTokens * 4);
});

test("task pack includes full task files, tests, and one-hop dependencies", () => {
  const root = tempRepo();
  try {
    writeFileSync(
      join(root, "src", "a.ts"),
      "import { helper } from './dep.js';\nexport function target() { return helper(); }\n",
      "utf8",
    );
    writeFileSync(join(root, "src", "dep.ts"), "export function helper() { return 1; }\n", "utf8");
    writeFileSync(join(root, "src", "consumer.ts"), "import { target } from './a.js';\ntarget();\n", "utf8");
    writeFileSync(join(root, "test", "a.test.js"), "test('a', () => {});\n", "utf8");
    const mapFiles = [
      { path: "src/a.ts", lang: "ts", bytes: 80, lines: 2, symbols: [{ name: "target", kind: "function", line: 2, end: 2 }], imports: ["src/dep.ts"] },
      { path: "src/dep.ts", lang: "ts", bytes: 40, lines: 1, symbols: [{ name: "helper", kind: "function", line: 1, end: 1 }], imports: [] },
      { path: "src/consumer.ts", lang: "ts", bytes: 45, lines: 2, symbols: [], imports: ["src/a.ts"] },
      { path: "test/a.test.js", lang: "js", bytes: 22, lines: 1, symbols: [], imports: [] },
    ];
    const pack = buildTaskPack({
      root,
      request: "Change src/a.ts and add tests",
      mapFiles,
      budgetChars: 200_000,
      maxFiles: 8,
    });
    const refs = pack.items.map((item) => item.ref);
    assert.ok(refs.includes("src/a.ts"), "task file is in the pack");
    assert.ok(refs.includes("test/a.test.js"), "inferred test is in the pack");
    assert.ok(refs.includes("src/dep.ts"), "direct import is in the pack");
    assert.ok(refs.includes("src/consumer.ts"), "reverse dependency is in the pack");
    assert.equal(pack.items.find((item) => item.ref === "src/a.ts")?.kind, "file");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("task keywords select relevant knowledge notes", () => {
  const root = tempRepo();
  try {
    mkdirSync(join(root, "knowledge"), { recursive: true });
    writeFileSync(join(root, "knowledge", "zebracorn.md"), "# Zebracorn\nzebracorn behaviour notes\n", "utf8");
    writeFileSync(join(root, "knowledge", "unrelated.md"), "# Other\nnothing here\n", "utf8");
    const pack = buildTaskPack({
      root,
      request: "Fix the zebracorn behaviour",
      mapFiles: [],
      budgetChars: 20_000,
      maxFiles: 2,
    });
    assert.ok(pack.items.some((item) => item.kind === "knowledge" && item.ref === "knowledge/zebracorn.md"));
    assert.ok(!pack.items.some((item) => item.ref === "knowledge/unrelated.md"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a large file becomes an outline plus named symbol bodies", () => {
  const root = tempRepo();
  try {
    const lines = Array.from({ length: 900 }, (_, index) => `const value${index} = ${index};`);
    lines[450] = "export function bigFunction() {";
    lines[451] = "  return 1;";
    lines[452] = "}";
    writeFileSync(join(root, "src", "big.ts"), `${lines.join("\n")}\n`, "utf8");
    const mapFiles = [
      {
        path: "src/big.ts",
        lang: "ts",
        bytes: 20_000,
        lines: 900,
        symbols: [{ name: "bigFunction", kind: "function", line: 451, end: 453 }],
        imports: [],
      },
    ];
    const pack = buildTaskPack({
      root,
      request: "Change bigFunction in src/big.ts",
      planText: "Edit src/big.ts bigFunction.",
      mapFiles,
      budgetChars: 20_000,
      maxFiles: 4,
    });
    const refs = pack.items.map((item) => item.ref);
    assert.ok(refs.includes("src/big.ts"), "large file has an outline item");
    assert.ok(pack.items.some((item) => item.kind === "outline" && item.ref === "src/big.ts"));
    const symbol = pack.items.find((item) => item.kind === "symbol" && item.ref === "src/big.ts#bigFunction");
    assert.ok(symbol, "named symbol body is included");
    assert.match(symbol.body, /export function bigFunction/);
    assert.ok(symbol.chars < 1_000, "only the symbol body is included, not the whole file");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the prompt uses the task pack in place of the working-context slice", () => {
  const dir = mkdtempSync(join(tmpdir(), "mc-pack-prompt-"));
  try {
    const store = new RunStateStore({ runDir: dir, runId: "r-pack", goal: "goal" });
    store.note("decision", "Edit src/a.ts.", [], 1);
    const rendered = renderPromptMessages(
      [
        { role: "system", content: "system" },
        { role: "user", content: "original" },
      ],
      store,
      "MAP-INDEX",
      '<context><context-block kind="file" source="src/a.ts">TRUNCATED</context-block><context-block kind="task">TASK</context-block></context>',
      "<task-pack>PACK-BODY</task-pack>",
    );
    const user = rendered.messages.find((message) => message.role === "user");
    const content = String(user?.content ?? "");
    assert.match(content, /PACK-BODY/);
    assert.match(content, /MAP-INDEX/);
    assert.match(content, /TASK/);
    assert.doesNotMatch(content, /TRUNCATED/);
    assert.doesNotMatch(content, /<working-context>/);

    const onlyFile = renderPromptMessages(
      [
        { role: "system", content: "system" },
        { role: "user", content: "original" },
      ],
      store,
      "MAP",
      '<context><context-block kind="file" source="src/a.ts">TRUNCATED</context-block></context>',
      "<task-pack>PACK-BODY</task-pack>",
    );
    const onlyFileContent = String(onlyFile.messages.find((message) => message.role === "user")?.content ?? "");
    assert.doesNotMatch(onlyFileContent, /TRUNCATED/);
    assert.doesNotMatch(onlyFileContent, /<context>/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a tight budget falls back to the outline instead of clipping mid-file", () => {
  const root = tempRepo();
  try {
    const lines = Array.from({ length: 200 }, (_, index) => `const value${index} = ${index};`);
    lines[100] = "export function target() { return 1; }";
    writeFileSync(join(root, "src", "a.ts"), `${lines.join("\n")}\n`, "utf8");
    const pack = buildTaskPack({
      root,
      request: "Change src/a.ts target",
      mapFiles: [
        {
          path: "src/a.ts",
          lang: "ts",
          bytes: 5_000,
          lines: 200,
          symbols: [{ name: "target", kind: "function", line: 101, end: 101 }],
          imports: [],
        },
      ],
      budgetChars: 20_000,
      maxFiles: 2,
    });
    const rendered = renderContextPack(pack, { maxChars: 600, perItemChars: 600 });
    assert.match(rendered.text, /outline\/tail; full body omitted/);
    assert.match(rendered.text, /target/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the overview keeps high-priority blocks and trims the rest", () => {
  const dir = mkdtempSync(join(tmpdir(), "mc-pack-overview-"));
  try {
    const store = new RunStateStore({ runDir: dir, runId: "r-overview", goal: "goal" });
    const startup = [
      "<context>",
      '<context-block kind="task">TASK-BODY</context-block>',
      `<context-block kind="knowledge">${"x".repeat(300)}</context-block>`,
      '<context-block kind="plan">PLAN-BODY</context-block>',
      "</context>",
    ].join("\n");
    const rendered = renderPromptMessages(
      [
        { role: "system", content: "system" },
        { role: "user", content: "original" },
      ],
      store,
      "MAP",
      startup,
      undefined,
      undefined,
      180,
    );
    const content = String(rendered.messages.find((message) => message.role === "user")?.content ?? "");
    assert.match(content, /TASK-BODY/);
    assert.match(content, /omitted/);
    assert.doesNotMatch(content, /x{100}/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the renderer fits the pack to its budget and names what it dropped", () => {
  const root = tempRepo();
  try {
    writeFileSync(join(root, "src", "a.ts"), "export const a = 1;\n", "utf8");
    writeFileSync(join(root, "src", "b.ts"), "export const b = 2;\n", "utf8");
    const pack = buildTaskPack({
      root,
      request: "Change src/a.ts and src/b.ts",
      mapFiles: [
        { path: "src/a.ts", lang: "ts", bytes: 20, lines: 1, symbols: [], imports: [] },
        { path: "src/b.ts", lang: "ts", bytes: 20, lines: 1, symbols: [], imports: [] },
      ],
      budgetChars: 20_000,
      maxFiles: 4,
    });
    const full = renderContextPack(pack, { maxChars: 20_000 });
    assert.match(full.text, /src\/a\.ts/);
    assert.match(full.text, /src\/b\.ts/);
    assert.equal(full.omitted.length, 0);

    const tiny = renderContextPack(pack, { maxChars: 120, perItemChars: 120 });
    assert.ok(tiny.chars <= 120, `rendered ${tiny.chars} chars`);
    assert.ok(tiny.omitted.length > 0);
    assert.match(tiny.text, /Context omitted for budget/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
