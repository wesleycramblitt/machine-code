/**
 * machine_code — execute one ready task.
 *
 * Builds a frozen packet from the issue plan, creates the Task worktree,
 * delegates Build/gates/review/PR to the existing mode orchestrator, and
 * records orchestration lineage on the run. Issue closure remains a human
 * acceptance step.
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Issue, IssueProvider, IssueRef } from "../issues/provider.js";
import type { Layout } from "../paths.js";
import type { MachineConfig, Policy } from "../config.js";
import type { MutableModels } from "../models.js";
import type { CatalogueRow } from "../catalogue/types.js";
import type { AgentConfig } from "../agents/config.js";
import { RunRecorder, registerProject, type RunStatus } from "../state/runs.js";
import { createWorktree, WorktreeError } from "../worktree.js";
import { parseVerificationCommands, writePacket, type PacketAcceptance, type TaskPacket } from "../packet.js";
import { parseArtifactReferences } from "../context/references.js";
import { assembleContext } from "../context/assemble.js";
import { writeJsonAtomic } from "../state/run-schema.js";
import { ProcessSupervisor } from "../processes/supervisor.js";
import { loadAvailability } from "../availability.js";
import { executePacket } from "../orchestrate.js";
import type { PlanMarker } from "../plan/schema.js";
import type { OrchestrationScope } from "./scheduler.js";

export interface ExecuteTaskInput {
  layout: Layout;
  machine: MachineConfig;
  policy: Policy;
  models: MutableModels;
  catalogue: readonly CatalogueRow[];
  configuredProviders: ReadonlySet<string>;
  home: string;
  provider: IssueProvider;
  issue: Issue;
  plan: PlanMarker;
  orchestrationId?: string;
  orchestrationScope?: OrchestrationScope;
  scopeRef?: IssueRef;
  attempt?: number;
  requireModel?: string;
  agentOverrides?: Partial<AgentConfig>;
  signal?: AbortSignal;
  /** Run the independent Review agent after gates. Defaults to true. */
  review?: boolean;
  /** Worktree base override; defaults to the parent Feature branch. */
  base?: string;
  /** Reuse an existing Task worktree instead of creating a new one. */
  worktree?: string;
  worktreeOwnerRunId?: string;
  branch?: string;
  baseBranch?: string;
  baseRef?: string;
  /** Prior failed-attempt evidence passed to the next Build. */
  retryEvidence?: string;
}

export interface ExecuteTaskResult {
  runId: string;
  status: RunStatus;
  error?: string;
  commit?: string;
  reviewVerdict?: string;
  mergeState?: import("../orchestrate.js").MergeState;
  prNumber?: number;
  prUrl?: string;
  prState?: "none" | "open" | "merged" | "closed";
}

function packetAcceptance(line: string): PacketAcceptance | null {
  const trimmed = line.trim();
  const match = /^(\S+)(?:\s+(.*))?$/.exec(trimmed);
  const command = match?.[1] ?? trimmed;
  if (!/^[a-z][a-z0-9-]*:[a-z0-9-]+$/.test(command)) return null;
  const rest = match?.[2]?.trim() ?? "";
  if (!rest) return { command };
  if (rest.startsWith("{")) {
    try {
      return { command, args: JSON.parse(rest) as Record<string, unknown> };
    } catch {
      // fall through to key=value parsing
    }
  }
  const args: Record<string, unknown> = {};
  const tokens = rest.split(/\s+/).filter(Boolean);
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]!;
    if (token.startsWith("--")) {
      const key = token.slice(2);
      const next = tokens[index + 1];
      if (next && !next.startsWith("--")) {
        args[key] = next;
        index += 1;
      } else {
        args[key] = true;
      }
      continue;
    }
    const [key, ...value] = token.split("=");
    if (key && value.length > 0) args[key] = value.join("=");
  }
  return { command, ...(Object.keys(args).length > 0 ? { args } : {}) };
}

export function packetForTask(issue: Issue, plan: PlanMarker, attempt: number): TaskPacket {
  const references = parseArtifactReferences(issue.body);
  const acceptance: PacketAcceptance[] = [];
  const seen = new Set<string>();
  const lines = [...issue.acceptance, ...parseVerificationCommands(issue.body)];
  for (const line of lines) {
    const parsed = packetAcceptance(line);
    if (!parsed) continue;
    const key = JSON.stringify(parsed);
    if (seen.has(key)) continue;
    seen.add(key);
    acceptance.push(parsed);
  }
  return {
    id: `issue-${issue.ref.number}-${attempt}`,
    mode: plan.verification,
    goal: issue.title,
    context: references.files,
    constraints: [issue.body.slice(0, 8_000)],
    acceptance,
  };
}

function snapshotHash(packet: TaskPacket, plan: PlanMarker): string {
  return createHash("sha256").update(JSON.stringify({ packet, plan })).digest("hex");
}

export async function executeTask(input: ExecuteTaskInput): Promise<ExecuteTaskResult> {
  const { layout, issue, plan } = input;
  const attempt = input.attempt ?? 1;
  const packet = packetForTask(issue, plan, attempt);
  if (input.retryEvidence) {
    packet.constraints = [...packet.constraints, `Previous attempt failed:\n${input.retryEvidence.slice(0, 4_000)}`];
  }
  const hash = snapshotHash(packet, plan);
  const recorder = new RunRecorder(layout, {
    agent: "build",
    mode: plan.verification,
    request: packet.goal,
    repoRoot: layout.repoRoot,
    issue: issue.ref,
    ...(input.orchestrationId ? { orchestrationId: input.orchestrationId } : {}),
    ...(input.orchestrationScope ? { orchestrationScope: input.orchestrationScope } : {}),
    ...(input.scopeRef ? { scopeRef: input.scopeRef } : {}),
    taskIssue: issue.ref,
    attempt,
    phase: "build",
    planSnapshotHash: hash,
    planReview: plan.planReview,
    resultReview: plan.resultReview,
  });
  registerProject(layout.home, layout.repoRoot);
  recorder.event("task_snapshot", { issue: issue.ref.number, hash, attempt });
  writePacket(layout, packet, { local: true });
  recorder.event("packet_persisted", { id: packet.id, local: true });

  let toolRoot = layout.repoRoot;
  const setupProcesses = new ProcessSupervisor({
    runId: recorder.id,
    runDir: recorder.dir,
    onEvent: (type, data) => recorder.event(type, data),
  });
  try {
    if (input.worktree) {
      if (!existsSync(input.worktree)) {
        recorder.finalize("blocked", `retry worktree is missing: ${input.worktree}`);
        return { runId: recorder.id, status: "blocked", error: `retry worktree is missing: ${input.worktree}` };
      }
      toolRoot = input.worktree;
      recorder.patchSummary({
        worktree: toolRoot,
        ...(input.worktreeOwnerRunId ? { worktreeOwnerRunId: input.worktreeOwnerRunId } : {}),
        ...(input.branch ? { branch: input.branch } : {}),
        ...(input.baseBranch ? { baseBranch: input.baseBranch } : {}),
        ...(input.baseRef ? { baseRef: input.baseRef } : {}),
      });
      recorder.event("worktree_reused", {
        path: toolRoot,
        ...(input.worktreeOwnerRunId ? { parentRunId: input.worktreeOwnerRunId } : {}),
        ...(input.branch ? { branch: input.branch } : {}),
      });
    } else {
      const spec = await createWorktree({
        layout,
        runId: recorder.id,
        kind: "task",
        issueNumber: issue.ref.number,
        ...(issue.parent ? { featureNumber: issue.parent.number } : {}),
        ...(input.base ? { base: input.base } : {}),
        processes: setupProcesses,
      });
      toolRoot = spec.path;
      recorder.patchSummary({
        worktree: spec.path,
        branch: spec.branch,
        baseBranch: spec.baseBranch,
        baseRef: spec.baseRef,
      });
      recorder.event("worktree_created", {
        path: spec.path,
        branch: spec.branch,
        baseRef: spec.baseRef,
        baseBranch: spec.baseBranch,
        linkedDirs: spec.linkedDirs,
        skippedLinks: spec.skippedLinks,
        materialized: spec.materialized,
      });
    }
  } catch (error) {
    if (error instanceof WorktreeError) {
      recorder.finalize("blocked", `${error.code}: ${error.message}`);
      return { runId: recorder.id, status: "blocked", error: `${error.code}: ${error.message}` };
    }
    throw error;
  }

  const context = await assembleContext({
    layout,
    machine: input.machine,
    provider: input.provider,
    issue: issue.ref,
  });
  if (context.text) {
    writeJsonAtomic(join(recorder.dir, "context.json"), { chars: context.chars, sources: context.sources });
    recorder.event("context_assembled", { chars: context.chars, sources: context.sources });
  }

  try {
    const result = await executePacket({
      models: input.models,
      catalogue: input.catalogue,
      configuredProviders: input.configuredProviders,
      availability: loadAvailability(input.home),
      layout,
      machine: input.machine,
      policy: input.policy,
      packet,
      verification: plan.verification,
      review: input.review ?? true,
      request: packet.goal,
      root: layout.repoRoot,
      toolRoot,
      issueNumber: issue.ref.number,
      issue: issue.ref,
      ...(input.orchestrationId ? { orchestrationId: input.orchestrationId } : {}),
      ...(input.orchestrationScope ? { orchestrationScope: input.orchestrationScope } : {}),
      ...(input.scopeRef ? { scopeRef: input.scopeRef } : {}),
      attempt,
      planReview: plan.planReview,
      resultReview: plan.resultReview,
      home: input.home,
      recorder,
      ...(input.requireModel ? { requireModel: input.requireModel } : {}),
      ...(input.agentOverrides ? { agentOverrides: input.agentOverrides } : {}),
      contextText: context.text || undefined,
      ...(input.signal ? { signal: input.signal } : {}),
    });
    recorder.finalize(result.status, result.error, result.finalText);
    return {
      runId: recorder.id,
      status: result.status,
      ...(result.error ? { error: result.error } : {}),
      ...(result.commit ? { commit: result.commit } : {}),
      ...(result.reviewVerdict ? { reviewVerdict: result.reviewVerdict } : {}),
      ...(result.mergeState ? { mergeState: result.mergeState } : {}),
      ...(result.prNumber ? { prNumber: result.prNumber } : {}),
      ...(result.prUrl ? { prUrl: result.prUrl } : {}),
      ...(result.prState ? { prState: result.prState } : {}),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    recorder.finalize("failed", message);
    return { runId: recorder.id, status: "failed", error: message };
  }
}
