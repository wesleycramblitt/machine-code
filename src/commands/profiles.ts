/**
 * machine_code — language/feature profile manifests.
 *
 * A profile is a TOML manifest mapping stable command names
 * (`typescript:build`, `typescript:test`, ...) onto the project's own toolchain
 * via an executable + fixed argument vector. Same schema as core commands.
 *
 * Loaded from .machine_code/profiles/*.toml (repo) and ~/.machine_code/profiles/*.toml (machine).
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "smol-toml";
import { CORE_COMMANDS } from "./registry.js";
import type { CommandSpec } from "./registry.js";
import { referenceCommands } from "./reference.js";
import type { Layout } from "../paths.js";

export interface ProfileManifest {
  commands: Map<string, CommandSpec>;
}

export function loadProfileCommands(layout: Layout): Map<string, CommandSpec> {
  const commands = new Map<string, CommandSpec>();
  const dirs = [join(layout.home, "profiles"), join(layout.repoDir, "profiles")];
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    let entries: string[];
    try {
      entries = readdirSync(dir, { withFileTypes: true })
        .filter((e) => e.isFile() && e.name.endsWith(".toml"))
        .map((e) => e.name);
    } catch {
      continue;
    }
    for (const name of entries) {
      const prefix = name.slice(0, -5); // strip .toml
      const raw = readToml(join(dir, name));
      const cmdTable = raw.commands as Record<string, unknown> | undefined;
      if (!cmdTable || typeof cmdTable !== "object") continue;
      for (const [cmdName, spec] of Object.entries(cmdTable)) {
        const s = spec as Record<string, unknown>;
        const binary = typeof s.binary === "string" ? s.binary : "";
        if (!binary) continue;
        const template = Array.isArray(s.args) ? s.args.filter((x): x is string => typeof x === "string") : [];
        commands.set(`${prefix}:${cmdName}`, {
          name: `${prefix}:${cmdName}`,
          description: typeof s.description === "string" ? s.description : `${prefix}:${cmdName}`,
          binary,
          args: (a) =>
            template.map((t) => {
              const m = t.match(/^\{(.+)\}$/);
              if (!m) return t;
              const key = m[1]!;
              const v = a[key];
              if (v === undefined || v === null) throw new Error(`missing required argument "${key}"`);
              return String(v);
            }),
          schema: {},
          readonly: s.readonly === true,
          timeoutMs: typeof s.timeout_ms === "number" ? s.timeout_ms : 60_000,
        });
      }
    }
  }
  return commands;
}

function readToml(file: string): Record<string, unknown> {
  try {
    const parsed = parse(readFileSync(file, "utf8"));
    return typeof parsed === "object" && parsed && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function allCommands(layout: Layout): Map<string, CommandSpec> {
  const out = new Map<string, CommandSpec>(CORE_COMMANDS);
  for (const [k, v] of loadProfileCommands(layout)) out.set(k, v);
  for (const [k, v] of referenceCommands(layout)) out.set(k, v);
  return out;
}
