/**
 * machine_code — the `task` tool: capability-gated delegation.
 *
 * An authorized agent (architect with delegate=true, or sudo) spawns child
 * runs: Build/Review for an architect, sudo-only children for sudo. The child
 * is a real run — its own id, events, transcript, and (for Build/Sudo) its own
 * worktree — with `parentRunId` lineage back to the delegating run.
 *
 * Delegation is a tool call, not a workflow: one coordinating run can spawn,
 * inspect, and evaluate children across many cycles while keeping its own
 * transcript and context.
 *
 * wait=true (default) runs the child synchronously in this process and blocks
 * until the child reaches a terminal state. A child configured to ask waits
 * for the human exactly like any other run (the spawn call blocks meanwhile).
 * wait=false spawns a detached child process and returns immediately.
 */
import { Type, type Static } from "typebox";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { Layout } from "../paths.js";
import type { MachineConfig, Policy } from "../config.js";
import type { MutableModels } from "../models.js";
import type { CatalogueRow } from "../catalogue/types.js";
import { listRuns, RunRecorder, type RunSummary } from "../state/runs.js";
import { createWorktree, WorktreeError } from "../worktree.js";
import type { AgentConfig } from "../agents/config.js";

export interface TaskContext {
  layout: Layout;
  recorder: RunRecorder;
  parentRole: string;
  parentCapabilities: readonly string[];
  parentConfig?: AgentConfig;
  machine: MachineConfig;
  policy: Policy;
  models: MutableModels;
  catalogue: readonly CatalogueRow[];
  configuredProviders: ReadonlySet<string>;
  commands: ReadonlyMap<string, import("../commands/registry.js").CommandSpec>;
  root: string;
  toolRoot: string;
  home: string;
  requireModel?: string;
  signal?: AbortSignal;
  processes?: import("../processes/supervisor.js").ProcessSupervisor;
}

const TaskParams = Type.Object({
  action: Type.Optional(
    Type.Union(
      [Type.Literal("spawn"), Type.Literal("status"), Type.Literal("result")],
      { description: "spawn a child run (default), or inspect one of your children." },
    ),
  ),
  agent: Type.Optional(
    Type.Union([Type.Literal("build"), Type.Literal("review"), Type.Literal("sudo")], {
      description: "Child role. An architect may spawn build/review; sudo may only spawn sudo.",
    }),
  ),
  issue: Type.Optional(
    Type.String({ description: "Task issue number for the child's work (e.g. \"31\")." }),
  ),
  prompt: Type.Optional(Type.String({ description: "The child's objective/spec (spawn only)." })),
  verification: Type.Optional(
    Type.Union([Type.Literal("direct"), Type.Literal("verified"), Type.Literal("redundant")], {
      description: "Verification level for the child (default: your own).",
    }),
  ),
  wait: Type.Optional(Type.Boolean({ description: "Wait for the child to finish (default true)." })),
  reviewOfRunId: Type.Optional(
    Type.String({ description: "Review child: the build run whose worktree should be reviewed." }),
  ),
  runId: Type.Optional(Type.String({ description: "Child run id for status/result." })),
});

function ok(text: string): AgentToolResult<undefined> {
  return { content: [{ type: "text", text }], details: undefined };
}

function fail(text: string): AgentToolResult<undefined> {
  return { content: [{ type: "text", text }], details: undefined, isError: true };
}

/** Max delegation depth below a root run (bounds sudo chains). */
const MAX_DELEGATION_DEPTH = 3;

function depthOf(run: RunSummary, byId: Map<string, RunSummary>): number {
  let depth = 0;
  let current: RunSummary | undefined = run;
  while (current?.parentRunId && depth < 10) {
    current = byId.get(current.parentRunId);
    depth += 1;
  }
  return depth;
}

function childLine(s: RunSummary): string {
  const bits = [`status=${s.status}`, `agent=${s.agent}`, `calls=${s.modelCalls}`, `tokens=${s.usage.totalTokens}`];
  if (s.error) bits.push(`error=${s.error}`);
  if (s.finalText) bits.push(`final: ${s.finalText.slice(0, 600).replace(/\s+/g, " ")}`);
  return bits.join(" ");
}

function readEvents(runDir: string): Array<Record<string, unknown>> {
  try {
    const file = join(runDir, "events.jsonl");
    if (!existsSync(file)) return [];
    return readFileSync(file, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
  } catch {
    return [];
  }
}

export function taskTool(ctx: TaskContext): AgentTool<typeof TaskParams> {
  const deny = (reason: string): AgentToolResult<undefined> => fail(`delegation denied: ${reason}`);
  return {
    name: "task",
    label: "task",
    description:
      "Delegate work to a child run. spawn: create a child (build/review for an architect; sudo only for sudo) " +
      "with its own run id and worktree; the call blocks until the child finishes (children that ask questions " +
      "wait for the human like any other run). status/result: inspect one of your own child runs.",
    parameters: TaskParams,
    async execute(_toolCallId, params: Static<typeof TaskParams>, signal) {
      try {
        const action = params.action ?? "spawn";
        if (action === "spawn") return await spawnChild(params, signal);
        return inspectChild(params, action);
      } catch (error) {
        return fail(error instanceof Error ? error.message : String(error));
      }
    },
  };

  async function spawnChild(params: Static<typeof TaskParams>, signal?: AbortSignal): Promise<AgentToolResult<undefined>> {
    if (!ctx.parentCapabilities.includes("run:spawn")) return deny("run:spawn capability missing");
    const childRole = params.agent;
    if (!childRole) return fail("spawn requires agent (build | review | sudo)");
    if (ctx.parentRole === "sudo") {
      if (childRole !== "sudo") return deny("sudo may only spawn sudo children");
    } else if (ctx.parentRole === "architect") {
      if (childRole !== "build" && childRole !== "review") return deny("an architect may only spawn build or review");
    } else {
      return deny(`role ${ctx.parentRole} cannot delegate`);
    }
    if (!params.prompt || params.prompt.trim().length === 0) return fail("spawn requires prompt");

    // Depth guard against recursive delegation chains.
    const runs = listRuns(ctx.layout);
    const byId = new Map(runs.map((r) => [r.id, r]));
    const self = byId.get(ctx.recorder.id);
    if (self && depthOf(self, byId) >= MAX_DELEGATION_DEPTH) {
      return deny(`delegation depth limit (${MAX_DELEGATION_DEPTH}) reached`);
    }

    let issueNumber: number | undefined;
    if (params.issue !== undefined && params.issue.trim() !== "") {
      const n = Number(params.issue.replace(/^.*#/, ""));
      if (!Number.isInteger(n) || n <= 0) return fail(`issue must be a positive issue number, got "${params.issue}"`);
      issueNumber = n;
    }

    // Resolve the Task + its parent Feature so the child worktree bases on the
    // feature branch and the run carries a Task-only association.
    let issueRef: import("../issues/provider.js").IssueRef | undefined;
    let featureNumber: number | undefined;
    let issueProvider: import("../issues/provider.js").IssueProvider | undefined;
    if (issueNumber !== undefined) {
      const { createIssueProvider } = await import("../issues/index.js");
      const bundle = await createIssueProvider(ctx.layout, ctx.machine);
      if (bundle.provider.kind !== "none") {
        const { validateRunIssue } = await import("../issues/reserved.js");
        const issue = await validateRunIssue(bundle.provider, { provider: "github", repo: bundle.repo!, number: issueNumber });
        issueRef = issue.ref;
        featureNumber = issue.parent?.number;
        issueProvider = bundle.provider;
      }
    }

    const verification = params.verification ?? ctx.parentConfig?.verification ?? "verified";
    const child = new RunRecorder(ctx.layout, {
      agent: childRole,
      mode: verification,
      request: params.prompt,
      repoRoot: ctx.root,
      parentRunId: ctx.recorder.id,
      rootRunId: ctx.recorder.current.rootRunId ?? ctx.recorder.id,
      forkReason: "manual",
      ...(issueRef ? { issue: issueRef } : {}),
    });
    ctx.recorder.event("child_spawned", { childRunId: child.id, role: childRole, issue: params.issue, verification });

    if (params.wait === false) {
      // Detached child: a fresh process with lineage flags. Delegated
      // build/review children execute directly (no re-planning).
      const { fileURLToPath } = await import("node:url");
      const cliPath = fileURLToPath(new URL("../../cli.js", import.meta.url));
      const args = [
        "run",
        "--parent",
        ctx.recorder.id,
        "--agent",
        childRole,
        "--mode",
        verification,
        "--direct-exec",
        "true",
        ...(params.reviewOfRunId ? ["--review-of", params.reviewOfRunId] : []),
        ...(ctx.requireModel ? ["--model", ctx.requireModel] : []),
        params.prompt!,
      ];
      if (ctx.processes) {
        const childEnv = Object.fromEntries(
          Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
        );
        const started = await ctx.processes.start(process.execPath, [cliPath, ...args], {
          cwd: ctx.root,
          env: childEnv,
          origin: "orchestrator",
          name: `delegated:${childRole}`,
        });
        if (started.record.status === "spawn-error") {
          return fail(`could not start child run: ${started.record.error ?? "spawn failed"}`);
        }
        return ok(
          `spawned detached child run (parent ${ctx.recorder.id}, process ${started.processId}); ` +
            "list your children later with task action=status once it registers.",
        );
      }
      const { spawn } = await import("node:child_process");
      const detached = spawn(process.execPath, [cliPath, ...args], {
        cwd: ctx.root,
        detached: true,
        stdio: "ignore",
        env: process.env,
      });
      detached.unref();
      return ok(`spawned detached child run (parent ${ctx.recorder.id}); list your children later with task action=status once it registers.`);
    }

    // Synchronous child: Build gets its own worktree; reviewers and Sudo share
    // the parent tree.
    let childToolRoot = ctx.root;
    if (childRole === "build") {
      try {
        const spec = await createWorktree({
          layout: ctx.layout,
          runId: child.id,
          kind: issueNumber !== undefined ? "task" : "run",
          issueNumber,
          featureNumber,
        });
        child.patchSummary({ worktree: spec.path, branch: spec.branch, baseBranch: spec.baseBranch, baseRef: spec.baseRef });
        child.event("worktree_created", {
          path: spec.path,
          branch: spec.branch,
          baseRef: spec.baseRef,
          baseBranch: spec.baseBranch,
          linkedDirs: spec.linkedDirs,
          skippedLinks: spec.skippedLinks,
        });
        childToolRoot = spec.path;
      } catch (error) {
        if (error instanceof WorktreeError) {
          child.finalize("blocked", `${error.code}: ${error.message}`);
          ctx.recorder.event("child_completed", { childRunId: child.id, status: "blocked" });
          return ok(`child run ${child.id} blocked before start: ${error.code}: ${error.message}`);
        }
        throw error;
      }
    } else if (childRole === "review") {
      const ownerRunId = params.reviewOfRunId ?? latestBuildChild(runs);
      const owner = ownerRunId ? runs.find((r) => r.id === ownerRunId) : undefined;
      if (!owner?.worktree) {
        child.finalize("blocked", "review requires a build worktree (pass reviewOfRunId)");
        ctx.recorder.event("child_completed", { childRunId: child.id, status: "blocked" });
        return ok(`child run ${child.id} blocked: no build worktree to review`);
      }
      childToolRoot = owner.worktree;
      child.patchSummary({ worktree: owner.worktree, worktreeOwnerRunId: owner.id, branch: owner.branch, baseBranch: owner.baseBranch });
    }

    // Child context: its Task hierarchy + the parent run summary.
    const { assembleContext } = await import("../context/assemble.js");
    const { writeJsonAtomic } = await import("../state/run-schema.js");
    const childContext = await assembleContext({
      layout: ctx.layout,
      machine: ctx.machine,
      provider: issueProvider,
      issue: issueRef,
      parentRun: {
        id: ctx.recorder.id,
        request: ctx.recorder.current.request,
        finalText: ctx.recorder.current.finalText,
      },
    });
    if (childContext.text) {
      writeJsonAtomic(join(child.dir, "context.json"), { chars: childContext.chars, sources: childContext.sources });
      child.event("context_assembled", { chars: childContext.chars, sources: childContext.sources });
    }

    const { resolveAgent } = await import("../agents/config.js");
    const resolved = resolveAgent(ctx.layout, childRole, {
      agentPolicy: ctx.policy.agents[childRole],
      machineOverrides: ctx.machine.agents[childRole],
      runOverrides: { verification },
    });
    child.recordConfig({ ...resolved.config, capabilities: resolved.capabilities });
    const { policyFor } = await import("../orchestrate.js");
    const { runLoop } = await import("../loop.js");
    const result = await runLoop({
      models: ctx.models,
      catalogue: ctx.catalogue,
      configuredProviders: ctx.configuredProviders,
      agent: resolved.def,
      policy: policyFor(ctx.layout, childRole, ctx.policy),
      machine: ctx.machine,
      request: params.prompt!,
      root: ctx.root,
      toolRoot: childToolRoot,
      home: ctx.home,
      recorder: child,
      commands: ctx.commands,
      requireModel: ctx.requireModel,
      signal,
    });
    // Publish (runner-owned): commit is already in the child branch; push it
    // and open the Task PR into the feature branch when tracked.
    if ((childRole === "build" || childRole === "sudo") && result.status === "completed") {
      const { maybePublish } = await import("../pr/publish.js");
      await maybePublish({
        layout: ctx.layout,
        machine: ctx.machine,
        recorder: child,
        defaultApproval: resolved.config.approval,
        title: `Task: ${params.prompt!.split("\n")[0]!.slice(0, 120)}`,
      });
    }
    child.finalize(result.status, result.error, result.finalText);
    ctx.recorder.event("child_completed", { childRunId: child.id, status: result.status });
    return ok(`child run ${child.id}: ${childLine(child.current)}`);
  }

  function latestBuildChild(runs: RunSummary[]): string | undefined {
    const mine = runs
      .filter((r) => r.parentRunId === ctx.recorder.id && r.agent === "build" && r.worktree)
      .sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
    return mine[0]?.id;
  }

  function inspectChild(params: Static<typeof TaskParams>, action: "status" | "result"): AgentToolResult<undefined> {
    if (!ctx.parentCapabilities.includes("run:coordinate")) return deny("run:coordinate capability missing");
    if (!params.runId) return fail(`${action} requires runId`);
    const runs = listRuns(ctx.layout);
    const child = runs.find((r) => r.id === params.runId);
    if (!child) return fail(`no such child run: ${params.runId}`);
    // Only own descendants are visible.
    const byId = new Map(runs.map((r) => [r.id, r]));
    let cursor: RunSummary | undefined = child;
    let isDescendant = false;
    while (cursor?.parentRunId) {
      if (cursor.parentRunId === ctx.recorder.id) {
        isDescendant = true;
        break;
      }
      cursor = byId.get(cursor.parentRunId);
    }
    if (!isDescendant) return deny("runId is not one of your child runs");
    if (action === "status") return ok(`run ${child.id}: ${childLine(child)}`);
    const detail = child.finalText ? child.finalText.slice(0, 2000) : "(no final text)";
    return ok(`run ${child.id}: status=${child.status}${child.error ? ` error=${child.error}` : ""}\n${detail}`);
  }
}
