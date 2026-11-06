/**
 * machine_code — the `context` tool: explicit control of run state.
 *
 * The runner ingests tool results automatically. This tool lets the model
 * record a decision, set the next action, keep a working set, recall exact
 * bytes from an artifact, or inspect its own state.
 */
import { Type, type Static } from "typebox";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { READ_CAP_BYTES, capText } from "./safety.js";
import { buildRepoMap, renderOutline, symbolRange } from "../map/deterministic.js";
import type { ToolContext } from "./index.js";

function ok(text: string): AgentToolResult<undefined> {
  return { content: [{ type: "text", text }], details: undefined };
}

function fail(text: string): AgentToolResult<undefined> {
  return { content: [{ type: "text", text }], details: undefined, isError: true };
}

const CONTEXT_ACTIONS = new Set(["note", "focus", "recall", "forget", "state", "expand"]);
const CONTEXT_KINDS = new Set(["finding", "decision", "open", "next"]);

const ContextParams = Type.Object({
  action: Type.String({
    enum: ["note", "focus", "recall", "forget", "state", "expand"],
    description: "Memory or context operation: note | focus | recall | forget | state | expand.",
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
  target: Type.Optional(
    Type.String({ description: "For expand: a path or path#symbol, e.g. src/loop.ts#runLoop." }),
  ),
});

export function contextTool(ctx: ToolContext): AgentTool<typeof ContextParams> {
  return {
    name: "context",
    label: "context",
    description:
      "Control run state or expand task context. note needs text (kind: finding|decision|open|next). focus needs refs. " +
      "recall needs id. forget needs id or text. state takes no fields. expand needs target (path or path#symbol) and returns " +
      "the symbol/file plus imports, callers, and tests in one sweep. " +
      "Example: {\"action\":\"expand\",\"target\":\"src/loop.ts#runLoop\"}.",
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
          case "expand": {
            if (!params.target || params.target.trim().length === 0) {
              return fail("expand requires target: path or path#symbol");
            }
            const [path, symbol] = params.target.split("#");
            if (!path) return fail("expand target needs a path");
            const built = await buildRepoMap(ctx.root, { processes: ctx.processes });
            const file = built.map.files.find((entry) => entry.path === path);
            if (!file) return fail(`no mapped file "${path}"`);
            const absolute = join(ctx.root, path);
            if (!existsSync(absolute)) return fail(`file not found: ${path}`);
            const raw = readFileSync(absolute, "utf8");
            const lines = raw.split("\n");
            const parts: string[] = [];
            const add = (label: string, body: string): void => {
              if (body.trim()) parts.push(`### ${label}\n${body}`);
            };
            if (symbol) {
              const range = symbolRange(file, symbol);
              if (!range) {
                const known = file.symbols.slice(0, 16).map((entry) => `${entry.line} ${entry.kind} ${entry.name}`).join("\n");
                return fail(`no symbol "${symbol}" in ${path}. Known symbols:\n${known || "(none)"}`);
              }
              const body = lines
                .slice(range.start - 1, range.end)
                .map((line, index) => `${range.start + index}: ${line}`)
                .join("\n");
              add(`${path}:${range.start}-${range.end} (${symbol})`, body);
            } else if (lines.length > 200) {
              add(`${path} (outline)`, renderOutline(file));
            } else {
              add(path, raw);
            }

            const byPath = new Map(built.map.files.map((entry) => [entry.path, entry] as const));
            const imports = (file.imports ?? []).filter((dependency) => byPath.has(dependency)).slice(0, 8);
            for (const dependency of imports) {
              const depFile = byPath.get(dependency)!;
              const depRaw = readFileSync(join(ctx.root, dependency), "utf8");
              add(
                `${dependency} (import)`,
                depRaw.length <= 8_000 ? depRaw : renderOutline(depFile),
              );
            }

            const callers = built.map.files
              .filter((entry) => entry.path !== path && (entry.imports ?? []).includes(path))
              .slice(0, 8);
            for (const caller of callers) {
              const outline = renderOutline(caller);
              add(
                `${caller.path} (caller)`,
                outline.trim() || readFileSync(join(ctx.root, caller.path), "utf8").slice(0, 4_000),
              );
            }

            const stem = basename(path).replace(/\.[^.]+$/, "");
            const parent = basename(dirname(path));
            const testCandidates = [...new Set([
              `test/${parent}-${stem}.test.js`,
              `test/${stem}.test.js`,
              `test/${parent}/${stem}.test.js`,
              `test/${parent}-${stem}.test.ts`,
              `test/${stem}.test.ts`,
            ])];
            for (const candidate of testCandidates) {
              const abs = join(ctx.root, candidate);
              if (!existsSync(abs)) continue;
              add(`${candidate} (test)`, readFileSync(abs, "utf8"));
            }

            if (parts.length === 0) return fail(`nothing to expand for ${params.target}`);
            return ok(
              `<context-expansion target="${params.target}">\n` +
                `${capText(parts.join("\n\n"), READ_CAP_BYTES).text}\n` +
                "</context-expansion>",
            );
          }
          case "state":
            return ok(memory.renderMarkdown());
          default:
            return fail(`unknown context action "${params.action}". Use one of: ${[...CONTEXT_ACTIONS].join(", ")}.`);
        }
      } catch (error) {
        return fail(error instanceof Error ? error.message : String(error));
      }
    },
  };
}
