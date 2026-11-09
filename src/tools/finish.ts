/**
 * machine_code — the `finish` tool.
 *
 * A tool-shaped terminal action. Text-only "Outcome:" lines are unreliable
 * with reasoning/tool models: they can spend a whole run thinking and calling
 * tools without ever emitting text. `finish` lets the model end the run on the
 * same channel it uses for every other action.
 */
import { Type, type Static } from "typebox";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";

export type FinishOutcome = "completed" | "blocked" | "failed";

export interface FinishRequest {
  outcome: FinishOutcome;
  summary: string;
}

export interface FinishContext {
  onFinish: (result: FinishRequest) => void;
}

export const FinishParams = Type.Object({
  outcome: Type.Union(
    [Type.Literal("completed"), Type.Literal("blocked"), Type.Literal("failed")],
    { description: "completed: the issue is done; blocked/failed: why it could not be finished." },
  ),
  summary: Type.String({
    description: "One or two sentences: what changed, or why the run stopped.",
  }),
});

function ok(text: string): AgentToolResult<undefined> {
  return { content: [{ type: "text", text }], details: undefined };
}

export function finishTool(ctx: FinishContext): AgentTool<typeof FinishParams> {
  return {
    name: "finish",
    label: "finish",
    description:
      "End the run. Call this when the issue is complete, blocked, or failed. " +
      "Do not keep calling tools after finish. The summary is what the runner records.",
    parameters: FinishParams,
    async execute(_toolCallId, params: Static<typeof FinishParams>) {
      ctx.onFinish({ outcome: params.outcome, summary: params.summary.trim() });
      return ok(`run finished: ${params.outcome} — ${params.summary.trim()}`);
    },
  };
}
