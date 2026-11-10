/**
 * machine_code — project scripts as runner-owned commands.
 *
 * `scripts/` is the command surface. A top-level script named `build.sh`
 * becomes `script:build`; `test.sh` becomes `script:test`; any custom name is
 * `script:<name>`. There is no project TOML and no manifest: the executable
 * file is the configuration. The first comment line is the description.
 *
 * These commands are not handed to the model unless a caller explicitly adds
 * them to a command map. Gates and the composer use them; the agent uses the
 * typed core tools.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, extname, join, relative } from "node:path";
import type { CommandSpec } from "./registry.js";

const SCRIPT_EXTENSIONS = new Set([
  ".sh", ".bash", ".zsh", ".fish",
  ".py", ".js", ".mjs", ".cjs", ".ts",
  ".rb", ".php", ".pl", ".lua", ".r",
]);

const SCRIPT_TIMEOUT_MS = 120_000;

interface Candidate {
  abs: string;
  rel: string;
  name: string;
  description: string;
  executable: boolean;
  ext: string;
}

function firstComment(abs: string): string {
  try {
    for (const line of readFileSync(abs, "utf8").split("\n").slice(0, 8)) {
      const match = /^\s*#\s*(.+?)\s*$/.exec(line);
      if (match && !/^!\/usr\/bin|^-\*-/.test(match[1]!)) return match[1]!.slice(0, 160);
    }
  } catch {
    // unreadable — no description
  }
  return "";
}

function discoverDir(root: string, dir: string): Candidate[] {
  const absDir = join(root, dir);
  if (!existsSync(absDir)) return [];
  let names: string[];
  try {
    names = readdirSync(absDir, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
  const out: Candidate[] = [];
  for (const name of names) {
    const abs = join(absDir, name);
    const ext = extname(name).toLowerCase();
    let executable = false;
    let size = 0;
    try {
      const stat = statSync(abs);
      executable = (stat.mode & 0o111) !== 0;
      size = stat.size;
    } catch {
      continue;
    }
    if (size === 0) continue;
    if (!executable && !SCRIPT_EXTENSIONS.has(ext)) continue;
    const command = basename(name, extname(name));
    if (!/^[a-z0-9][a-z0-9._-]*$/i.test(command)) continue;
    out.push({
      abs,
      rel: relative(root, abs).split("\\").join("/"),
      name: command,
      description: firstComment(abs) || `${command} script`,
      executable,
      ext,
    });
  }
  return out;
}

function invocation(candidate: Candidate): { binary: string; argv: string[] } {
  if (candidate.executable) return { binary: candidate.rel, argv: [] };
  if (candidate.ext === ".sh" || candidate.ext === ".bash" || candidate.ext === ".zsh") {
    return { binary: "bash", argv: [candidate.rel] };
  }
  if (candidate.ext === ".fish") return { binary: "fish", argv: [candidate.rel] };
  if (candidate.ext === ".py") return { binary: "python3", argv: [candidate.rel] };
  if (candidate.ext === ".js" || candidate.ext === ".mjs" || candidate.ext === ".cjs") {
    return { binary: "node", argv: [candidate.rel] };
  }
  if (candidate.ext === ".rb") return { binary: "ruby", argv: [candidate.rel] };
  if (candidate.ext === ".php") return { binary: "php", argv: [candidate.rel] };
  if (candidate.ext === ".pl") return { binary: "perl", argv: [candidate.rel] };
  if (candidate.ext === ".lua") return { binary: "lua", argv: [candidate.rel] };
  if (candidate.ext === ".r") return { binary: "Rscript", argv: [candidate.rel] };
  return { binary: candidate.rel, argv: [] };
}

function spec(candidate: Candidate): CommandSpec {
  const { binary, argv } = invocation(candidate);
  return {
    name: `script:${candidate.name}`,
    description: candidate.description,
    binary,
    args: () => argv,
    schema: {},
    readonly: false,
    timeoutMs: SCRIPT_TIMEOUT_MS,
  };
}

function ambiguousSpec(name: string, candidates: Candidate[]): CommandSpec {
  const paths = candidates.map((candidate) => candidate.rel).join(", ");
  return {
    name: `script:${name}`,
    description: `ambiguous ${name} script`,
    binary: "true",
    args: () => [],
    schema: {},
    readonly: false,
    timeoutMs: SCRIPT_TIMEOUT_MS,
    handler: async () => ({
      text: `ambiguous script:${name}: ${paths}. Keep one executable per command name.`,
      isError: true,
    }),
  };
}

/** Discover repo-root scripts first, then legacy `.machine_code/scripts`. */
export function scriptCommands(root: string): Map<string, CommandSpec> {
  const byName = new Map<string, Candidate[]>();
  const add = (candidate: Candidate): void => {
    const list = byName.get(candidate.name) ?? [];
    list.push(candidate);
    byName.set(candidate.name, list);
  };
  for (const candidate of discoverDir(root, "scripts")) add(candidate);
  for (const candidate of discoverDir(root, join(".machine_code", "scripts"))) {
    // Repo-root scripts win; the legacy tree fills only missing names.
    if (!byName.has(candidate.name)) add(candidate);
  }
  const out = new Map<string, CommandSpec>();
  for (const [name, candidates] of [...byName.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    if (candidates.length === 1) out.set(`script:${name}`, spec(candidates[0]!));
    else out.set(`script:${name}`, ambiguousSpec(name, candidates));
  }
  return out;
}
