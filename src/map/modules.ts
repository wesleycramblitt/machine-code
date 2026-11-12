/**
 * machine_code — module-level utilities over the repo map.
 *
 * Minimal replacement: the query-biased module index was removed (nothing
 * depended on it in the prompt, and the map outline + inspect cover the same
 * ground).  Only the dependency graph renderer remains, using the repo map's
 * import edges directly.
 */
import { isCodeLang, moduleOf, type RepoMap } from "./deterministic.js";
import { truncateToBytes } from "../tools/safety.js";

/**
 * Compact module dependency graph.  Edges are deterministic imports.
 */
export function renderModuleGraph(
  map: RepoMap,
  query = "",
  maxBytes = 6 * 1024,
): string {
  const deps = new Map<string, Set<string>>();
  for (const file of map.files) {
    if (!isCodeLang(file.lang)) continue;
    const module = moduleOf(file.path);
    const targets = deps.get(module) ?? new Set<string>();
    for (const imported of file.imports ?? []) {
      const target = moduleOf(imported);
      if (target !== module) targets.add(target);
    }
    deps.set(module, targets);
  }
  const modules = [...deps.keys()]
    .filter((module) => (deps.get(module)?.size ?? 0) > 0)
    .sort((a, b) => {
      if (a === ".") return -1;
      if (b === ".") return 1;
      return a.localeCompare(b);
    });
  const lines = ["<module-graph>"];
  for (const module of modules) {
    const allTargets = [...(deps.get(module) ?? new Set())].sort();
    if (allTargets.length === 0) continue;
    const targets = allTargets.slice(0, 12);
    const more = allTargets.length > targets.length ? ` +${allTargets.length - targets.length}` : "";
    lines.push(`${module} → ${targets.join(", ")}${more}`);
  }
  lines.push("</module-graph>");
  const text = lines.join("\n");
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  return `${truncateToBytes(text, Math.max(0, maxBytes - 24))}\n[graph truncated]`;
}

/** List unique module names from the map. */
export function moduleNames(map: RepoMap): string[] {
  return [...new Set(map.files.filter((file) => isCodeLang(file.lang)).map((file) => moduleOf(file.path)))].sort((a, b) => {
    if (a === ".") return -1;
    if (b === ".") return 1;
    return a.localeCompare(b);
  });
}