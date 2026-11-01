/**
 * Benchmark parsing/scoring: Artificial Analysis composite indices are not
 * individual benchmark accuracies and must not be duplicated into GPQA, SWE,
 * or Terminal columns.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { scoresFromBenchmarks } from "../dist/catalogue/scoring.js";
import { parseOpenRouterBenchmarks } from "../dist/catalogue/openrouter.js";

test("composite indices are fallbacks, not duplicated direct tests", () => {
  const fallback = { reasoning: 5, code: 5, agentic: 5, general: 5 };
  const scores = scoresFromBenchmarks(
    {
      source: "OpenRouter/artificial-analysis",
      gpqa: 77.6,
      tauBench: 72.1,
      codingIndex: 28.7,
      agenticIndex: 1.2,
    },
    fallback,
  );
  assert.equal(scores.reasoning, 8.29);
  assert.equal(scores.code, 3.46, "coding index is used once, not as SWE + LiveCode + Terminal");
  assert.equal(scores.agentic, 3.88, "tau-bench and the agentic index are both one signal each");
  assert.equal(scores.general, 5, "no general benchmark or intelligence index");
});

test("intelligence index contributes once to reasoning and general", () => {
  const fallback = { reasoning: 4, code: 4, agentic: 4, general: 4 };
  const scores = scoresFromBenchmarks(
    { source: "OpenRouter/artificial-analysis", intelligenceIndex: 70, codingIndex: 60 },
    fallback,
  );
  assert.equal(scores.reasoning, 7.3);
  assert.equal(scores.general, 7.3);
  assert.equal(scores.code, 6.3);
  assert.equal(scores.agentic, 4);
});

test("Design Arena is not treated as LMArena", () => {
  const fallback = { reasoning: 4, code: 4, agentic: 4, general: 4 };
  const scores = scoresFromBenchmarks(
    { source: "OpenRouter/design-arena", designArena: 1400 },
    fallback,
  );
  assert.equal(scores.general, 4);
});

test("parser keeps Artificial Analysis indices separate from benchmark columns", () => {
  const parsed = parseOpenRouterBenchmarks({
    data: [
      {
        source: "artificial-analysis",
        model_permaslug: "owner/model-20260101",
        intelligence_index: 70,
        coding_index: 60,
        agentic_index: 40,
      },
      {
        source: "openrouter",
        model_permaslug: "owner/model-20260101",
        benchmark_type: "gpqa_diamond",
        accuracy: 0.8,
      },
      {
        source: "design-arena",
        model_permaslug: "owner/model-20260101",
        elo: 1236,
      },
    ],
  });
  const bench = parsed.get("owner/model");
  assert.ok(bench);
  assert.equal(bench.intelligenceIndex, 70);
  assert.equal(bench.codingIndex, 60);
  assert.equal(bench.agenticIndex, 40);
  assert.equal(bench.gpqa, 80);
  assert.equal(bench.sweBench, undefined);
  assert.equal(bench.liveCodeBench, undefined);
  assert.equal(bench.terminalBench, undefined);
  assert.equal(bench.tauBench, undefined);
  assert.equal(bench.designArena, 1236);
  assert.equal(bench.lmarena, undefined);
});
