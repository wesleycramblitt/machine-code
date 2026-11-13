/**
 * machine_code — the `context` tool: run state, parent-run inspection, and plan.
 *
 * The runner ingests tool results automatically. This tool lets the model
 * record decisions/findings, recall artifact bytes, forget stale facts, view
 * its state, inspect a parent run's record, or manage a durable plan checklist.
 */
import { Type, type Static } from "typebox";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { READ_CAP_BYTES, capText } from "./safety.js";
import type { ToolContext } from "./index.js";

function ok(text: string): AgentToolResult<undefined> {
  return { content: [{ type: "text", text }], details: undefined };
}

function fail(text: string): AgentToolResult<undefined> {
  return { content: [{ type: "text", text }], details: undefined, isError: true };
}

const CONTEXT_ACTIONS = new Set(["note", "recall", "forget", "state", "parent", "plan"]);
const CONTEXT_KINDS = new Set(["finding", "decision", "open"]);

const PlanEntrySchema = Type.Object({
  text: Type.String({ description: "Step description, one short sentence." }),
  done: Type.Boolean({ description: "true when this step is complete." }),
});

const ContextParams = Type.Object({
  action: Type.String({
    enum: ["note", "recall", "forget", "state", "parent", "plan"],
    description: "Memory operation: note | recall | forget | state | parent | plan.",
  }),
  kind: Type.Optional(
    Type.String({
      enum: ["finding", "decision", "open"],
      description: "Note kind: finding | decision | open (default finding).",
    }),
  ),
  text: Type.Optional(Type.String({ description: "Note text (one short sentence)." })),
  refs: Type.Optional(
    Type.Array(Type.String(), { description: "References: path, path:line, or path:start-end." }),
  ),
  id: Type.Optional(Type.String({ description: "Artifact id for recall, fact/question id for forget, or run id for parent." })),
  steps: Type.Optional(
    Type.Array(PlanEntrySchema, {
      description:
        "Plan checklist: [{text: \"...\", done: false}, ...]. Replaces the entire plan. " +
        "Set to [] to clear. The plan renders in <run-state> every turn as checkboxes.",
    }),
  ),
});

/**
 * Load a run record (`run.json`) for the context tool's parent action. The
 * run lives under the repo's runs dir; walk up from the worktree root so
 * fork worktrees nested inside the repo still resolve.
 */
function loadParentRun(
  root: string,
  id: string,
): Record<string, unknown> | null {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) return null;
  let dir = root;
  for (let depth = 0; depth < 5; depth += 1) {
    const file = join(dir, ".machine_code", "local", "runs", id, "run.json");
    if (existsSync(file)) {
      try {
        const raw = JSON.parse(readFileSync(file, "utf8")) as unknown;
        if (raw && typeof raw === "object") return raw as Record<string, unknown>;
        return null;
      } catch {
        return null;
      }
    }
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return null;
}

export function contextTool(ctx: ToolContext): AgentTool<typeof ContextParams> {
  return {
    name: "context",
    label: "context",
    description:
      "Run state, memory, and plan. " +
      "plan (steps: [{text, done}]) sets a durable checklist — there is always exactly one plan; " +
      "calling it again replaces the old one. note (kind finding|decision|open) records conclusions; " +
      "recall (id) fetches stored artifacts; forget resolves facts; state dumps everything; " +
      "parent loads a parent run's record. " +
      "For codebase queries (definitions, references, file outlines) use inspect instead.",
    parameters: ContextParams,
    prepareArguments: (args): Static<typeof ContextParams> => {
      // Belt-and-suspenders: drop "null"/"undefined" string values that models
      // hedge with (the generic repair in repairToolArguments handles this too,
      // but only when the compiled dist/ includes the fix).
      if (!args || typeof args !== "object" || Array.isArray(args)) return args as Static<typeof ContextParams>;
      const out = { ...(args as Record<string, unknown>) };
      let changed = false;
      for (const [key, value] of Object.entries(out)) {
        if (typeof value === "string" && (value.trim() === "null" || value.trim() === "undefined")) {
          delete out[key];
          changed = true;
        }
      }
      return (changed ? out : args) as Static<typeof ContextParams>;
    },
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
            const kind = (params.kind ?? "finding") as "finding" | "decision" | "open";
            memory.note(kind, params.text, params.refs ?? []);
            return ok(`noted ${kind}`);
          }
          case "recall": {
            if (!params.id) return fail("recall requires id");
            const text = memory.getArtifact(params.id);
            if (text === null) return fail(`no artifact ${params.id}`);
            const capped = capText(text, READ_CAP_BYTES);
            const status = memory.artifactStatus(params.id);
            const stale =
              status !== null && status.stale
                ? `\n[stale: ${status.path} changed since this artifact was stored; current bytes are in the holdings block above]`
                : "";
            return ok(`[artifact ${params.id}]\n${capped.text}${stale}`);
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
          case "parent": {
            if (!params.id) return fail("parent requires id (a run id)");
            const record = loadParentRun(ctx.root, params.id);
            if (!record) return fail(`no run ${params.id}`);
            const status = typeof record.status === "string" ? record.status : undefined;
            const stopReason = typeof record.stopReason === "string" ? record.stopReason : undefined;
            const stopped = status !== undefined && status !== "completed" && status !== "running";
            const request = typeof record.request === "string" ? record.request : "";
            const error = typeof record.error === "string" ? record.error : "";
            const finalText = typeof record.finalText === "string" ? record.finalText : "";
            const lines = [
              `[parent run ${params.id}]`,
              ...(status ? [`status: ${status}${stopReason ? ` (${stopReason})` : ""}`] : []),
              ...(request ? [`request: ${request}`] : []),
              ...(error ? [`error: ${error}`] : []),
              ...(stopped ? ["note: this run stopped early; do not treat its conclusion as authoritative."] : []),
              ...(stopped ? ["result: withheld (run stopped early)"] : []),
              ...(!stopped && finalText ? [`result: ${finalText}`] : []),
            ].filter(Boolean);
            return ok(capText(lines.join("\n"), READ_CAP_BYTES).text);
          }
          case "plan": {
            if (!params.steps) return fail("plan requires steps: [{text, done}, ...]");
            const steps = params.steps.map((s) => ({ text: s.text.slice(0, 240), done: s.done }));
            memory.setPlan(steps);
            const done = steps.filter((s) => s.done).length;
            return ok(`plan set: ${done}/${steps.length} steps done`);
          }
          default:
            return fail(`unknown context action "${params.action}". Use one of: ${[...CONTEXT_ACTIONS].join(", ")}.`);
        }
      } catch (error) {
        return fail(error instanceof Error ? error.message : String(error));
      }
    },
  };
}