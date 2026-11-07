/**
 * Per-model overrides from data/model-overrides.toml (machine override:
 * ~/.machine_code/data/model-overrides.toml). This is the hand-editable layer for
 * "actual" capability ratings and prices when generated metadata is wrong,
 * incomplete, or estimated.
 */
import { dirname, join } from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dataPath, loadTomlData } from "../data.js";
import { capabilityFrom } from "./scoring.js";
import type { CatalogueRow } from "./types.js";

export interface ModelOverride {
  reasoning?: number;
  code?: number;
  agentic?: number;
  general?: number;
  capability?: number;
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  context?: number;
  maxOutput?: number;
  free?: boolean;
  kind?: string;
  coding?: boolean;
  modes?: string[];
  /** Native tool-call support. TOML key may be `tool_call` or `toolCall`. */
  toolCall?: boolean;
}

function num(value: unknown, max = 10): number | undefined {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) && n >= 0 && n <= max ? n : undefined;
}

/** Apply one overlay entry; returns the fields that changed. */
export function applyModelOverrides(row: CatalogueRow, override: ModelOverride): string[] {
  const curated: string[] = [];
  const axes = ["reasoning", "code", "agentic", "general"] as const;
  let axisChanged = false;
  for (const axis of axes) {
    const value = num(override[axis]);
    if (value === undefined) continue;
    row.scores[axis] = value;
    axisChanged = true;
    curated.push(axis);
    if (row.provenance.scoreSources) row.provenance.scoreSources[axis] = "curated";
  }
  const composite = num(override.capability);
  if (composite !== undefined) {
    row.scores.capability = Math.round(composite * 10) / 10;
    curated.push("capability");
  } else if (axisChanged) {
    row.scores.capability = capabilityFrom(row.scores, row.context);
    curated.push("capability");
  }

  const pricingFields = { input: "input", output: "output", cacheRead: "cacheRead", cacheWrite: "cacheWrite" } as const;
  let pricingChanged = false;
  for (const [key, field] of Object.entries(pricingFields) as Array<[keyof typeof pricingFields, "input" | "output" | "cacheRead" | "cacheWrite"]>) {
    const value = num(override[key], Number.MAX_SAFE_INTEGER);
    if (value === undefined) continue;
    row.pricing[field] = value;
    pricingChanged = true;
    curated.push(key);
  }
  if (pricingChanged && row.pricing.input === 0 && row.pricing.output === 0) row.free = true;

  const context = num(override.context, Number.MAX_SAFE_INTEGER);
  if (context !== undefined && context > 0) {
    row.context = context;
    row.capabilities.contextWindow = context;
    curated.push("context");
  }
  const maxOutput = num(override.maxOutput, Number.MAX_SAFE_INTEGER);
  if (maxOutput !== undefined && maxOutput > 0) {
    row.maxOutput = maxOutput;
    row.capabilities.maxOutputTokens = maxOutput;
    curated.push("max_output");
  }
  if (typeof override.free === "boolean") {
    row.free = override.free;
    curated.push("free");
  }
  if (typeof override.kind === "string") {
    row.kind = override.kind as typeof row.kind;
    curated.push("kind");
  }
  if (typeof override.coding === "boolean") {
    row.coding = override.coding;
    curated.push("coding");
  }
  if (Array.isArray(override.modes)) {
    row.modes = override.modes.filter((m): m is string => typeof m === "string");
    curated.push("modes");
  }
  // Native tool-call support. pi-ai carries no tool-use flag, so dynamic
  // rows (e.g. Ollama) default to true; correct models proven unable to
  // emit native calls here so tool agents stop selecting them.
  const toolCall =
    typeof override.toolCall === "boolean"
      ? override.toolCall
      : typeof (override as Record<string, unknown>).tool_call === "boolean"
        ? ((override as Record<string, unknown>).tool_call as boolean)
        : undefined;
  if (toolCall !== undefined) {
    row.toolCall = toolCall;
    row.capabilities.toolCall = toolCall;
    const modes = new Set(row.modes);
    if (toolCall) modes.add("tools");
    else modes.delete("tools");
    row.modes = [...modes];
    curated.push("tool_call");
  }

  if (curated.length > 0) {
    row.provenance.curated = [...new Set([...row.provenance.curated, ...curated])];
    // Authored capability axes are not estimates, even if some axes still are.
    if (axisChanged || composite !== undefined) row.provenance.estimated = false;
  }
  return curated;
}

export function loadModelOverrides(): Map<string, ModelOverride> {
  const file = dataPath("model-overrides.toml");
  if (!existsSync(file)) return new Map();
  const raw = loadTomlData<{ models?: Record<string, ModelOverride> }>("model-overrides.toml");
  return new Map(Object.entries(raw.models ?? {}));
}

/**
 * Record an automatically detected dead model as a curation veto so refresh
 * drops the row instead of cooling it forever. Appends a dated, sourced
 * stanza; never rewrites the file (user comments and ordering survive), and
 * never duplicates a key that already has a stanza. Returns true when a
 * stanza was added. Never throws.
 */
export function addCurationVeto(home: string, key: string, source: string): boolean {
  const file = join(home, "curation.toml");
  let current = "";
  try {
    current = readFileSync(file, "utf8");
  } catch {
    // Missing file: created below.
  }
  const header = `[models."${key}"]`;
  if (current.includes(header)) return false;
  const date = new Date().toISOString().slice(0, 10);
  const stanza =
    `\n# Auto-vetoed: the model errored as gone at runtime; remove this stanza to restore it.\n` +
    `${header}\nveto = true\ndate = "${date}"\nsource = ${JSON.stringify(source)}\n`;
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${current.length > 0 && !current.endsWith("\n") ? `${current}\n` : current}${stanza}`, "utf8");
    return true;
  } catch {
    return false;
  }
}
