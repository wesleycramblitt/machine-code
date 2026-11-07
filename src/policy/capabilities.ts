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
 */
import { roleCapabilities, type AgentName } from "../agents.js";
import type { AgentConfig } from "../agents/config.js";

export type Capability =
  | "code:read"
  | "code:write"
  | "artifact:write"
  | "artifact:provision"
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
  "artifact:provision",
  "pr:read",
  "pr:create",
  "pr:merge",
  "review:write",
  "knowledge:write",
  "context:inherit",
];

export function capabilitiesFor(role: AgentName, config: AgentConfig): Capability[] {
  // Static role capabilities are data; the conditionals below depend on the
  // resolved behavior preset.
  const caps = new Set<Capability>(roleCapabilities(role) as Capability[]);
  caps.add("code:read");
  caps.add("context:inherit");

  return [...caps].sort();
}

export function hasCapability(capabilities: readonly string[], needed: Capability | string): boolean {
  return capabilities.includes(needed);
}
