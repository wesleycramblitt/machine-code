/**
 * Run inspection: live model deltas and authoritative turn text group cleanly.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { thinkingChunks, touchedPaths, childRuns, relatedRuns, readContextPackManifest } from "../dist/report/run.js";

test("thinking chunks combine live deltas and final turn text", () => {
  const events = [
    { t: "2026-01-01T00:00:01Z", type: "model_delta", call: 1, kind: "thinking", text: "consider " },
    { t: "2026-01-01T00:00:02Z", type: "model_delta", call: 1, kind: "thinking", text: "the parser" },
    { t: "2026-01-01T00:00:03Z", type: "model_delta", call: 1, kind: "text", text: "draft" },
    { t: "2026-01-01T00:00:04Z", type: "model_call_end", call: 1, text: "final answer" },
  ];
  const chunks = thinkingChunks(events);
  assert.deepEqual(chunks.map((chunk) => chunk.kind), ["thinking", "text"]);
  assert.equal(chunks[0].text, "consider the parser");
  assert.equal(chunks[1].text, "final answer");
  assert.equal(chunks[1].complete, true);
});

test("thinking chunks keep retries separate when call indices reset", () => {
  const events = [
    { t: "2026-01-01T00:00:01Z", type: "model_select", call: 0 },
    { t: "2026-01-01T00:00:02Z", type: "model_delta", call: 1, kind: "text", text: "first draft" },
    { t: "2026-01-01T00:00:03Z", type: "model_call_end", call: 1, text: "first answer" },
    { t: "2026-01-01T00:00:04Z", type: "model_select", call: 0 },
    { t: "2026-01-01T00:00:05Z", type: "model_delta", call: 1, kind: "text", text: "second draft" },
    { t: "2026-01-01T00:00:06Z", type: "model_call_end", call: 1, text: "second answer" },
  ];
  const chunks = thinkingChunks(events);
  assert.deepEqual(chunks.map((chunk) => chunk.text), ["first answer", "second answer"]);
  assert.equal(chunks[0].attempt, 1);
  assert.equal(chunks[1].attempt, 2);
});

test("touched paths and child runs are derived from events and lineage", () => {
  const events = [
    { t: "2026-01-01T00:00:01Z", type: "tool_call", tool: "write", args: { path: "src/a.ts" } },
    { t: "2026-01-01T00:00:02Z", type: "tool_call", tool: "edit", args: { path: "src/b.ts" } },
    { t: "2026-01-01T00:00:03Z", type: "tool_call", tool: "read", args: { path: "README.md" } },
  ];
  assert.deepEqual(touchedPaths(events), ["src/a.ts", "src/b.ts"]);
  const runs = [
    { id: "parent" },
    { id: "child", parentRunId: "parent", startedAt: "2026-01-01T00:00:00Z" },
    { id: "other", parentRunId: "nope", startedAt: "2026-01-01T00:00:00Z" },
  ];
  assert.deepEqual(childRuns(runs, "parent").map((run) => run.id), ["child"]);
});

test("context pack manifests are read defensively", () => {
  const dir = mkdtempSync(join(tmpdir(), "mc-pack-manifest-"));
  try {
    writeFileSync(
      join(dir, "context-pack.json"),
      JSON.stringify({
        model: "opencode-go/deepseek-v4.1-flash",
        contextWindow: 1_000_000,
        inputBudgetTokens: 988_000,
        overviewChars: 2_400,
        pack: {
          chars: 90_000,
          tokens: 22_500,
          files: ["src/a.ts"],
          items: [{ kind: "file", ref: "src/a.ts", chars: 1_000, tokens: 250, reason: "task file" }],
        },
        rendered: { chars: 88_000, included: 1, omitted: [] },
        ledger: { chars: 1_200, entries: [{ key: "src/a.ts#full", path: "src/a.ts", label: "src/a.ts", kind: "file", chars: 1_200, turn: 2 }] },
      }),
      "utf8",
    );
    const manifest = readContextPackManifest(dir);
    assert.ok(manifest);
    assert.equal(manifest?.pack.items[0].ref, "src/a.ts");
    assert.equal(manifest?.pack.tokens, 22_500);
    assert.equal(manifest?.ledger.entries[0].path, "src/a.ts");

    writeFileSync(join(dir, "context-pack.json"), "{bad json", "utf8");
    assert.equal(readContextPackManifest(dir), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("related runs include lineage and same-orchestration task siblings", () => {
  const summary = {
    id: "build",
    orchestrationId: "orch-1",
    taskIssue: { repo: "o/r", number: 5 },
    rootRunId: "build",
    parentRunId: "parent",
    startedAt: "2026-01-01T00:00:00Z",
  };
  const runs = [
    summary,
    { id: "parent", startedAt: "2025-12-31T00:00:00Z" },
    { id: "review", orchestrationId: "orch-1", taskIssue: { repo: "o/r", number: 5 }, startedAt: "2026-01-01T00:00:01Z" },
    { id: "fork", rootRunId: "build", startedAt: "2026-01-01T00:00:02Z" },
    { id: "other", orchestrationId: "orch-2", taskIssue: { repo: "o/r", number: 6 }, startedAt: "2026-01-01T00:00:03Z" },
  ];
  assert.deepEqual(relatedRuns(runs, summary).map((run) => run.id), ["fork", "review", "parent"]);
});
