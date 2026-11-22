/**
 * machine_code — the `runData` tool.
 *
 * A controlled, read-only window into past runs for architect and engineer
 * agents. It offers exactly two operations: `list` recent runs with their
 * summaries, and `read` one run's summary + events by id. It reuses the
 * existing run readers (`listRuns`/`readRun`) and the cross-project lookup
 * (`listAllRuns`/`listProjects`), so nothing about run data is new here.
 *
 * The tool is read-only by construction: it only reads the run directory and
 * never creates, updates, or deletes anything, so reading history cannot
 * perturb the current run's state.
 *
 * The run directory itself stays opaque: the agent gets summaries and events
 * through this tool, never a wildcard filesystem handle into it.
 */
import { Type, type Static } from "typebox";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ToolContext } from "./index.js";
import { layout, type Layout } from "../paths.js";
import { listAllRuns, listProjects, listRuns, readRun, type RunSummary } from "../state/runs.js";
import { capText, COMMAND_CAP_BYTES } from "./safety.js";

/** Home directory for cross-project lookup: read from env like layout(). */
function home(): string {
  return process.env.MACHINE_CODE_HOME ?? layout().home;
}

/** Capability guard for the `runData` tool. */
export const RUN_READ_CAPABILITY = "run:read";

const RunDataParams = Type.Object({
  action: Type.Union([Type.Literal("list"), Type.Literal("read")], {
    description: "list recent runs, or read one run's summary and events by id.",
  }),
  limit: Type.Optional(Type.Number({ description: "Max runs for list (1-50, default 20)." })),
  id: Type.Optional(Type.String({ description: "Run id to read. Optional for list." })),
  repo: Type.Optional(Type.String({ description: "Repo root to read runs from. Defaults to this project." })),
});

function ok(text: string): AgentToolResult<undefined> {
  return { content: [{ type: "text", text }], details: undefined };
}

function fail(text: string): AgentToolResult<undefined> {
  return { content: [{ type: "text", text }], details: undefined, isError: true };
}

function oneLine(text: string, max = 120): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length <= max ? clean : `${clean.slice(0, Math.max(0, max - 1))}…`;
}

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Resolve the Layout to read runs from: the agent's own project by default,
 *  or a registered project when `repo` is given. Cross-project reads are
 *  confined to registered project roots, mirroring the TUI's repo resolution. */
function resolveLayout(ctx: ToolContext, repo: string | undefined): Layout | null {
  if (!repo || repo.trim() === "") return layout(ctx.repoRoot ?? ctx.root);
  const match = listProjects(home()).find((project) => project === repo.trim() || project.endsWith(repo.trim()));
  if (!match) return null;
  return layout(match);
}

/** Find a run by id: the target project first, else across all registered
 *  projects, accepting a unique id suffix. Mirrors run:show's findRun. */
function findRun(base: Layout, id: string): { layout: Layout; summary: RunSummary } | null {
  const local = readRun(base, id);
  if (local) return { layout: base, summary: local.summary };
  for (const project of listProjects(home())) {
    const rl = layout(project);
    const r = readRun(rl, id);
    if (r) return { layout: rl, summary: r.summary };
  }
  if (id.length >= 4) {
    const matches = listAllRuns(home()).filter((run) => run.id.endsWith(id) || run.id.includes(id));
    if (matches.length === 1) {
      const rl = layout(matches[0]!.repoRoot);
      const r = readRun(rl, matches[0]!.id);
      if (r) return { layout: rl, summary: r.summary };
    }
  }
  return null;
}

function listText(select: Layout, limit: number): string {
  // Prefer the current project's runs; fall back to all registered projects.
  let runs = listRuns(select);
  if (runs.length === 0 && listProjects(home()).length > 0) runs = listAllRuns(home());
  runs = runs.slice(0, limit);
  if (runs.length === 0) return "no runs";
  return runs
    .map((run) =>
      `${run.id} | ${run.agent} | ${run.status} | ${run.itemId ? `item ${run.itemId}` : "-"} | ${run.startedAt} | ${oneLine(run.request)}`,
    )
    .join("\n");
}

function readText(found: { layout: Layout; summary: RunSummary }): string {
  const s = found.summary;
  const record = readRun(found.layout, s.id);
  const events = record?.events ?? [];
  const head = [
    `id: ${s.id}`,
    `agent: ${s.agent}`,
    `status: ${s.status}`,
    `startedAt: ${s.startedAt}`,
    ...(s.itemId ? [`item: ${s.itemId}`] : []),
    `turns: ${s.turns}`,
    `modelCalls: ${s.modelCalls}`,
    ...(s.branch ? [`branch: ${s.branch}`] : []),
    `request: ${s.request}`,
    ...(s.summary ? [`summary: ${oneLine(s.summary, 240)}`] : []),
    ...(s.error ? [`error: ${s.error}`] : []),
  ].join("\n");
  const eventTail = events.length > 0
    ? `\nevents (last 25 of ${events.length}):\n${events.slice(-25).map((event) => {
        const type = typeof event.type === "string" ? event.type : "?";
        const rest = { ...event } as Record<string, unknown>;
        delete rest.t;
        delete rest.type;
        return `${type} ${oneLine(JSON.stringify(rest), 160)}`;
      }).join("\n")}`
    : "";
  return capText(`${head}${eventTail}`, COMMAND_CAP_BYTES).text;
}

export function runDataTool(ctx: ToolContext): AgentTool<typeof RunDataParams> {
  return {
    name: "runData",
    label: "runData",
    description:
      "Read past runs read-only: list lists recent runs with their summaries " +
      "(id, agent, status, item, startedAt); read returns one run's summary and events by id. " +
      "The run directory is otherwise opaque. Reading history never changes current state.",
    parameters: RunDataParams,
    async execute(_id, params: Static<typeof RunDataParams>) {
      try {
        if (!(ctx.capabilities ?? []).includes(RUN_READ_CAPABILITY)) {
          return fail(`runData requires the "${RUN_READ_CAPABILITY}" capability`);
        }
        const select = resolveLayout(ctx, params.repo);
        if (!select) return fail(`no registered project matching repo "${params.repo}"`);
        if (params.action === "list") {
          const limit = Math.max(1, Math.min(50, Math.floor(Number(params.limit) || 20)));
          return ok(listText(select, limit));
        }
        const id = params.id?.trim() ?? "";
        if (!id) return fail("read requires a run id");
        if (!ID_RE.test(id)) return fail(`invalid run id: ${id}`);
        const found = findRun(select, id);
        if (!found) return fail(`no run ${id}`);
        return ok(readText(found));
      } catch (error) {
        return fail(error instanceof Error ? error.message : String(error));
      }
    },
  };
}