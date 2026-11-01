/**
 * machine_code — benchmark lookup.
 *
 * Data lives in data/benchmarks.json (machine override:
 * ~/.machine_code/data/benchmarks.json). Only models with published results
 * are listed; anything absent is derived in scoring.ts and flagged estimated.
 */
import { readFileSync } from "node:fs";
import { dataPath } from "../data.js";

export interface Benchmarks {
  lmarena?: number; sweBench?: number; sweBenchMultimodal?: number
  terminalBench?: number; tauBench?: number; aime?: number
  gpqa?: number; liveCodeBench?: number; math?: number
  mmluPro?: number; ifeval?: number; osworld?: number; mmmu?: number
  /** Artificial Analysis composite indices (0-100), not individual tests. */
  intelligenceIndex?: number; codingIndex?: number; agenticIndex?: number
  /** Design Arena Elo (not an LMArena score; kept for visibility, not scoring). */
  designArena?: number
  source: string
}

interface BenchmarkData {
  sources?: Record<string, string>;
  benchmarks?: Record<string, Benchmarks>;
}

const data = JSON.parse(readFileSync(dataPath("benchmarks.json"), "utf8")) as BenchmarkData;

export const SOURCES = data.sources ?? {};
export const BENCHMARKS: Record<string, Benchmarks> = data.benchmarks ?? {};

export function benchmarksFor(canonicalID: string | null | undefined): Benchmarks | null {
  if (!canonicalID) return null
  const direct = BENCHMARKS[canonicalID]
  if (direct) return direct
  const stripped = canonicalID.replace(/-(preview|latest|exp|chat|instruct|\d{4}-\d{2}-\d{2}|\d{4})$/, "")
  if (stripped !== canonicalID) {
    const match = BENCHMARKS[stripped]
    if (match) return match
  }
  const tail = canonicalID.split("/").pop() ?? ""
  for (const [key, value] of Object.entries(BENCHMARKS)) {
    if (key.split("/").pop() === tail) return value
  }
  return null
}

export function hasBenchmarks(canonicalID: string | null | undefined): boolean {
  return benchmarksFor(canonicalID) !== null
}

export function benchmarkCoverage(): { curated: number; keys: string[] } {
  return { curated: Object.keys(BENCHMARKS).length, keys: Object.keys(BENCHMARKS) }
}
