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
 * - `issue:create` and `issue:plan` come from the role's `issue_access` level;
 *   `issue:write` / `issue:hierarchy:write` remain compatibility aliases for
 *   `issue:plan`.
 * - `issue:close` is separate; per-issue approval policy applies on top
 *   (human approval by default).
 * - Sudo is unrestricted for code and commands, but issue/delegation
 *   capabilities follow its config (they are on for the unrestricted preset).
 */
import { roleCapabilities, roleIssueAccess, type AgentName, type IssueAccess } from "../agents.js";
import type { AgentConfig } from "../agents/config.js";

export type Capability =
  | "code:read"
  | "code:write"
  | "artifact:write"
  | "issue:read"
  | "issue:create"
  | "issue:plan"
  /** @deprecated compatibility alias for issue:plan */
  | "issue:write"
  /** @deprecated compatibility alias for issue:plan */
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
  "issue:create",
  "issue:plan",
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

const ISSUE_ACCESS_CAPS = [
  "issue:read",
  "issue:create",
  "issue:plan",
  "issue:write",
  "issue:hierarchy:write",
] as const;

export function capabilitiesFor(role: AgentName, config: AgentConfig): Capability[] {
  // Static role capabilities are data; the conditionals below depend on the
  // resolved behavior preset (issues/delegation/PR orchestration).
  const caps = new Set<Capability>(roleCapabilities(role) as Capability[]);
  caps.add("code:read");
  caps.add("context:inherit");

  // Issue access is one resolved level. The legacy write capabilities remain
  // aliases for `plan` so older snapshots and custom roles keep working.
  for (const cap of ISSUE_ACCESS_CAPS) caps.delete(cap);
  const access = config.issueAccess ?? roleIssueAccess(role);
  if (access !== "none") caps.add("issue:read");
  if (access === "plan" || access === "create") {
    caps.add("issue:plan");
    caps.add("issue:write");
    caps.add("issue:hierarchy:write");
  }
  if (access === "create") caps.add("issue:create");
  if (access === "none") caps.delete("issue:close");

  if (
    access !== "none" &&
    config.issues !== "disabled" &&
    ((role === "architect" && config.preset === "orchestrate") || role === "sudo")
  ) {
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

/** Inverse of capabilitiesFor for stored run snapshots and UI badges. */
export function issueAccessFromCapabilities(capabilities: readonly string[]): IssueAccess {
  if (capabilities.includes("issue:create")) return "create";
  if (
    capabilities.includes("issue:plan") ||
    capabilities.includes("issue:write") ||
    capabilities.includes("issue:hierarchy:write")
  ) {
    return "plan";
  }
  if (capabilities.includes("issue:read")) return "read";
  return "none";
}
