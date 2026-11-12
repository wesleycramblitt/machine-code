/**
 * machine_code — run history as read-only typed commands.
 *
 * Runs live under `.machine_code/local/runs/<id>/` per project. Agents can
 * list them and read one back (summary, state, or event tail) for
 * self-improvement. There is no mutation surface: no resume, fork, delete,
 * or respond here.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { CommandSpec } from "./registry.js";
import { layout } from "../paths.js";
import { listAllRuns, listProjects, readRun } from "../state/runs.js";
import { capText, COMMAND_CAP_BYTES } from "../tools/safety.js";
import type { Layout } from "../paths.js";

function oneLine(text: string, max = 120): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length <= max ? clean : `${clean.slice(0, Math.max(0, max - 1))}…`;
}

/** This repo first, then registered projects; unique id suffix accepted. */
function findRun(home: string, id: string): { layout: Layout; run: NonNullable<ReturnType<typeof readRun>> } | null {
  const here = layout();
  const local = readRun(here, id);
  if (local) return { layout: here, run: local };
  for (const project of listProjects(home)) {
    const rl = layout(project);
    const r = readRun(rl, id);
    if (r) return { layout: rl, run: r };
  }
  if (id.length >= 4) {
    const matches = listAllRuns(home).filter((run) => run.id.endsWith(id) || run.id.includes(id));
    if (matches.length === 1) {
      const rl = layout(matches[0]!.repoRoot);
      const r = readRun(rl, matches[0]!.id);
      if (r) return { layout: rl, run: r };
    }
  }
  return null;
}

export function runCommands(layout: Layout): Map<string, CommandSpec> {
  const out = new Map<string, CommandSpec>();

  out.set("run:list", {
    name: "run:list",
    description: "List recent runs across projects (id, agent, status, item, turns). Read-only.",
    binary: "node",
    args: () => [],
    schema: {
      agent: { type: "string", description: "Filter by agent name." },
      status: { type: "string", description: "Filter by status." },
      limit: { type: "number", description: "Max runs (1-50, default 20)." },
    },
    readonly: true,
    timeoutMs: 15_000,
    handler: async (args) => {
      const agent = typeof args.agent === "string" && args.agent ? args.agent : undefined;
      const status = typeof args.status === "string" && args.status ? args.status : undefined;
      const limit = Math.max(1, Math.min(50, Math.floor(Number(args.limit) || 20)));
      let runs = listAllRuns(layout.home);
      if (agent) runs = runs.filter((run) => run.agent === agent);
      if (status) runs = runs.filter((run) => run.status === status);
      runs = runs.slice(0, limit);
      if (runs.length === 0) return { text: "no runs", isError: false };
      const lines = runs.map((run) =>
        `${run.id} | ${run.agent} | ${run.status} | turns ${run.turns} | ${run.itemId ?? "-"} | ${oneLine(run.request)}`,
      );
      return { text: capText(lines.join("\n"), COMMAND_CAP_BYTES).text, isError: false };
    },
  });

  out.set("run:show", {
    name: "run:show",
    description: "Read one run: summary, state.md, or the event tail. Read-only.",
    binary: "node",
    args: () => [],
    schema: {
      id: { type: "string", required: true, description: "Run id." },
      part: { type: "string", description: "summary (default) | state | tail." },
    },
    readonly: true,
    timeoutMs: 15_000,
    handler: async (args) => {
      const id = typeof args.id === "string" ? args.id.trim() : "";
      if (!id || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) {
        return { text: "run:show requires a valid id", isError: true };
      }
      const part = typeof args.part === "string" ? args.part : "summary";
      const found = findRun(layout.home, id);
      if (!found) return { text: `no run ${id}`, isError: true };
      const summary = found.run.summary;
      if (part === "state") {
        const file = join(found.layout.runsDir, summary.id, "state.md");
        if (!existsSync(file)) return { text: `run ${id} has no state.md`, isError: false };
        return { text: capText(readFileSync(file, "utf8"), COMMAND_CAP_BYTES).text, isError: false };
      }
      if (part === "tail") {
        const events = found.run.events ?? [];
        if (events.length === 0) return { text: `run ${id} has no events`, isError: false };
        const lines = events.slice(-25).map((event) => {
          const type = typeof event.type === "string" ? event.type : "?";
          const rest = { ...event } as Record<string, unknown>;
          delete rest.t;
          delete rest.type;
          return `${type} ${oneLine(JSON.stringify(rest), 160)}`;
        });
        return { text: capText(`last ${lines.length} of ${events.length} events:\n${lines.join("\n")}`, COMMAND_CAP_BYTES).text, isError: false };
      }
      if (part !== "summary") return { text: `unknown part "${part}". Use summary | state | tail.`, isError: true };
      const lines = [
        `id: ${summary.id}`,
        `agent: ${summary.agent}`,
        `status: ${summary.status}`,
        ...(summary.itemId ? [`item: ${summary.itemId}`] : []),
        `turns: ${summary.turns}`,
        ...(summary.branch ? [`branch: ${summary.branch}`] : []),
        ...(summary.worktree ? [`worktree: ${summary.worktree}`] : []),
        `request: ${summary.request}`,
        ...(summary.error ? [`error: ${summary.error}`] : []),
      ];
      return { text: capText(lines.join("\n"), COMMAND_CAP_BYTES).text, isError: false };
    },
  });

  return out;
}
