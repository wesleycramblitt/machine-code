/**
 * machine_code — the `ask` tool: request user input mid-run.
 *
 * The seventh core tool. Suspending is a harness-owned state transition, not
 * model output: the tool records a `question` event, flips the run to
 * `awaiting_input`, checkpoints the transcript, and waits on the run's inbox
 * for an answer. `machine_code respond` (or the TUI) appends it; the tool
 * returns the answer as its result in the SAME run.
 *
 * A pending question survives process death: the suspension checkpoint plus
 * the inbox answer let a resumed run reconstruct the exact tool result.
 */
import { Type, type Static } from "typebox";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { waitForAnswer } from "../state/question.js";
import type { RunRecorder } from "../state/runs.js";

export interface AskContext {
  runDir: string;
  recorder: RunRecorder;
  /** Called before waiting so the pending ask is durably checkpointed. */
  suspend?: () => void;
}

const AskParams = Type.Object({
  question: Type.String({ description: "The clarification needed from the user." }),
  options: Type.Optional(
    Type.Array(Type.String(), { description: "Optional answer choices when the question is a selection." }),
  ),
  why: Type.Optional(Type.String({ description: "Why this ambiguity blocks progress." })),
});

function ok(text: string): AgentToolResult<undefined> {
  return { content: [{ type: "text", text }], details: undefined };
}

function fail(text: string): AgentToolResult<undefined> {
  return { content: [{ type: "text", text }], details: undefined, isError: true };
}

export function askTool(ctx: AskContext): AgentTool<typeof AskParams> {
  return {
    name: "ask",
    label: "ask",
    description:
      "Ask the user a clarifying question and WAIT for their answer. " +
      "Use when unresolved ambiguity materially affects the work. " +
      "The run enters awaiting_input until the user responds; do not use this for questions you can resolve yourself.",
    parameters: AskParams,
    async execute(_toolCallId, params: Static<typeof AskParams>, signal) {
      const questionId = crypto.randomUUID();
      ctx.recorder.setStatus("awaiting_input", "ask");
      ctx.recorder.event("question", {
        questionId,
        text: params.question,
        ...(params.options ? { options: params.options } : {}),
        ...(params.why ? { why: params.why } : {}),
      });
      try {
        ctx.suspend?.();
        const answer = await waitForAnswer(ctx.runDir, questionId, signal);
        ctx.recorder.event("answer", { questionId, text: answer.text, source: answer.source });
        ctx.recorder.setStatus("running", "answer_received");
        return ok(answer.text);
      } catch (error) {
        return fail(`awaiting input ended: ${(error as Error).message}`);
      }
    },
  };
}
