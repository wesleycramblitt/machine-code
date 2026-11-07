/**
 * machine_code — agent definitions loaded from data/agents/*.toml.
 *
 * Each role is one file (role metadata, weights, capabilities, and prompt).
 * Presets live in data/presets.toml. A repo can still override one prompt with
 * .machine_code/agents/<name>.md; a machine can replace one role with
 * ~/.machine_code/data/agents/<name>.toml. Legacy single-table
 * ~/.machine_code/data/agents.toml is still read for compatibility.
 */
import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { CoreToolName } from "./tools/index.js";
import type { Layout } from "./paths.js";
import {
  dataPath,
  listTomlFiles,
  machineDataDir,
  machineDataSubdir,
  packageDataDir,
  readTomlFile,
  shippedDataDir,
} from "./data.js";

export type AgentName = string;

export interface AgentModeConfig {
  verification?: string;
  review?: boolean;
}

export interface AgentDef {
  name: AgentName;
  prompt: string;
  tools: readonly CoreToolName[];
  /** Mutating the worktree. Read-only agents cannot complete mutating tasks. */
  readonly: boolean;
  /** Orchestration modes this role offers. Empty means a single-agent run. */
  modes: readonly string[];
  /** Mode selected when the human does not choose one. */
  defaultMode?: string;
  /** Per-mode coordinator behavior from the role file. */
  modeConfig: Record<string, AgentModeConfig>;
  blurb: string;
  preset: string;
}

interface RoleData {
  name?: unknown;
  order?: unknown;
  prompt?: unknown;
  tools?: unknown;
  readonly?: unknown;
  modes?: unknown;
  default_mode?: unknown;
  mode?: unknown;
  blurb?: unknown;
  preset?: unknown;
  capabilities?: unknown;
  base_prompt?: unknown;
  weights?: Record<string, unknown>;
  /** Per-skill context-mode preset table: `[skills] clean-code = "include"`. */
  skills?: Record<string, unknown>;
}

interface AgentsData {
  roles: Record<string, RoleData>;
  presets: Record<string, Record<string, unknown>>;
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

function roleFile(file: string): [string, RoleData] {
  const role = readTomlFile<RoleData>(file);
  const name = typeof role.name === "string" && role.name ? role.name : basename(file, ".toml");
  return [name, role];
}

function legacyAgents(file: string): AgentsData | null {
  if (!existsSync(file)) return null;
  return readTomlFile<AgentsData>(file);
}

function loadRoles(): Record<string, RoleData> {
  const roles: Record<string, RoleData> = {};
  const shipped = listTomlFiles(shippedDataDir("agents"));
  if (shipped.length > 0) {
    for (const file of shipped) {
      const [name, role] = roleFile(file);
      roles[name] = role;
    }
  } else {
    const legacy = legacyAgents(join(packageDataDir(), "agents.toml"));
    if (legacy) Object.assign(roles, legacy.roles ?? {});
  }

  for (const file of listTomlFiles(machineDataSubdir("agents"))) {
    const [name, role] = roleFile(file);
    roles[name] = role;
  }
  const machineLegacy = legacyAgents(join(machineDataDir(), "agents.toml"));
  if (machineLegacy) Object.assign(roles, machineLegacy.roles ?? {});
  return roles;
}

function loadPresets(): Record<string, Record<string, unknown>> {
  const file = dataPath("presets.toml");
  if (existsSync(file)) return readTomlFile<Record<string, Record<string, unknown>>>(file);
  const machineLegacy = legacyAgents(join(machineDataDir(), "agents.toml"));
  if (machineLegacy?.presets) return machineLegacy.presets;
  return legacyAgents(join(packageDataDir(), "agents.toml"))?.presets ?? {};
}

function agentsData(): AgentsData {
  return { roles: loadRoles(), presets: loadPresets() };
}

function roleData(name: string): RoleData {
  const role = agentsData().roles[name];
  if (!role) throw new Error(`data/agents: unknown role "${name}"`);
  return role;
}

function roleOrder(role: RoleData): number {
  const n = Number(role.order);
  return Number.isFinite(n) ? n : Number.MAX_SAFE_INTEGER;
}

export const AGENT_NAMES: readonly string[] = Object.entries(agentsData().roles)
  .sort(([a, ra], [b, rb]) => roleOrder(ra) - roleOrder(rb) || (a < b ? -1 : 1))
  .map(([name]) => name);

export const AGENT_META: Record<string, { modes: string[]; blurb: string }> = Object.fromEntries(
  AGENT_NAMES.map((name) => {
    const role = roleData(name);
    return [name, { modes: strings(role.modes), blurb: typeof role.blurb === "string" ? role.blurb : "" }];
  }),
);

export function presetData(): Record<string, Record<string, unknown>> {
  return agentsData().presets;
}

export function roleCapabilities(name: AgentName): string[] {
  return strings(roleData(name).capabilities);
}

export function roleWeights(name: AgentName): Partial<Record<"reasoning" | "code" | "agentic" | "general", number>> {
  const raw = roleData(name).weights ?? {};
  const out: Partial<Record<"reasoning" | "code" | "agentic" | "general", number>> = {};
  for (const axis of ["reasoning", "code", "agentic", "general"] as const) {
    const n = typeof raw[axis] === "number" ? raw[axis] : Number(raw[axis]);
    if (Number.isFinite(n) && n >= 0) out[axis] = n;
  }
  return out;
}

export function rolePreset(name: AgentName): string {
  const role = roleData(name);
  return typeof role.preset === "string" ? role.preset : "assistant";
}

/**
 * Per-skill context-mode presets for a role (`[skills]` table). Invalid
 * values are ignored so a typo degrades to the default chain, not a crash.
 * A machine role file replaces the shipped one wholesale (existing pattern).
 */
export function roleSkillPresets(name: AgentName): Record<string, string> {
  const raw = roleData(name).skills ?? {};
  const out: Record<string, string> = {};
  for (const [skill, mode] of Object.entries(raw)) {
    if (typeof mode === "string" && (mode === "include" || mode === "on-demand" || mode === "exclude")) {
      out[skill] = mode;
    }
  }
  return out;
}

function basePrompt(name: AgentName): string {
  const file = dataPath("prompts/base.md");
  if (!existsSync(file)) return "";
  return readFileSync(file, "utf8").replaceAll("<role>", name);
}

function agentPrompt(layout: Layout, name: AgentName): string {
  const role = roleData(name);
  const override = join(layout.repoDir, "agents", `${name}.md`);
  const rolePrompt = existsSync(override)
    ? readFileSync(override, "utf8")
    : typeof role.prompt === "string"
      ? role.prompt
      : "";
  if (role.base_prompt === false) return rolePrompt.trim();
  const base = basePrompt(name).trim();
  return [base, rolePrompt.trim()].filter(Boolean).join("\n\n");
}

function modeConfigs(role: RoleData, modes: readonly string[]): Record<string, AgentModeConfig> {
  const raw = role.mode;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, AgentModeConfig> = {};
  for (const [mode, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!modes.includes(mode) || !value || typeof value !== "object" || Array.isArray(value)) continue;
    const v = value as Record<string, unknown>;
    out[mode] = {
      ...(typeof v.verification === "string" ? { verification: v.verification } : {}),
      ...(typeof v.review === "boolean" ? { review: v.review } : {}),
    };
  }
  return out;
}

export function agentDef(layout: Layout, name: AgentName): AgentDef {
  const role = roleData(name);
  const modes = strings(role.modes);
  const defaultModeRaw = typeof role.default_mode === "string" ? role.default_mode : undefined;
  return {
    name,
    prompt: agentPrompt(layout, name),
    tools: strings(role.tools) as CoreToolName[],
    readonly: role.readonly === true,
    modes,
    defaultMode: defaultModeRaw && modes.includes(defaultModeRaw) ? defaultModeRaw : undefined,
    modeConfig: modeConfigs(role, modes),
    blurb: typeof role.blurb === "string" ? role.blurb : "",
    preset: typeof role.preset === "string" ? role.preset : "assistant",
  };
}


