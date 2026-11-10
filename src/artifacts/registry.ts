/**
 * machine_code — repo/machine artifact registry.
 *
 * Issues point at reusable tools and scripts with a concise `mc:context`
 * reference. This module turns those references into real files and metadata
 * without executing anything. Manifests are intentionally small:
 *
 *   # .machine_code/tools/bench.toml
 *   name = "bench"
 *   description = "Run the fast performance smoke test"
 *   command = "scripts/bench.sh --quick"
 *   tags = ["performance", "test"]
 *
 * Plain executable scripts under `.machine_code/scripts/` are also discovered;
 * a leading `# description` line is used as their summary.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, extname, join, relative, resolve, sep } from "node:path";
import type { Layout } from "../paths.js";
import { readTomlFile } from "../data.js";

export type ArtifactKind = "tool" | "script";

export interface ArtifactDef {
  name: string;
  kind: ArtifactKind;
  description: string;
  /** Repository-relative path for repo artifacts, absolute for machine artifacts. */
  path?: string;
  command?: string;
  args: string[];
  tags: string[];
  readonly: boolean;
  source: string;
  origin: "repo" | "machine";
}

interface ArtifactManifest {
  name?: unknown;
  description?: unknown;
  command?: unknown;
  args?: unknown;
  tags?: unknown;
  readonly?: unknown;
  kind?: unknown;
}

const TOML_EXT = ".toml";

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

function safeList(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => join(dir, entry.name));
  } catch {
    return [];
  }
}

function firstComment(file: string): string {
  try {
    for (const line of readFileSync(file, "utf8").split("\n").slice(0, 8)) {
      const m = line.match(/^\s*#\s*(.+?)\s*$/);
      if (m && !/^!\/usr\/bin|^-\*-/.test(m[1]!)) return m[1]!.slice(0, 160);
    }
  } catch {
    // unreadable — no description
  }
  return "";
}

function fromManifest(file: string, layout: Layout, origin: "repo" | "machine"): ArtifactDef | null {
  let raw: ArtifactManifest;
  try {
    raw = readTomlFile<ArtifactManifest>(file);
  } catch {
    return null;
  }
  const name = typeof raw.name === "string" && raw.name.trim() ? raw.name.trim() : basename(file, TOML_EXT);
  const path = typeof raw.command === "string" ? raw.command.split(/\s+/)[0] : undefined;
  return {
    name,
    kind: raw.kind === "script" ? "script" : "tool",
    description: typeof raw.description === "string" ? raw.description : "",
    path,
    command: typeof raw.command === "string" ? raw.command : undefined,
    args: strings(raw.args),
    tags: strings(raw.tags),
    readonly: raw.readonly !== false,
    source: origin === "repo" ? relative(layout.repoRoot, file) : file,
    origin,
  };
}

function fromScript(file: string, layout: Layout): ArtifactDef {
  const rel = relative(layout.repoRoot, file);
  return {
    name: basename(file, extname(file)),
    kind: "script",
    description: firstComment(file),
    path: rel,
    command: rel,
    args: [],
    tags: ["script"],
    readonly: true,
    source: rel,
    origin: "repo",
  };
}

function discover(dir: string, layout: Layout, origin: "repo" | "machine", kind: ArtifactKind): ArtifactDef[] {
  const out: ArtifactDef[] = [];
  for (const file of safeList(dir)) {
    if (file.endsWith(TOML_EXT)) {
      const def = fromManifest(file, layout, origin);
      if (def) out.push({ ...def, kind });
      continue;
    }
    if (origin === "repo" && kind === "script") {
      try {
        if (!statSync(file).isFile()) continue;
      } catch {
        continue;
      }
      out.push(fromScript(file, layout));
    }
  }
  return out;
}

/** Merge machine and repo artifacts; repo declarations win on name collisions. */
export function listArtifacts(layout: Layout): ArtifactDef[] {
  const byName = new Map<string, ArtifactDef>();
  const machineDirs = [
    join(layout.home, "tools"),
    join(layout.home, "scripts"),
  ];
  for (const dir of machineDirs) {
    for (const def of discover(dir, layout, "machine", dir.endsWith("scripts") ? "script" : "tool")) {
      byName.set(def.name, def);
    }
  }
  const repoDirs = [
    join(layout.repoDir, "tools"),
    join(layout.repoDir, "scripts"),
    join(layout.repoRoot, "scripts"),
  ];
  for (const dir of repoDirs) {
    for (const def of discover(dir, layout, "repo", dir.endsWith("scripts") ? "script" : "tool")) {
      const existing = byName.get(def.name);
      // A manifest names an intentional tool; a same-named loose script should
      // not silently shadow it inside the same origin.
      if (existing && existing.origin === "repo" && existing.kind === "tool" && def.kind === "script") continue;
      byName.set(def.name, def);
    }
  }
  return [...byName.values()].sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name));
}

/** Resolve a reference by artifact name or repo-relative path. */
export function resolveArtifact(layout: Layout, ref: string): ArtifactDef | null {
  const artifacts = listArtifacts(layout);
  const cleaned = ref.replace(/^tool:/, "").replace(/^script:/, "").trim();
  return (
    artifacts.find((a) => a.name === cleaned) ??
    artifacts.find((a) => a.path === cleaned) ??
    artifacts.find((a) => a.source === cleaned) ??
    null
  );
}

export function artifactPath(layout: Layout, artifact: ArtifactDef): string | null {
  if (!artifact.path) return null;
  if (artifact.origin === "machine") return artifact.path;
  const base = resolve(layout.repoRoot);
  const abs = resolve(base, artifact.path);
  if (abs !== base && !abs.startsWith(base + sep)) return null;
  return abs;
}

export function artifactExists(layout: Layout, artifact: ArtifactDef): boolean {
  const path = artifactPath(layout, artifact);
  return Boolean(path && existsSync(path));
}

export function artifactSummary(artifact: ArtifactDef): string {
  const bits = [`${artifact.kind} ${artifact.name}`];
  if (artifact.command) bits.push(`command: ${artifact.command}`);
  else if (artifact.path) bits.push(`path: ${artifact.path}`);
  if (artifact.description) bits.push(artifact.description);
  if (artifact.tags.length) bits.push(`tags: ${artifact.tags.join(", ")}`);
  return bits.join("\n");
}
