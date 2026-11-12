/**
 * machine_code — agent definitions loaded from data/agents/*.toml.
 *
 * Each role is one file (role metadata, weights, capabilities, and prompt).
 * Presets live in data/presets.toml. Core settings ship with machine code
 * and are not overridable. Custom agents can be added as new roles.
 */
import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { CoreToolName } from "./tools/index.js";
import type { Layout } from "./paths.js";
import {
  listTomlFiles,
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
  /** Paths the agent is allowed to write/edit (relative to worktree root).
   *  Empty or undefined means all paths are allowed. */
  allowedPaths?: readonly string[];
  /** Skills the agent requires at minimum "on-demand" mode (cannot be excluded). */
  requiredSkills: readonly string[];
  /* ---- model selection thresholds ---- */
  /** Role-weighted capability floor (0-10); the primary per-role quality gate. */
  minFit: number;
  /** Hard per-axis floors (0-10); omitted axes have no floor. */
  minAxes?: Partial<Record<import("./config.js").CapabilityAxis, number>>;
  /** Minimum context window in tokens; models below this are rejected. */
  minContext: number;
  /** Fixed per-agent output estimate used by the selector. */
  expectedOutputTokens: number;
  /** Per-agent output-token ceiling override. */
  maxOutputTokens?: number;
  /** Total token budget for one run. */
  budgetTokens?: number;
  /** Hard cap on assistant turns for one run. */
  maxTurns?: number;
  /** Neutral composite capability floor (0-10); broad safety only. */
  minCapability: number;
  /** Whether the agent calls tools (drives the tool-support hard filter). */
  toolCall: boolean;
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
  approval?: unknown;
  ambiguity?: unknown;
  capabilities?: unknown;
  base_prompt?: unknown;
  allowed_paths?: unknown;
  required_skills?: unknown;
  selection?: unknown;  /* TOML table: min_fit, axes, etc. */
  weights?: Record<string, unknown>;
  /** Per-skill context-mode preset table: `[skills] clean-code = "include"`. */
  skills?: Record<string, unknown>;
}


function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

function roleFile(file: string): [string, RoleData] {
  const role = readTomlFile<RoleData>(file);
  const name = typeof role.name === "string" && role.name ? role.name : basename(file, ".toml");
  return [name, role];
}

function loadRoles(): Record<string, RoleData> {
  const roles: Record<string, RoleData> = {};
  for (const file of listTomlFiles(shippedDataDir("agents"))) {
    const [name, role] = roleFile(file);
    roles[name] = role;
  }
  return roles;
}
function loadPresets(): Record<string, Record<string, unknown>> {
  const file = join(packageDataDir(), "presets.toml");
  if (existsSync(file)) return readTomlFile<Record<string, Record<string, unknown>>>(file);
  return {};
}
function agentsData(): { roles: Record<string, RoleData>; presets: Record<string, Record<string, unknown>> } {
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

function asNum(obj: unknown, key: string): number | undefined {
  if (!obj || typeof obj !== "object") return undefined;
  const v = (obj as Record<string, unknown>)[key];
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function asAxisMap(obj: unknown, key: string): Record<string, number> | undefined {
  if (!obj || typeof obj !== "object") return undefined;
  const v = (obj as Record<string, unknown>)[key];
  if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
  const out: Record<string, number> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    const n = typeof val === "number" ? val : Number(val);
    if (Number.isFinite(n) && n >= 0) out[k] = n;
  }
  return Object.keys(out).length > 0 ? out : undefined;
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

/** Read raw role data for config defaults (approval, ambiguity). */
export function roleDefaults(name: AgentName): { approval: string; ambiguity: string } {
  const role = roleData(name);
  return {
    approval: role.approval === "agent" ? "agent" : "human",
    ambiguity: typeof role.ambiguity === "string" ? role.ambiguity : "precise",
  };
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
  const file = join(packageDataDir(), "prompts/base.md");
  if (!existsSync(file)) return "";
  return readFileSync(file, "utf8").replaceAll("<role>", name);
}
function agentPrompt(layout: Layout, name: AgentName): string {
  const role = roleData(name);
  const override = join(packageDataDir(), "agents", `${name}.md`);
  const rolePrompt = existsSync(override)
    ? readFileSync(override, "utf8")
    : typeof role.prompt === "string"
      ? role.prompt
      : "";
  if (role.base_prompt === false) return rolePrompt.trim();
  const base = basePrompt(name).trim();
  const roleText = rolePrompt.trim();
  if (!base) return roleText;
  if (!roleText) return base;
  return [base, roleText].filter(Boolean).join("\n\n");
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

/** Map removed roles onto their current equivalents (legacy run records). */
export function normalizeAgentName(name: string): AgentName {
  if (name === "build") return "engineer";
  if (name === "planner") return "research";
  return name;
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
    allowedPaths: strings(role.allowed_paths),
    requiredSkills: strings(role.required_skills),
    /* ---- model selection (from role TOML [selection], with defaults) ---- */
    minFit: asNum(role.selection, "min_fit") ?? 6.0,
    minAxes: asAxisMap(role.selection, "axes"),
    minContext: asNum(role.selection, "min_context") ?? 32000,
    expectedOutputTokens: asNum(role.selection, "expected_output_tokens") ?? 2000,
    maxOutputTokens: asNum(role.selection, "max_output_tokens"),
    budgetTokens: asNum(role.selection, "budget_tokens"),
    maxTurns: asNum(role.selection, "max_turns"),
    minCapability: asNum(role.selection, "min_capability") ?? 0,
    toolCall: (() => {
      const sel = role.selection as Record<string, unknown> | undefined;
      return typeof sel?.tool_call === "boolean" ? sel.tool_call : true;
    })(),
  };
}


