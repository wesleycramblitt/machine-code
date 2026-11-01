/**
 * machine_code — capability matrix: the enforcement unit.
 *
 * A tool/command/action checks the run's resolved capability set, not just the
 * prompt. Capabilities are derived from (role, agent config) once at run
 * creation and snapshotted into run.json for audit.
 *
 * Notes:
 * - `code:write` and `artifact:write` are separate: artifact writes are
 *   path-scoped to .machine_code/plans/ and .machine_code/tasks/.
 * - `issue:close` is separate from `issue:write`; per-issue approval policy
 *   applies on top (human approval by default).
 * - Sudo is unrestricted for code and commands, but issue/delegation
 *   capabilities follow its config (they are on for the unrestricted preset).
 */
import { roleCapabilities, type AgentName } from "../agents.js";
import type { AgentConfig } from "../agents/config.js";

export type Capability =
  | "code:read"
  | "code:write"
  | "artifact:write"
  | "issue:read"
  | "issue:write"
  | "issue:hierarchy:write"
  | "issue:close"
  | "run:spawn"
  | "run:coordinate"
  | "pr:read"
  | "pr:create"
  | "pr:merge"
  | "review:write"
  | "knowledge:write"
  | "context:inherit";

export const ALL_CAPABILITIES: readonly Capability[] = [
  "code:read",
  "code:write",
  "artifact:write",
  "issue:read",
  "issue:write",
  "issue:hierarchy:write",
  "issue:close",
  "run:spawn",
  "run:coordinate",
  "pr:read",
  "pr:create",
  "pr:merge",
  "review:write",
  "knowledge:write",
  "context:inherit",
];

export function capabilitiesFor(role: AgentName, config: AgentConfig): Capability[] {
  // Static role capabilities are data; the conditionals below depend on the
  // resolved behavior preset (issues/delegation/PR orchestration).
  const caps = new Set<Capability>(roleCapabilities(role) as Capability[]);
  caps.add("code:read");
  caps.add("context:inherit");

  if (config.issues !== "disabled" && (role === "architect" || role === "sudo")) {
    caps.add("issue:write");
    caps.add("issue:hierarchy:write");
  }
  if (config.issues !== "disabled" && ((role === "architect" && config.preset === "orchestrate") || role === "sudo")) {
    caps.add("issue:close");
  }

  if (config.delegate) {
    caps.add("run:spawn");
    caps.add("run:coordinate");
  }

  if ((role === "architect" && config.preset === "orchestrate") || role === "sudo") {
    caps.add("pr:create");
    caps.add("pr:merge");
  }

  return [...caps].sort();
}

export function hasCapability(capabilities: readonly string[], needed: Capability | string): boolean {
  return capabilities.includes(needed);
}
