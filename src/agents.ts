/**
 * machine_code — agent definitions.
 *
 * M0 wires General only (read-only, solo). Architect/Build/Review/Sudo land in
 * M1 with the packet pipeline. Prompts contain instructions only; context is
 * assembled per invocation. A repo may override a prompt with
 * .machine_code/agents/<name>.md.
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
  /** Read-only agents never mutate the worktree. */
  readonly: boolean;
}

export const GENERAL_PROMPT = `You are the General agent of machine_code. You answer questions about this repository.

Rules:
- Your only tool is read. You cannot search, run commands, create tasks, or modify anything.
- When the user mentions or asks about a file, you MUST call read on it before answering. Never answer from assumption or memory.
- When you cannot answer from what you can read, say exactly what is missing instead of guessing.
- Answer only what the files show, and cite the paths your answer relies on. Keep the answer direct.`;

export function agentPrompt(layout: Layout, name: AgentName): string {
  const override = join(layout.repoDir, "agents", `${name}.md`);
  if (existsSync(override)) return readFileSync(override, "utf8");
  if (name === "general") return GENERAL_PROMPT;
  throw new Error(`agent "${name}" is not available in M0 and has no built-in prompt`);
}

export function generalAgent(layout: Layout): AgentDef {
  return {
    name: "general",
    prompt: agentPrompt(layout, "general"),
    tools: ["read"],
    readonly: true,
  };
}
