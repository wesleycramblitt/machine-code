/**
 * machine_code — the `todo` tool.
 *
 * The checklist lives in the issue file, not in run-local state. A fork or a
 * new run on the same branch opens the issue and sees exactly what remains.
 * Single-writer rule: the write goes to the run's worktree when it has one
 * (the merge carries it to the main checkout); only runs directly on the
 * checkout write main. Writing the same file to main mid-run and to the
 * branch at finish guarantees a merge conflict with ourselves.
 */
import { existsSync } from "node:fs";
import { Type, type Static } from "typebox";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { resolveWithin } from "./safety.js";
import { renderIssueTodo, updateIssueTodo, type TodoItem } from "../plan/issues.js";

export interface TodoContext {
  /** Main checkout root: the durable issue tree (fallback when no worktree). */
  repoRoot: string;
  /** Worktree root: issue writes go here when the run has one. */
  toolRoot?: string;
  /** Repo-relative issue file attached to this run. */
  issuePath?: string;
}

export const TodoParams = Type.Object({
  items: Type.Array(
    Type.Object({
      text: Type.String({ description: "One concrete step." }),
      done: Type.Optional(
        Type.Boolean({ description: "True only when the step's result is present. Default false." }),
      ),
    }),
    { description: "The full checklist, in order. Replace the whole list each call." },
  ),
});

function ok(text: string): AgentToolResult<undefined> {
  return { content: [{ type: "text", text }], details: undefined };
}

function fail(text: string): AgentToolResult<undefined> {
  return { content: [{ type: "text", text }], details: undefined, isError: true };
}

export function todoTool(ctx: TodoContext): AgentTool<typeof TodoParams> {
  return {
    name: "todo",
    label: "todo",
    description:
      "Read or replace the issue's `## Todo` checklist. Keep 2-4 concrete steps; mark an item done only when its result exists. " +
      "The checklist lives in the issue file, so the next run or fork can pick up where this one stopped.",
    parameters: TodoParams,
    async execute(_toolCallId, params: Static<typeof TodoParams>) {
      if (!ctx.issuePath) {
        return fail("no issue file is attached to this run; use context note for a bare run");
      }
      const items: TodoItem[] = params.items
        .filter((item) => item.text.trim().length > 0)
        .map((item) => ({ text: item.text.trim(), done: item.done === true }));
      if (items.length === 0) return fail("todo needs at least one item");
      try {
        const root = ctx.toolRoot ?? ctx.repoRoot;
        const abs = resolveWithin(root, ctx.issuePath);
        if (!existsSync(abs)) return fail(`issue not found: ${ctx.issuePath}`);
        updateIssueTodo(abs, items);
      } catch (error) {
        return fail(`todo write failed: ${(error as Error).message}`);
      }
      return ok(`${renderIssueTodo(items)}\n\nSaved to ${ctx.issuePath}.`);
    },
  };
}
