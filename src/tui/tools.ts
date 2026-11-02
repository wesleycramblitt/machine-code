/**
 * New-run Tools subtab: every tool available to the selected agent, plus
 * repository/machine custom tool manifests.
 */
import type { IssueAccess } from "../agents.js";

export interface ToolListItem {
  text: string;
  chars: number;
  exists: boolean;
  key: string;
}

const DESCRIPTIONS: Record<string, string> = {
  read: "read ranges",
  write: "write files",
  edit: "edit files",
  search: "map, outline, search",
  command: "typed commands",
  context: "run memory",
  task: "delegated run",
  ask: "ask the human",
  artifact: "tools and scripts",
  pr: "pull requests",
};

export function toolListItems(
  tools: readonly string[],
  issueAccess: IssueAccess,
  customTools: ReadonlyArray<{ name: string; description?: string }>,
): ToolListItem[] {
  const core = tools.map((tool) => ({
    text: `${tool} · ${tool === "issue" ? `GitHub issues · issues:${issueAccess}` : (DESCRIPTIONS[tool] ?? "tool")}`,
    chars: 0,
    exists: true,
    key: `core-tool:${tool}`,
  }));
  const custom = customTools.map((artifact) => ({
    text: `${artifact.name} · custom tool${artifact.description ? ` · ${artifact.description}` : ""}`,
    chars: 0,
    exists: true,
    key: `custom-tool:${artifact.name}`,
  }));
  return [...core, ...custom];
}
