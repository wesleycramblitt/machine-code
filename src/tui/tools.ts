/**
 * New-run Tools subtab: every tool available to the selected agent, plus
 * repository/machine custom tool manifests.
 */
import type { IssueAccess } from "../agents.js";
import type { CoreToolName } from "../tools/index.js";
import { toolSchemaCharsByName } from "../tools/schema.js";

export interface ToolListItem {
  text: string;
  chars: number;
  exists: boolean;
  key: string;
  /** Tool definitions are always sent; they cannot be excluded as context. */
  fixed?: boolean;
  /** Listed for discovery but not part of the assembled context. */
  available?: boolean;
  /** False when `chars` describes the file, not assembled context. */
  counted?: boolean;
}

const DESCRIPTIONS: Record<string, string> = {
  read: "read ranges",
  write: "write files",
  edit: "edit files",
  search: "map, outline, search",
  command: "typed commands",
  context: "run memory",
  ask: "ask the human",
  issue_graph: "create issue graph",
  artifact: "tools and scripts",
  skill: "skill bodies on demand",
  pr: "pull requests",
};

export function toolListItems(
  tools: readonly string[],
  issueAccess: IssueAccess,
  customTools: ReadonlyArray<{ name: string; description?: string }>,
  customChars?: ReadonlyMap<string, number>,
): ToolListItem[] {
  const names = tools as readonly CoreToolName[];
  const schemaChars = toolSchemaCharsByName(names);
  const core = tools.map((tool) => ({
    text: `${tool} · ${
      tool === "issue"
        ? `GitHub issues · issues:${issueAccess}`
        : tool === "issue_graph"
          ? `GitHub issue graphs · issues:${issueAccess}`
          : (DESCRIPTIONS[tool] ?? "tool")
    }`,
    chars: schemaChars.get(tool) ?? 0,
    exists: true,
    key: `core-tool:${tool}`,
    fixed: true,
  }));
  const custom = customTools.map((artifact) => {
    const referenced = customChars?.has(artifact.name) === true;
    return {
      text: `${artifact.name} · custom tool${artifact.description ? ` · ${artifact.description}` : ""}${referenced ? "" : " · available"}`,
      chars: customChars?.get(artifact.name) ?? 0,
      exists: true,
      key: `tool:${artifact.name}`,
      available: !referenced,
      counted: referenced,
    };
  });
  return [...core, ...custom];
}

/** Split the always-visible skill-description block into one row per skill. */
export function skillListItems(
  skills: ReadonlyArray<{ name: string; description: string }>,
  totalChars: number,
): ToolListItem[] {
  if (skills.length === 0) return [];
  const lines = skills.map((skill) => `- ${skill.name}: ${skill.description}`);
  const lineChars = lines.reduce((sum, line) => sum + line.length, 0) || 1;
  let allocated = 0;
  return skills.map((skill, index) => {
    const remaining = Math.max(0, totalChars - allocated);
    const chars =
      index === skills.length - 1
        ? remaining
        : Math.min(remaining, Math.round((totalChars * lines[index]!.length) / lineChars));
    allocated += chars;
    return {
      text: `${skill.name} · ${skill.description}`,
      chars,
      exists: true,
      key: `skill:${skill.name}`,
    };
  });
}

/** Conservative token estimate used by the context panel. */
export function tokensForChars(chars: number): number {
  return Math.ceil(Math.max(0, chars) / 4);
}
