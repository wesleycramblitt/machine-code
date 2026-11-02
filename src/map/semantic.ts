/**
 * machine_code — semantic map: bounded module annotations over the
 * deterministic map. One model call per refresh; the deterministic facts stay
 * authoritative.
 */
import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { Context, Usage } from "@earendil-works/pi-ai";
import type { MutableModels, ChatModel } from "../models.js";
import { truncateToBytes } from "../tools/safety.js";
import { renderRepoMap, type RepoMap } from "./deterministic.js";

export const SEMANTIC_SCHEMA = 1 as const;
const SEMANTIC_CAP_BYTES = 16 * 1024;
const SEMANTIC_INPUT_BYTES = 12 * 1024;

export interface SemanticEntry {
  summary: string;
  keyFiles?: string[];
  editHints?: string[];
}

export interface SemanticMap {
  schema: typeof SEMANTIC_SCHEMA;
  baseCommit: string;
  mapHash: string;
  generatedAt: string;
  model: string;
  modules: Record<string, SemanticEntry>;
}

export interface SemanticTask {
  prompt: string;
  modules: string[];
}

export interface SemanticModelResult {
  text: string;
  usage?: Usage;
  stopReason?: string;
}

function cacheDir(root: string): string {
  return join(root, ".machine_code", "local", "cache", "map");
}

export function semanticPath(root: string): string {
  return join(cacheDir(root), "semantic.json");
}

export function semanticDirtyPath(root: string): string {
  return join(cacheDir(root), "semantic.dirty");
}

export function mapHashOf(map: RepoMap): string {
  return createHash("sha256").update(JSON.stringify(map)).digest("hex");
}

/** Top-level module: `src/<dir>` for source trees, otherwise the first segment. */
export function moduleOf(path: string): string {
  const parts = path.split("/");
  if (parts[0] === "src" && parts.length > 2) return `src/${parts[1]}`;
  return parts.length > 1 ? parts[0]! : ".";
}

export function moduleNames(map: RepoMap): string[] {
  return [...new Set(map.files.map((file) => moduleOf(file.path)))].sort((a, b) => {
    if (a === ".") return -1;
    if (b === ".") return 1;
    return a.localeCompare(b);
  });
}

export function readSemanticDirty(root: string): string[] {
  const file = semanticDirtyPath(root);
  if (!existsSync(file)) return [];
  return [...new Set(readFileSync(file, "utf8").split("\n").map((line) => line.trim()).filter(Boolean))];
}

export function markSemanticDirty(root: string, paths: readonly string[]): void {
  if (paths.length === 0) return;
  const file = semanticDirtyPath(root);
  mkdirSync(cacheDir(root), { recursive: true });
  const existing = new Set(readSemanticDirty(root));
  for (const path of paths) if (path) existing.add(path);
  writeFileSync(file, `${[...existing].sort().join("\n")}\n`, "utf8");
}

export function clearSemanticDirty(root: string, paths?: readonly string[]): void {
  const file = semanticDirtyPath(root);
  if (!existsSync(file)) return;
  if (!paths) {
    try { rmSync(file, { force: true }); } catch { /* best effort */ }
    return;
  }
  const keep = readSemanticDirty(root).filter((path) => !paths.includes(path));
  if (keep.length === 0) {
    try { rmSync(file, { force: true }); } catch { /* best effort */ }
  } else {
    writeFileSync(file, `${keep.join("\n")}\n`, "utf8");
  }
}

export function loadSemantic(root: string): SemanticMap | null {
  const file = semanticPath(root);
  if (!existsSync(file)) return null;
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as SemanticMap;
    if (raw?.schema !== SEMANTIC_SCHEMA || typeof raw.modules !== "object") return null;
    return raw;
  } catch {
    return null;
  }
}

export function isSemanticFresh(semantic: SemanticMap | null, map: RepoMap, dirty: readonly string[]): boolean {
  if (!semantic) return false;
  if (dirty.length > 0) return false;
  return semantic.baseCommit === map.head && semantic.mapHash === mapHashOf(map);
}

function writeSemantic(root: string, semantic: SemanticMap): void {
  const file = semanticPath(root);
  mkdirSync(cacheDir(root), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(semantic, null, 2) + "\n", "utf8");
    renameSync(tmp, file);
  } catch (error) {
    try { rmSync(tmp, { force: true }); } catch { /* best effort */ }
    throw error;
  }
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`;
}

export interface SemanticTaskInput {
  root: string;
  map: RepoMap;
  existing: SemanticMap | null;
  dirtyPaths: readonly string[];
}

/** Build one bounded prompt. Dirty modules are refreshed; a cold map is full. */
export function buildSemanticTask(input: SemanticTaskInput): SemanticTask {
  const all = moduleNames(input.map);
  const dirtyModules = [...new Set(input.dirtyPaths.map(moduleOf))].filter((module) => all.includes(module));
  const targets =
    input.existing && dirtyModules.length > 0 && dirtyModules.length * 2 <= all.length
      ? dirtyModules
      : all;
  const slices: string[] = [];
  for (const module of targets) {
    slices.push(renderRepoMap(input.map, { path: module === "." ? undefined : module, maxBytes: 4096 }));
  }
  let mapText = slices.join("\n\n");
  const readme = join(input.root, "README.md");
  if (existsSync(readme)) {
    try { mapText += `\n\nREADME:\n${readFileSync(readme, "utf8").slice(0, 2048)}`; } catch { /* ignore */ }
  }
  const existing = input.existing
    ? JSON.stringify(
        Object.fromEntries(targets.filter((module) => input.existing?.modules[module]).map((module) => [module, input.existing!.modules[module]])),
        null,
        2,
      )
    : "{}";
  const prompt = [
    "Annotate this repository map. Return JSON only, with no prose.",
    "For each module, write a 20-40 word purpose summary, up to 3 key files, and up to 2 edit hints.",
    "Use exact paths and symbol names. Do not speculate. Keep existing annotations unless the module is dirty.",
    `Modules: ${targets.join(", ")}`,
    `Dirty paths: ${input.dirtyPaths.join(", ") || "(none)"}`,
    `Existing annotations: ${existing}`,
    "JSON shape: {\"modules\":{\"<module>\":{\"summary\":\"...\",\"keyFiles\":[\"...\"],\"editHints\":[\"...\"]}}}",
    "Map:",
    truncateToBytes(mapText, SEMANTIC_INPUT_BYTES),
  ].join("\n\n");
  return { prompt, modules: targets };
}

function parseJson(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const body = (fenced?.[1] ?? text).trim();
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(body.slice(start, end + 1));
  } catch {
    return null;
  }
}

function validEntry(value: unknown, map: RepoMap, module: string): SemanticEntry | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.summary !== "string" || !raw.summary.trim()) return null;
  const files = new Set(map.files.filter((file) => moduleOf(file.path) === module).map((file) => file.path));
  const keyFiles = Array.isArray(raw.keyFiles)
    ? raw.keyFiles.filter((item): item is string => typeof item === "string" && files.has(item)).slice(0, 3)
    : [];
  const editHints = Array.isArray(raw.editHints)
    ? raw.editHints.filter((item): item is string => typeof item === "string" && item.trim().length > 0).slice(0, 2)
    : [];
  return {
    summary: clip(raw.summary.trim(), 240),
    ...(keyFiles.length > 0 ? { keyFiles } : {}),
    ...(editHints.length > 0 ? { editHints: editHints.map((hint) => clip(hint, 160)) } : {}),
  };
}

export interface MergeInput {
  root: string;
  map: RepoMap;
  existing: SemanticMap | null;
  modules: readonly string[];
  model: string;
  response: string;
  dirtyPaths: readonly string[];
}

/** Validate, merge, cap, and persist one semantic response. */
export function mergeSemantic(input: MergeInput): SemanticMap | null {
  const parsed = parseJson(input.response) as { modules?: Record<string, unknown> } | null;
  if (!parsed?.modules) return null;
  const modules: Record<string, SemanticEntry> = { ...(input.existing?.modules ?? {}) };
  const allowed = new Set(moduleNames(input.map));
  for (const module of Object.keys(modules)) if (!allowed.has(module)) delete modules[module];
  const acceptedModules = new Set<string>();
  for (const module of input.modules) {
    const entry = validEntry(parsed.modules[module], input.map, module);
    if (entry) {
      modules[module] = entry;
      acceptedModules.add(module);
    }
  }
  if (acceptedModules.size === 0) return null;
  const semantic: SemanticMap = {
    schema: SEMANTIC_SCHEMA,
    baseCommit: input.map.head,
    mapHash: mapHashOf(input.map),
    generatedAt: new Date().toISOString(),
    model: input.model,
    modules,
  };
  // Cap the file. Drop hints, then files, then shorten summaries.
  let text = JSON.stringify(semantic, null, 2);
  if (Buffer.byteLength(text, "utf8") > SEMANTIC_CAP_BYTES) {
    for (const entry of Object.values(semantic.modules)) delete entry.editHints;
    text = JSON.stringify(semantic, null, 2);
  }
  if (Buffer.byteLength(text, "utf8") > SEMANTIC_CAP_BYTES) {
    for (const entry of Object.values(semantic.modules)) delete entry.keyFiles;
    text = JSON.stringify(semantic, null, 2);
  }
  if (Buffer.byteLength(text, "utf8") > SEMANTIC_CAP_BYTES) {
    for (const entry of Object.values(semantic.modules)) entry.summary = clip(entry.summary, 120);
    text = JSON.stringify(semantic, null, 2);
  }
  if (Buffer.byteLength(text, "utf8") > SEMANTIC_CAP_BYTES) return null;
  writeSemantic(input.root, semantic);
  clearSemanticDirty(
    input.root,
    input.dirtyPaths.filter((path) => acceptedModules.has(moduleOf(path))),
  );
  return semantic;
}

export function renderSemanticIndex(semantic: SemanticMap | null, maxBytes = 1024): string {
  if (!semantic) return "";
  const lines = ["<semantic-map>"];
  for (const [module, entry] of Object.entries(semantic.modules).sort(([a], [b]) => a.localeCompare(b))) {
    lines.push(`${module} — ${entry.summary}`);
  }
  lines.push("</semantic-map>");
  const text = lines.join("\n");
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  return `${truncateToBytes(text, Math.max(0, maxBytes - 20))}\n[truncated]`;
}

/** One bounded completion. Caller owns model selection and accounting. */
export async function runSemanticModel(
  models: MutableModels,
  model: ChatModel,
  prompt: string,
  signal?: AbortSignal,
  maxTokens = 2000,
): Promise<SemanticModelResult> {
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener("abort", onAbort, { once: true });
  }
  const timer = setTimeout(() => controller.abort(), 60_000);
  try {
    const source = models.stream(
      model,
      { messages: [{ role: "user", content: prompt }] } as Context,
      {
        maxTokens,
        signal: controller.signal,
        identity: {
          userAgent: { custom: "machine_code/0.0.0" },
          attribution: { name: "machine_code", url: "https://github.com/extropian/machine-code" },
        },
      },
    );
    let text = "";
    for await (const event of source) {
      if (event.type === "text_delta") text += event.delta;
    }
    const result = await source.result();
    return { text, usage: result.usage, stopReason: result.stopReason };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}
