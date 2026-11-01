/**
 * machine_code — agent definitions loaded from data/agents.toml.
 *
 * Roles, tools, read-only flags, TUI modes, blurbs, prompt files, and role
 * presets are data. A repo can still override one prompt with
 * .machine_code/agents/<name>.md; a machine can override the whole table with
 * ~/.machine_code/data/agents.toml.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { CoreToolName } from "./tools/index.js";
import type { Layout } from "./paths.js";
import { dataPath, loadTomlData } from "./data.js";

export type AgentName = string;

export interface AgentDef {
  name: AgentName;
  prompt: string;
  tools: readonly CoreToolName[];
  /** Mutating the worktree. Read-only agents cannot complete mutating tasks. */
  readonly: boolean;
  /** Run modes the TUI offers for this role. */
  modes: readonly string[];
  blurb: string;
  preset: string;
}

interface RoleData {
  prompt?: unknown;
  tools?: unknown;
  readonly?: unknown;
  modes?: unknown;
  blurb?: unknown;
  preset?: unknown;
  capabilities?: unknown;
  weights?: Record<string, unknown>;
}

interface AgentsData {
  roles?: Record<string, RoleData>;
  presets?: Record<string, Record<string, unknown>>;
}

function agentsData(): AgentsData {
  return loadTomlData<AgentsData>("agents.toml");
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

function roleData(name: string): RoleData {
  const role = agentsData().roles?.[name];
  if (!role) throw new Error(`agents.toml: unknown role "${name}"`);
  return role;
}

export const AGENT_NAMES: readonly string[] = Object.keys(agentsData().roles ?? {});

export const AGENT_META: Record<string, { modes: string[]; blurb: string }> = Object.fromEntries(
  AGENT_NAMES.map((name) => {
    const role = roleData(name);
    return [name, { modes: strings(role.modes), blurb: typeof role.blurb === "string" ? role.blurb : "" }];
  }),
);

export function presetData(): Record<string, Record<string, unknown>> {
  return agentsData().presets ?? {};
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

function promptFromData(ref: string): string {
  const file = join(dirname(dataPath("agents.toml")), ref);
  return existsSync(file) ? readFileSync(file, "utf8") : "";
}

function agentPrompt(layout: Layout, name: AgentName): string {
  const override = join(layout.repoDir, "agents", `${name}.md`);
  if (existsSync(override)) return readFileSync(override, "utf8");
  const role = roleData(name);
  const ref = typeof role.prompt === "string" ? role.prompt : `prompts/${name}.md`;
  return promptFromData(ref);
}

export function agentDef(layout: Layout, name: AgentName): AgentDef {
  const role = roleData(name);
  return {
    name,
    prompt: agentPrompt(layout, name),
    tools: strings(role.tools) as CoreToolName[],
    readonly: role.readonly === true,
    modes: strings(role.modes),
    blurb: typeof role.blurb === "string" ? role.blurb : "",
    preset: typeof role.preset === "string" ? role.preset : "assistant",
  };
}

/* Compatibility helpers for the built-in roles. */
export function generalAgent(layout: Layout): AgentDef {
  return agentDef(layout, "general");
}
export function architectAgent(layout: Layout): AgentDef {
  return agentDef(layout, "architect");
}
export function buildAgent(layout: Layout): AgentDef {
  return agentDef(layout, "build");
}
export function reviewAgent(layout: Layout): AgentDef {
  return agentDef(layout, "review");
}
export function sudoAgent(layout: Layout): AgentDef {
  return agentDef(layout, "sudo");
}
