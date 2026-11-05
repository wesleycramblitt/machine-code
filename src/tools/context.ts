/**
 * machine_code — the `context` tool: explicit control of run state.
 *
 * The runner ingests tool results automatically. This tool lets the model
 * record a decision, set the next action, keep a working set, recall exact
 * bytes from an artifact, or inspect its own state.
 */
import { Type, type Static } from "typebox";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { READ_CAP_BYTES, capText } from "./safety.js";
import type { ToolContext } from "./index.js";

function ok(text: string): AgentToolResult<undefined> {
  return { content: [{ type: "text", text }], details: undefined };
}

function fail(text: string): AgentToolResult<undefined> {
  return { content: [{ type: "text", text }], details: undefined, isError: true };
}

const CONTEXT_ACTIONS = new Set(["note", "focus", "recall", "forget", "state"]);
const CONTEXT_KINDS = new Set(["finding", "decision", "open", "next"]);

const ContextParams = Type.Object({
  action: Type.String({
    enum: ["note", "focus", "recall", "forget", "state"],
    description: "Memory operation: note | focus | recall | forget | state.",
  }),
  kind: Type.Optional(
    Type.String({
      enum: ["finding", "decision", "open", "next"],
      description: "Note kind: finding | decision | open | next (default finding).",
    }),
  ),
  text: Type.Optional(Type.String({ description: "Note text (one short sentence)." })),
  refs: Type.Optional(
    Type.Array(Type.String(), { description: "References: path, path:line, or path:start-end." }),
  ),
  id: Type.Optional(Type.String({ description: "Artifact id for recall, or fact/question id for forget." })),
});

export function contextTool(ctx: ToolContext): AgentTool<typeof ContextParams> {
  return {
    name: "context",
    label: "context",
    description:
      "Control run state. note needs text (kind: finding|decision|open|next). focus needs refs. " +
      "recall needs id. forget needs id or text. state takes no fields. " +
      "Example: {\"action\":\"note\",\"kind\":\"next\",\"text\":\"Edit src/tui.ts to ...\"}.",
    parameters: ContextParams,
    async execute(_id, params: Static<typeof ContextParams>) {
      const memory = ctx.state;
      if (!memory) return fail("run state is not available in this run");
      if (!CONTEXT_ACTIONS.has(params.action)) {
        return fail(`unknown context action "${params.action}". Use one of: ${[...CONTEXT_ACTIONS].join(", ")}.`);
      }
      if (params.kind != null && !CONTEXT_KINDS.has(params.kind)) {
        return fail(`unknown note kind "${params.kind}". Use one of: ${[...CONTEXT_KINDS].join(", ")}.`);
      }
      try {
        switch (params.action) {
          case "note": {
            if (!params.text || params.text.trim().length === 0) return fail("note requires text");
            const kind = (params.kind ?? "finding") as "finding" | "decision" | "open" | "next";
            memory.note(kind, params.text, params.refs ?? []);
            return ok(`noted ${kind}`);
          }
          case "focus": {
            if (!params.refs || params.refs.length === 0) return fail("focus requires refs");
            memory.focus(params.refs);
            return ok(`focused ${params.refs.length} ref(s)`);
          }
          case "recall": {
            if (!params.id) return fail("recall requires id");
            const text = memory.getArtifact(params.id);
            if (text === null) return fail(`no artifact ${params.id}`);
            const capped = capText(text, READ_CAP_BYTES);
            return ok(`[artifact ${params.id}]\n${capped.text}`);
          }
          case "forget": {
            let id = params.id;
            if (!id && params.text) {
              const needle = params.text.trim();
              const state = memory.getState();
              id = state.facts.find((fact) => fact.status === "active" && fact.text.includes(needle))?.id;
              id ??= state.open.find((question) => question.status === "open" && question.text.includes(needle))?.id;
            }
            if (!id) return fail("forget requires id or matching text");
            return memory.forget(id) ? ok(`resolved ${id}`) : fail(`no fact or question ${id}`);
          }
          case "state":
            return ok(memory.renderMarkdown());
          default:
            return fail(`unknown context action: ${params.action}`);
        }
      } catch (error) {
        return fail(error instanceof Error ? error.message : String(error));
      }
    },
  };
}
