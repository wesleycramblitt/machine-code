/**
 * machine_code — agent definitions.
 *
 * Five named agents: General (M0), Architect/Build/Review/Sudo (M1). Prompts
 * contain instructions only; context is assembled per invocation. A repo may
 * override a prompt with .machine_code/agents/<name>.md.
 *
 * `policy.toml` sets per-agent requirements: expected_output_tokens, budget,
 * output ceiling, min capability, tool-call flag. Tool/skill allowlists live
 * here (code) and are intersected with policy at run time.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { CoreToolName } from "./tools/index.js";
import type { Layout } from "./paths.js";

export type AgentName = "general" | "architect" | "build" | "review" | "sudo";

export interface AgentDef {
  name: AgentName;
  prompt: string;
  tools: readonly CoreToolName[];
  /** Mutating the worktree. Read-only agents cannot complete mutating tasks. */
  readonly: boolean;
}

export const GENERAL_PROMPT = `You are the General agent of machine_code. You answer questions about this repository.

Rules:
- Your only tool is read. You cannot search, run commands, create tasks, or modify anything.
- When the user mentions or asks about a file, you MUST call read on it before answering. Never answer from assumption or memory.
- When you cannot answer from what you can read, say exactly what is missing instead of guessing.
- Answer only what the files show, and cite the paths your answer relies on. Keep the answer direct.`;

export const ARCHITECT_PROMPT = `You are the Architect agent of machine_code. Your whole job is planning: explore the repository and compile ONE structured, immutable task packet for the Build agent.

Rules:
- Do not write code. Do not run mutating commands (write/edit/move/copy/delete/replace/rewrite/rename). Your commands are read-only: status, diff, history, show, check.
- Output exactly one packet: goal, context paths, constraints, and named acceptance commands that resolve to allowlisted profile/repo commands (never shell strings).
- The packet must be specific and self-contained: another agent must be able to implement it without asking you questions. Name the exact files to touch and the exact acceptance commands (e.g. typescript:test with filter=parser).
- Explore with read/search as needed, then stop. A wrong packet comes back as blocked with evidence; do not improvise a rewrite.
- When asked to gather or index sources, load the reference skill (read .machine_code/skills/reference/SKILL.md) for the procedure and the reference:* commands (search, browser, pdf-extract, index). Those commands are task-scoped to reference work; never write bundles into project code paths.`;

export const BUILD_PROMPT = `You are the Build agent of machine_code. Your whole job is implementing ONE compiled packet — code-specific, nothing else.

Rules:
- Implement exactly the packet: its goal, its context paths, its constraints. Do not re-plan, do not change acceptance commands, do not add scope.
- You have all six tools and the packet's allowlisted mutating/profile commands. Prefer the edit precision ladder: core:rename (symbols) > core:rewrite (ast-grep shapes) > core:replace (sd literal/regex) > write.
- Modes: verified/redundant — author focused tests for each code-level acceptance criterion. direct — add no new tests; rely on existing coverage.
- Stop when every acceptance command in the packet can pass. Report blocked with evidence if the packet is wrong or a gate cannot run.`;

export const REVIEW_PROMPT = `You are the Review agent of machine_code. Your whole job is an independent, read-only assessment of Build's work.

Rules:
- You cannot write, edit, or run project commands. read/search/read-only commands only.
- Judge the built work against the compiled packet: spec conformance (what was built vs. what was compiled), test coverage of each acceptance criterion, and the definition of done.
- Compare against the packet, not against the gates alone. Approve or reject with concrete evidence citing paths. You never edit the worktree.`;

export const SUDO_PROMPT = `You are the Sudo agent of machine_code. Rare, explicit, fully enabled. solo mode only.

Rules:
- You have all six tools and all configured repo/global/profile/MCP commands. You bypass Architect, Build, and Review.
- "All permissions" does NOT mean arbitrary shell or host-root access: every command is a typed manifest run through execFile in a bounded worktree.
- You still use runner-owned acceptance gates for mutations; no task self-certifies. Treat the user's request as your packet.`;

function agentPrompt(layout: Layout, name: AgentName): string {
  const override = join(layout.repoDir, "agents", `${name}.md`);
  if (existsSync(override)) return readFileSync(override, "utf8");
  const builtins: Record<AgentName, string> = {
    general: GENERAL_PROMPT,
    architect: ARCHITECT_PROMPT,
    build: BUILD_PROMPT,
    review: REVIEW_PROMPT,
    sudo: SUDO_PROMPT,
  };
  return builtins[name];
}

export function generalAgent(layout: Layout): AgentDef {
  return {
    name: "general",
    prompt: agentPrompt(layout, "general"),
    tools: ["read"],
    readonly: true,
  };
}

export function architectAgent(layout: Layout): AgentDef {
  return {
    name: "architect",
    prompt: agentPrompt(layout, "architect"),
    tools: ["read", "search", "task", "command"],
    readonly: true,
  };
}

export function buildAgent(layout: Layout): AgentDef {
  return {
    name: "build",
    prompt: agentPrompt(layout, "build"),
    tools: ["read", "write", "edit", "search", "command", "task"],
    readonly: false,
  };
}

export function reviewAgent(layout: Layout): AgentDef {
  return {
    name: "review",
    prompt: agentPrompt(layout, "review"),
    tools: ["read", "search", "command"],
    readonly: true,
  };
}

export function sudoAgent(layout: Layout): AgentDef {
  return {
    name: "sudo",
    prompt: agentPrompt(layout, "sudo"),
    tools: ["read", "write", "edit", "search", "command", "task"],
    readonly: false,
  };
}

export function agentDef(layout: Layout, name: AgentName): AgentDef {
  switch (name) {
    case "general": return generalAgent(layout);
    case "architect": return architectAgent(layout);
    case "build": return buildAgent(layout);
    case "review": return reviewAgent(layout);
    case "sudo": return sudoAgent(layout);
  }
}

/** Tools an agent may actually hold: builtin allowlist intersect policy. */
export function allowedTools(def: AgentDef, toolCall: boolean): readonly CoreToolName[] {
  if (!toolCall) return ["read"];
  return def.readonly ? def.tools.filter((t) => t !== "write" && t !== "edit") : def.tools;
}
