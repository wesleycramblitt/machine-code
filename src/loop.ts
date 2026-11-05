/**
 * machine_code — the local `Loop` interface: a thin wrapper over pi-agent-core.
 *
 * Selection is sticky within a provider attempt: the first eligible model
 * handles every turn so a run keeps one plan and one behavior. Re-pick only
 * when the context outgrows that model or a retry rotates to a new attempt.
 *
 * Retry: retryable provider errors (rate limit, free-tier limit, outage,
 * timeout, malformed) cool the failed target and rotate to the next eligible
 * model until one succeeds or none remain. Insufficient funds, auth failures,
 * and refusals do not retry.
 */
import { Agent, type AgentMessage, type AgentTool } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream, type Api, type AssistantMessage, type AssistantMessageEvent, type Context, type Message, type Model, type Usage } from "@earendil-works/pi-ai";
import { effectiveOutputCeiling, DEFAULT_FIRST_TOKEN_TIMEOUT_MS, type MachineConfig, type AgentPolicy, type Policy } from "./config.js";
import { estimateCallCost } from "./catalogue/scoring.js";
import { estimateTokens, pick, providerMultiplier, isFreeRow } from "./select.js";
import { applyClassification, classifyError, loadAvailability, saveAvailability } from "./availability.js";
import { fundedProviderIds } from "./data.js";
import type { CatalogueRow } from "./catalogue/types.js";
import type { AgentDef, AgentName } from "./agents.js";
import type { MutableModels } from "./models.js";
import { coreTools } from "./tools/index.js";
import { toolDefinitionChars, toolSchemaChars } from "./tools/schema.js";
import type { AgentConfig } from "./agents/config.js";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Layout } from "./paths.js";
import type { RunRecorder } from "./state/runs.js";
import { buildRepoMap, mapBytes, renderMapIndex, symbolCount, type MapFile } from "./map/deterministic.js";
import { ensureSemanticMap } from "./map/ensure.js";
import { isSemanticFresh, loadSemantic, readSemanticDirty, renderSemanticIndex, buildModuleIndex, mergeModuleIndex, saveSemanticMap, type SemanticMap } from "./map/semantic.js";
import { RunStateStore } from "./context/state.js";
import { inferPreloadFiles } from "./context/preload.js";
import { buildTaskPack, renderContextPack, type ContextPack } from "./context/pack.js";
import { contextBudget, type ContextBudget } from "./context/budget.js";
import { hasToolCallMarkup } from "./state/tool-call-text.js";
import { looksLikeSerializedArgs, repairToolArguments } from "./tools/args.js";
import { EvidenceTracker } from "./state/progress.js";
import { ProcessSupervisor } from "./processes/supervisor.js";
import { renderPromptMessages } from "./context/render.js";

/** Default turn cap. 0 means no cap; set max_turns per role or run. */
export const MAX_TURNS = 0;

/** Build research allowed before a concrete change plan is required. */
const BUILD_PLAN_RESEARCH_LIMIT = 12;
/** Extra research allowed after a plan, so verification is not a dead end. */
const BUILD_PLAN_POST_RESEARCH_LIMIT = 8;
/** Plan-checkpoint blocked turns allowed before the run stops. */
const PLAN_BLOCK_LIMIT = 3;
/** Successes that show a run did real work, not just memory bookkeeping. */
const SUBSTANTIVE_TOOLS = new Set(["read", "search", "command", "edit", "write", "issue", "pr"]);

/** A plan is a recorded decision that names concrete file changes. */
export function hasPlanDecision(facts: ReadonlyArray<{ text: string; status: string; kind: string }>): boolean {
  const file = /[\w./-]+\.(?:ts|tsx|js|jsx|py|rs|go|java|kt|swift|md|toml|yaml|yml)/gi;
  const verb = /(?:edit|add|remove|delete|update|change|write|replace|move|wire|fix|test|implement|drop)\b/gi;
  return facts.some((fact) => {
    if (fact.kind !== "decision" || fact.status !== "active") return false;
    const text = fact.text.trim();
    const files = new Set(text.match(file) ?? []);
    const verbs = text.match(verb) ?? [];
    // A decision that merely mentions "plan" is not a change plan. Require
    // targets and actions; otherwise a planner note such as "Already have a
    // plan" makes the harness demand an edit the role cannot make.
    return files.size >= 2 && verbs.length >= 2;
  });
}

/** Only the Build role is a code-change run with a mandatory plan gate. */
export function needsBuildPlan(agentName: string): boolean {
  return agentName === "build";
}

function issueRefKey(value: string): string {
  const url = /\/issues\/(\d+)(?:$|[?#])/.exec(value);
  if (url) return `#${url[1]}`;
  const hash = /#(\d+)\b/.exec(value);
  if (hash) return `#${hash[1]}`;
  const bare = value.trim();
  return /^\d+$/.test(bare) ? `#${bare}` : bare;
}

/** Canonical issue arguments so `repo#42`, `#42`, `42`, and a URL compare equal. */
function normalizedIssueKey(params: Record<string, unknown>): Record<string, unknown> {
  const out = { ...params };
  for (const key of ["issue", "parent"]) {
    if (typeof out[key] === "string") out[key] = issueRefKey(out[key] as string);
  }
  for (const key of ["blocked_by", "depends_on"]) {
    if (Array.isArray(out[key])) {
      out[key] = (out[key] as unknown[]).map((value) =>
        typeof value === "string" ? issueRefKey(value) : value,
      );
    }
  }
  if (out.action === "tree") {
    if (out.state === undefined || out.state === "all") delete out.state;
    if (out.depth === undefined || out.depth === 2) delete out.depth;
  }
  if (out.action === "list") {
    if (out.state === undefined || out.state === "all") delete out.state;
    if (out.limit === undefined || out.limit === 100) delete out.limit;
  }
  return out;
}

/**
 * Coarse read key: reads that begin in the same 100-line band are the same
 * unit. The limit is deliberately ignored; changing only `limit` must not
 * defeat the repeat guard.
 */
export function readBucket(params: Record<string, unknown>): string {
  const path = typeof params.path === "string" ? params.path : "";
  if (!path) return "";
  if (typeof params.symbol === "string") return `${path}#${params.symbol}`;
  if (typeof params.section === "string") return `${path}#section:${params.section.trim().toLowerCase()}`;
  if (typeof params.around === "number") return `${path}@${Math.floor(params.around / 100)}`;
  const offset = typeof params.offset === "number" && Number.isFinite(params.offset) ? Math.max(1, params.offset) : 1;
  return `${path}@${Math.floor(offset / 100)}`;
}

/** Stable JSON key for a tool call; argument order must not defeat the guard. */
function stableKey(value: unknown): string {
  try {
    return JSON.stringify(value, (_key, item) => {
      if (item && typeof item === "object" && !Array.isArray(item)) {
        return Object.fromEntries(
          Object.entries(item as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)),
        );
      }
      return item;
    });
  } catch {
    return String(value);
  }
}

/** Cap a JSON value for the event log: 8 KiB string budget, shallow-safe. */
function capJson(value: unknown): unknown {
  try {
    const s = JSON.stringify(value);
    if (s === undefined) return String(value).slice(0, 256);
    if (s.length <= 8192) return value;
    return { truncated: true, preview: s.slice(0, 8192) + "…" };
  } catch {
    return String(value).slice(0, 256);
  }
}

export interface RunLoopInput {
  models: MutableModels;
  catalogue: readonly CatalogueRow[];
  configuredProviders: ReadonlySet<string>;
  agent: AgentDef;
  policy: AgentPolicy;
  machine: MachineConfig;
  request: string;
  /** Main repository root: run state, spend, instances. */
  root: string;
  /** Worktree root for tools/commands when the run mutates code (default: root). */
  toolRoot?: string;
  home: string;
  availability?: import("./availability.js").AvailabilityState;
  recorder: RunRecorder;
  commands: ReadonlyMap<string, import("./commands/registry.js").CommandSpec>;
  requireProvider?: string;
  /** Pin model selection to one catalogue key/id (debug or policy). */
  requireModel?: string;
  /** Layout + full policy: enable the task tool (delegation). */
  layout?: Layout;
  fullPolicy?: Policy;
  /** The resolved agent config for this run (snapshot for children). */
  agentConfig?: AgentConfig;
  /** The resolved capability list for this run. */
  agentCapabilities?: string[];
  signal?: AbortSignal;
  /** Resume support: reconstructed transcript; start with continue() not prompt(). */
  initialMessages?: import("@earendil-works/pi-agent-core").AgentMessage[];
  startMode?: "prompt" | "continue";
  /** Assembled context block prepended to the first prompt. */
  contextText?: string;
  /** Skip the deterministic repo map index in the model's up-front context. */
  skipMap?: boolean;
  /** Skip semantic module annotations in the up-front context. */
  skipSemantic?: boolean;
}

export interface RunLoopResult {
  status: "completed" | "blocked" | "failed" | "interrupted" | "paused" | "cancelled";
  finalText: string;
  error?: string;
}

function convertToLlm(messages: AgentMessage[]): Message[] {
  return messages.filter(
    (m): m is Message =>
      m.role === "system" || m.role === "user" || m.role === "assistant" || m.role === "toolResult",
  );
}


/** Never ask a provider for the model's full (possibly 384k) output ceiling. */
const MAX_REQUESTED_OUTPUT_TOKENS = 32_000;
/** Cap on the input/output text recorded per call in the event log. */
const MODEL_IO_CAP = 24_000;

/** Human-readable rendering of the exact messages sent to the model. */
function renderModelInput(messages: readonly Message[]): string {
  type Block = {
    type: string;
    text?: string;
    thinking?: string;
    name?: string;
    arguments?: unknown;
    mimeType?: string;
    toolName?: string;
    content?: Array<{ type: string; text?: string; mimeType?: string }>;
  };
  const out: string[] = [];
  for (const message of messages) {
    const content = (message as unknown as { content: string | Block[] }).content;
    const parts: string[] = [];
    if (typeof content === "string") {
      parts.push(content);
    } else if (Array.isArray(content)) {
      for (const block of content) {
        if (block.type === "text") parts.push(block.text ?? "");
        else if (block.type === "thinking") parts.push(`[thinking] ${block.thinking ?? ""}`);
        else if (block.type === "toolCall") parts.push(`[tool call ${block.name ?? "?"}] ${JSON.stringify(block.arguments ?? {})}`);
        else if (block.type === "image") parts.push(`[image ${block.mimeType ?? "?"}]`);
        else if (block.type === "toolResult") {
          const body = (block.content ?? []).map((item) => (item.type === "text" ? item.text ?? "" : `[image ${item.mimeType ?? "?"}]`)).join("\n");
          parts.push(`[tool result ${block.toolName ?? "?"}]\n${body}`);
        }
      }
    }
    out.push(`--- ${message.role} ---\n${parts.join("\n")}`);
  }
  return out.join("\n\n");
}

function assistantError(model: Model<Api>, errorMessage: string): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "error",
    errorMessage,
    timestamp: Date.now(),
  };
}

function assistantText(message: AssistantMessage | undefined): string {
  if (!message) return "";
  return message.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("\n");
}

interface IssueEventEvidence {
  created: number[];
  planned: number[];
}

function readIssueEvidence(dir: string): IssueEventEvidence {
  const created = new Set<number>();
  const planned = new Set<number>();
  try {
    for (const line of readFileSync(join(dir, "events.jsonl"), "utf8").split("\n")) {
      if (!line.trim()) continue;
      let event: { type?: string; number?: unknown; issue?: unknown; status?: unknown };
      try {
        event = JSON.parse(line) as { type?: string; number?: unknown; issue?: unknown; status?: unknown };
      } catch {
        continue;
      }
      if (event.type === "issue_created" && typeof event.number === "number") created.add(event.number);
      if (event.type === "plan_updated" && typeof event.issue === "number" && event.status === "ready") {
        planned.add(event.issue);
      }
    }
  } catch {
    // no event log yet
  }
  return {
    created: [...created].sort((a, b) => a - b),
    planned: [...planned].sort((a, b) => a - b),
  };
}

function issueEvidenceText(evidence: IssueEventEvidence): string {
  if (evidence.created.length === 0 && evidence.planned.length === 0) return "";
  const list = (values: number[]): string => values.map((number) => `#${number}`).join(", ");
  return `Issue evidence: created ${evidence.created.length > 0 ? list(evidence.created) : "none"}; plan-ready ${evidence.planned.length > 0 ? list(evidence.planned) : "none"}.`;
}

/** Keep a normal final answer honest when the model contradicts issue events. */
function appendIssueEvidence(text: string, evidence: IssueEventEvidence): string {
  if (!text.trim() || evidence.created.length === 0) return text;
  const created = evidence.created.map((number) => `#${number}`);
  const contradiction = /no (?:new )?issues? (?:were )?created/i.test(text);
  const missing = evidence.created.filter((number) => !new RegExp(`#${number}\\b`).test(text));
  if (!contradiction && missing.length === 0) return text;
  return `${text.trimEnd()}\n\nIssues created: ${created.join(", ")}.`;
}

export async function runLoop(input: RunLoopInput): Promise<RunLoopResult> {
  const { recorder } = input;
  const policy = input.policy;
  const maxTurns =
    policy.maxTurns === undefined ? MAX_TURNS : Math.max(0, Math.floor(policy.maxTurns));
  const ceiling = effectiveOutputCeiling(policy, input.machine);
  const configuredProviders = input.configuredProviders;
  const fundedProviders = fundedProviderIds(input.machine.providers);
  // Callers normally load this, but a direct run must still respect persisted
  // cooldowns. Loading here also keeps the in-memory state current.
  const availability = input.availability ?? loadAvailability(input.home);
  const triedModels = new Set<string>();
  /** A build run that cannot plan gets one plan-only model call, then a fresh attempt. */
  let planRecovered = false;
  let recoveryPlan = "";

  const applyErrorState = (
    provider: string,
    modelKey: string,
    classified: ReturnType<typeof classifyError>,
  ): void => {
    const state = loadAvailability(input.home);
    if (classified.kind === "free-limit") {
      const freeKeys = input.catalogue
        .filter((row) => row.providerID === provider && isFreeRow(row))
        .map((row) => row.key);
      applyClassification(state, provider, modelKey, classified, { freeKeys });
    } else {
      applyClassification(state, provider, modelKey, classified);
    }
    saveAvailability(input.home, state);
    Object.assign(availability, state);
  };

  const selectFor = (chars: number) =>
    pick({
      agent: input.agent.name,
      policy,
      machine: input.machine,
      catalogue:
        triedModels.size === 0
          ? input.catalogue
          : input.catalogue.filter((row) => !triedModels.has(row.key)),
      configuredProviders,
      availability,
      fundedProviders,
      contextChars: chars,
      requireProvider: input.requireProvider,
      requireModel: input.requireModel,
    });

  const mapRoot = input.toolRoot ?? input.root;
  /** A cheap file version for the loop detector; contents are not hashed. */
  const fileVersion = (path: string): string | undefined => {
    try {
      const stat = statSync(join(mapRoot, path));
      return `${stat.mtimeMs}:${stat.size}`;
    } catch {
      return undefined;
    }
  };
  const processes = new ProcessSupervisor({
    runId: recorder.id,
    runDir: recorder.dir,
    onEvent: (type, data) => recorder.event(type, data),
  });
  const wantMap = input.skipMap !== true;
  const wantSemantic = input.skipSemantic !== true;
  let mapIndex = "";
  let mapFiles: MapFile[] = [];
  let semanticMap: SemanticMap | null = null;
  const renderIndex = (map: Awaited<ReturnType<typeof buildRepoMap>>["map"], semantic: SemanticMap | null): string =>
    [
      wantMap ? renderMapIndex(map) : "",
      wantSemantic ? renderSemanticIndex(semantic, 3_072, input.request) : "",
    ].filter(Boolean).join("\n");
  if (wantMap || wantSemantic) try {
    const built = await buildRepoMap(mapRoot, { processes });
    mapFiles = built.map.files;
    const dirty = wantSemantic ? readSemanticDirty(mapRoot) : [];
    const deterministic = wantSemantic ? buildModuleIndex(built.map) : null;
    const cached = wantSemantic ? loadSemantic(mapRoot) : null;
    const cachedFresh = cached && isSemanticFresh(cached, built.map, dirty) ? cached : null;
    // Persist the deterministic index immediately when there is no fresh
    // annotation overlay. The TUI and `search semantic` then see a current
    // semantic map even when LLM annotations are disabled or pending.
    if (wantSemantic && deterministic && !cachedFresh) {
      try {
        saveSemanticMap(mapRoot, deterministic);
      } catch {
        // A cache write failure must not block the run.
      }
    }
    semanticMap = deterministic ? mergeModuleIndex(deterministic, cachedFresh) : null;
    const fresh = Boolean(cachedFresh);
    mapIndex = renderIndex(built.map, semanticMap);
    recorder.event("map_built", {
      files: built.map.files.length,
      symbols: symbolCount(built.map),
      bytes: mapBytes(built.map),
      cached: built.cached,
      head: built.map.head,
      semantic: wantSemantic,
      semanticMode: fresh ? "annotated" : "deterministic",
      semanticDirty: dirty.length,
    });
    // Do not block the first prompt on a semantic refresh. Use the
    // deterministic index immediately. LLM annotations are opt-in: only
    // refresh them when a semantic model is pinned or refresh is "always".
    const annotationsEnabled =
      Boolean(input.machine.map.semanticModel) || input.machine.map.refresh === "always";
    if (wantSemantic && !fresh && annotationsEnabled) {
      recorder.event("map_refresh_scheduled", { turn: 0, reason: cached ? "stale" : "missing" });
      void ensureSemanticMap({
        root: mapRoot,
        map: built.map,
        models: input.models,
        catalogue: input.catalogue,
        configuredProviders,
        fundedProviders,
        policy,
        machine: input.machine,
        availability,
        home: input.home,
        runId: recorder.id,
        recorder,
        signal: input.signal,
      }).then((refreshed) => {
        if (!refreshed) return;
        semanticMap = deterministic ? mergeModuleIndex(deterministic, refreshed) : refreshed;
        mapIndex = renderIndex(built.map, semanticMap);
        recorder.event("map_refresh", {
          turn: 0,
          ok: true,
          background: true,
          modules: Object.keys(semanticMap?.modules ?? {}).length,
        });
      }).catch((error) => {
        recorder.event("map_refresh", {
          turn: 0,
          ok: false,
          background: true,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }
  } catch (error) {
    recorder.event("map_built", {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  const memory = new RunStateStore({
    runDir: recorder.dir,
    runId: recorder.id,
    goal: input.request,
    repoRoot: mapRoot,
    recorder,
    processes,
  });
  // Task builds start with the files the task names, plus their inferred
  // tests. This is working-set content, not an extra prompt block: it stays
  // current after edits and is capped at render time.
  if (input.agent.name === "build" || input.agent.name === "sudo") {
    // Only the bound task/packet names the work. Knowledge and plan blocks can
    // mention unrelated files, so do not mine the whole assembled context.
    const taskBlock =
      /<context-block kind="(?:task|packet)"[^>]*>[\s\S]*?<\/context-block>/.exec(input.contextText ?? "")?.[0] ??
      "";
    const preload = inferPreloadFiles(mapRoot, `${input.request}\n${taskBlock}`, 6);
    if (preload.length > 0) {
      memory.seedWorkingFiles(preload, 0);
      recorder.event("context_preloaded", { files: preload });
    }
  }
  // Semantic refresh after a changed turn. Coalesce so a burst of edits
  // produces at most one in-flight refresh plus one follow-up.
  let semanticRefreshInFlight = false;
  let semanticRefreshQueued = false;
  const runSemanticRefresh = async (turn: number): Promise<void> => {
    if (input.skipSemantic) return;
    const built = await buildRepoMap(mapRoot, { processes });
    const deterministic = buildModuleIndex(built.map);
    const semantic = await ensureSemanticMap({
      root: mapRoot,
      map: built.map,
      models: input.models,
      catalogue: input.catalogue,
      configuredProviders,
      fundedProviders,
      policy,
      machine: input.machine,
      availability,
      home: input.home,
      runId: recorder.id,
      recorder,
      signal: input.signal,
    });
    semanticMap = mergeModuleIndex(deterministic, semantic);
    mapIndex = renderIndex(built.map, semanticMap);
    recorder.event("map_refresh", {
      turn,
      ok: true,
      modules: Object.keys(semanticMap.modules).length,
    });
  };
  const scheduleSemanticRefresh = (turn: number): void => {
    if (!input.machine.map.enabled || !input.machine.map.semantic || input.machine.map.refresh === "manual") return;
    if (!input.machine.map.semanticModel && input.machine.map.refresh !== "always") return;
    if (semanticRefreshInFlight) {
      semanticRefreshQueued = true;
      return;
    }
    semanticRefreshInFlight = true;
    recorder.event("map_refresh_scheduled", { turn });
    void (async () => {
      try {
        await runSemanticRefresh(turn);
      } catch (error) {
        recorder.event("map_refresh", {
          turn,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
      } finally {
        semanticRefreshInFlight = false;
        if (semanticRefreshQueued) {
          semanticRefreshQueued = false;
          scheduleSemanticRefresh(turn);
        }
      }
    })();
  };

  // Task pack: the task-specific half of the prompt. The always-on overview
  // (packet, knowledge, map, semantic index) runs above it. The pack is built
  // from the task and plan, then fitted to the selected model's window.
  const packAgent =
    input.agent.name === "build" ||
    input.agent.name === "sudo" ||
    input.agent.name === "review" ||
    input.agent.name === "planner";
  const taskBlock =
    /<context-block kind="(?:task|packet)"[^>]*>[\s\S]*?<\/context-block>/.exec(input.contextText ?? "")?.[0] ??
    "";
  const planText = (): string =>
    memory
      .getState()
      .facts.filter((fact) => fact.kind === "decision" && fact.status === "active")
      .map((fact) => fact.text)
      .join("\n");
  const wantsPack = packAgent && mapFiles.length > 0;
  const buildPack = (): ContextPack =>
    buildTaskPack({
      root: mapRoot,
      ...(input.layout ? { layout: input.layout } : {}),
      request: input.request,
      taskText: taskBlock,
      planText: planText(),
      mapFiles,
      commands: input.commands,
      budgetChars: 400_000,
      maxFiles: 18,
    });
  let taskPack: ContextPack | null = wantsPack ? buildPack() : null;
  let packDirty = false;
  let lastPackChars = 0;
  let lastPackOmitted = 0;
  let lastLedgerChars = 0;
  let lastBudget: ContextBudget | null = null;
  if (taskPack) {
    recorder.event("context_pack", {
      files: taskPack.files.length,
      items: taskPack.items.length,
      chars: taskPack.chars,
      tokens: taskPack.tokens,
      refs: taskPack.items.map((item) => ({ kind: item.kind, ref: item.ref, chars: item.chars })),
    });
  }

  const initialChars =
    input.agent.prompt.length +
    input.request.length +
    (input.contextText?.length ?? 0) +
    mapIndex.length +
    (taskPack ? Math.min(taskPack.chars, 80_000) : memory.renderWorkingContext().length) +
    memory.renderBlock().length +
    4_000 +
    toolSchemaChars(input.agent.tools) +
    2_000;

  const zeroUsage: Usage = {
    input: 0, output: 0, cacheRead: 0, cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };

  let lastFailure: string | undefined;
  let lastAssistant: AssistantMessage | undefined;
  let totalTokens = 0;
  /** Run-level loop detector; a model rotation does not erase evidence. */
  const evidence = new EvidenceTracker(20);
  let turns = 0;
  /** Cumulative turns across resumes, for the run summary. */
  let reportedTurns = recorder.current.turns;
  let budgetExhausted = false;
  let currentRow: CatalogueRow | null = null;
  let agent: Agent | undefined;
  /** Prompt chars for the request being prepared; used for context accounting. */
  let lastRequestChars = initialChars;
  let lastPromptChars = 0;
  /** Rendered prompt for the request being prepared, consumed by transformContext. */
  let pendingMessages: AgentMessage[] | null = null;

  /**
   * When the run hits a cap or loop guard, make one tool-free call so the user
   * still gets an answer from the evidence in run state instead of only a
   * blocked summary.
   */
  const finalAnswer = async (
    model: Model<Api>,
    reason: string,
    maxTokens = 1_200,
    systemPrompt = "You summarize a coding run that stopped early. Be concise and factual. Do not call tools.",
  ): Promise<string> => {
    const prompt = [
      memory.renderBlock(),
      issueEvidenceText(readIssueEvidence(recorder.dir)),
      reason,
      "Do not call tools. Answer the user's request from the evidence above. If the evidence is insufficient, say exactly what is missing.",
      "Keep the answer under 20 lines. For a planning run, list the created issue numbers and the next concrete step; do not restate issue bodies.",
      `Request: ${input.request}`,
    ].filter(Boolean).join("\n\n");
    try {
      const source = input.models.streamSimple(
        model,
        {
          systemPrompt,
          messages: [{ role: "user", content: prompt, timestamp: Date.now() }],
        },
        {
          maxTokens,
          reasoning: "minimal",
          sessionId: recorder.id,
          signal: input.signal,
          identity: {
            userAgent: { custom: "machine_code/0.0.0" },
            attribution: { name: "machine_code", url: "https://github.com/extropian/machine-code" },
          },
        },
      );
      let text = "";
      let thinking = "";
      for await (const event of source) {
        if (event.type === "text_delta") text += event.delta;
        else if (event.type === "thinking_delta") thinking += event.delta;
      }
      const result = await source.result();
      const usage = result.usage;
      if (usage) {
        const actual = usage.cost?.total;
        const actualCost = typeof actual === "number" && Number.isFinite(actual) ? actual : null;
        recorder.recordCall(
          {
            input: usage.input,
            output: usage.output,
            cacheRead: usage.cacheRead,
            cacheWrite: usage.cacheWrite,
            totalTokens: usage.totalTokens,
          },
          actualCost,
          0,
        );
        try {
          const { appendSpendRecord } = await import("./spend.js");
          appendSpendRecord(input.home, {
            id: crypto.randomUUID(),
            t: new Date().toISOString(),
            repoRoot: input.root,
            runId: recorder.id,
            agent: input.agent.name,
            provider: result.provider,
            model: result.model,
            usage: {
              input: usage.input,
              output: usage.output,
              cacheRead: usage.cacheRead,
              cacheWrite: usage.cacheWrite,
              totalTokens: usage.totalTokens,
            },
            cost: { actual: actualCost, estimated: 0 },
            stopReason: result.stopReason,
          });
        } catch {
          // ledger write failure must not break the final answer
        }
      }
      const final = text.trim() || assistantText(result).trim();
      recorder.event("final_answer", {
        reason,
        chars: final.length,
        thinkingChars: thinking.trim().length,
        stopReason: result.stopReason,
        ...(result.errorMessage ? { error: result.errorMessage } : {}),
        ...(thinking.trim() ? { thinking: thinking.slice(0, 2_000) } : {}),
        ...(final ? { text: final.slice(0, 2_000) } : {}),
      });
      return final;
    } catch (error) {
      recorder.event("final_answer", {
        reason,
        error: error instanceof Error ? error.message : String(error),
      });
      return "";
    }
  };

  // Instance registration + heartbeat + control-file polling (M3).
  const { registerInstance, heartbeatInstance, unregisterInstance } = await import("./state/instances.js");
  registerInstance(input.home, input.root);
  const heartbeatTimer = setInterval(() => heartbeatInstance(input.home), 5_000);
  let lastControlSeq = 0;
  let pauseRequested = false;
  let cancelRequested = false;
  const controlTimer = setInterval(() => {
    const controlFile = join(recorder.dir, "control");
    try {
      if (!existsSync(controlFile)) return;
      const req = JSON.parse(readFileSync(controlFile, "utf8")) as { seq?: number; action?: string };
      if (typeof req.seq !== "number" || req.seq <= lastControlSeq) return;
      lastControlSeq = req.seq;
      recorder.event("control", { action: req.action, seq: req.seq });
      if (req.action === "interrupt") {
        agent?.abort();
      } else if (req.action === "cancel") {
        cancelRequested = true;
        agent?.abort();
      } else if (req.action === "pause") {
        pauseRequested = true;
        recorder.setStatus("paused", "pause_requested");
        agent?.abort();
      }
      const ackFile = join(recorder.dir, "control.ack");
      writeFileSync(ackFile, JSON.stringify({ seq: req.seq, acked: true, at: new Date().toISOString() }) + "\n", "utf8");
    } catch {
      // ignore control-file parse errors
    }
  }, 500);

  while (true) {
    // Reset per-attempt state. Turn and token budgets are per run, not per
    // provider attempt: a rate-limit rotation must not refill them.
    lastAssistant = undefined;
    budgetExhausted = false;
    let appliedError: { key: string; message: string } | undefined;
    let turnCapHit = false;
    let loopBlocked = false;
    let loopBlockedReason: "repeat" | "plan-required" | "loop" | undefined;
    let researchCalls = 0;
    let planBlocked = 0;
    let planBlockedTurn = -1;
    /** Tool contract health: enough failures with no work is not "completed". */
    let toolErrors = 0;
    let substantiveSuccesses = 0;
    /** Tool calls whose raw arguments leaked XML attribute syntax. */
    const serializedArgCalls = new Set<string>();
    /** Successful tool call ids, to distinguish repaired args from a dead end. */
    const successfulToolCalls = new Set<string>();
    /** Successful read-only command results for the current file state. */
    const commandCache = new Map<string, { epoch: number; turn: number; text: string; preview: string }>();
    let changeEpoch = 0;

    // First selection up front.
    const first = selectFor(initialChars);
    if ("error" in first) {
      const error =
        triedModels.size > 0
          ? `all eligible models failed (${triedModels.size} tried); last error: ${lastFailure ?? first.error}`
          : first.error;
      recorder.event("model_select", { error, rejected: first.rejected });
      recorder.event("retry_exhausted", { tried: [...triedModels], lastError: lastFailure });
      clearInterval(heartbeatTimer); clearInterval(controlTimer); unregisterInstance(input.home);
      return { status: "failed", finalText: "", error };
    }
    currentRow = first.selected;
    const firstModel = input.models.getModel(currentRow.providerID, currentRow.id);
    if (!firstModel) {
      const error = `catalogue row ${currentRow.key} is not in the provider's runtime catalog; run: machine_code catalogue refresh`;
      recorder.event("model_select", { call: 0, error });
      triedModels.add(currentRow.key);
      lastFailure = error;
      recorder.event("retry", {
        failedModel: currentRow.key,
        kind: "missing-runtime-model",
        attempt: triedModels.size,
      });
      continue;
    }
    let currentModel = firstModel;
    let callIndex = 0;
    recorder.event("model_select", {
      call: callIndex,
      key: currentRow.key,
      estimate: first.estimate,
      candidates: first.candidates,
      rejectedCount: first.rejectedCount,
    });

    // The ask tool needs a suspension hook that checkpoints the transcript
    // while the pending ask tool call is the transcript tail.
    const { saveTranscript } = await import("./state/transcript.js");
    const checkpoint = (): void => {
      try {
        saveTranscript(recorder.dir, {
          agent: input.agent.name,
          request: input.request,
          messages: agent?.state.messages ?? [],
        });
      } catch {
        // checkpoint failure must not break the run
      }
    };
    const askContext = {
      runDir: recorder.dir,
      recorder,
      suspend: checkpoint,
    };
    // Issue tool: constructed lazily per attempt (provider calls are cheap and
    // cached by the factory's gh availability check).
    let issueContext: import("./tools/issues.js").IssueToolContext | undefined;
    if (input.layout && input.agent.tools.includes("issue")) {
      const { createIssueProvider } = await import("./issues/index.js");
      const bundle = await createIssueProvider(input.layout, input.machine);
      issueContext = {
        provider: bundle.provider,
        repo: bundle.repo,
        capabilities: input.agentCapabilities ?? [],
        recorder,
        layout: input.layout,
        state: memory,
        defaultApproval: input.agentConfig?.approval ?? "human",
      };
    }

    const artifactContext: import("./tools/artifact.js").ArtifactToolContext | undefined =
      input.layout && input.agent.tools.includes("artifact")
        ? {
            layout: input.layout,
            capabilities: input.agentCapabilities ?? [],
            recorder,
            allowScripts: input.agentConfig?.artifactScripts === true,
          }
        : undefined;

    // PR tool: read/create/merge are capability- and approval-gated.
    let prContext: import("./tools/pr.js").PrToolContext | undefined;
    if (input.layout && input.agent.tools.includes("pr")) {
      const { createPrProviderFor } = await import("./pr/factory.js");
      const bundle = await createPrProviderFor(input.layout);
      prContext = {
        provider: bundle.provider,
        capabilities: input.agentCapabilities ?? [],
        recorder,
        defaultApproval: input.agentConfig?.approval ?? "human",
      };
    }

    const rawTools = coreTools(
      {
        root: input.toolRoot ?? input.root,
        commands: input.commands,
        tools: input.agent.tools,
        ask: askContext,
        issues: issueContext,
        artifacts: artifactContext,
        prs: prContext,
        state: memory,
        semantic: () => semanticMap,
        processes,
      },
      input.agent.tools,
    );
    // One safety net: an exact repeat with the same arguments is a loop.
    // Everything else is left to the model and the prompt. The old
    // no-progress, next-action, read-path, and search-scope guards blocked
    // productive orientation, so they are gone.
    const tools: AgentTool[] = rawTools.map((tool) => {
      const execute = tool.execute.bind(tool);
      const prepare = tool.prepareArguments?.bind(tool);
      return {
        ...tool,
        prepareArguments(args: unknown) {
          // Repair one provider-specific serialization bug before schema
          // validation. A successfully repaired call still must satisfy the
          // real schema.
          const repaired = repairToolArguments(args, tool.parameters);
          if (repaired !== args) recorder.event("tool_args_repaired", { tool: tool.name });
          return prepare ? prepare(repaired) : repaired;
        },
        async execute(id, params, signal, onUpdate) {
          const planBlock = (message: string, detail: Record<string, unknown>) => {
            const turn = memory.currentTurn();
            if (turn !== planBlockedTurn) {
              planBlockedTurn = turn;
              planBlocked += 1;
            }
            if (planBlocked >= PLAN_BLOCK_LIMIT) {
              if (!loopBlocked) {
                loopBlocked = true;
                loopBlockedReason = "plan-required";
                recorder.event("loop_blocked", { tool: tool.name, reason: "plan-required", ...detail });
              }
              return {
                content: [{ type: "text" as const, text: message }],
                details: undefined,
                isError: true,
                terminate: true,
              };
            }
            return {
              content: [{ type: "text" as const, text: message }],
              details: undefined,
              isError: true,
            };
          };

          const killLoop = (evidenceKey: string | null, stale: number) => {
            if (!loopBlocked) {
              loopBlocked = true;
              loopBlockedReason = "loop";
              recorder.event("loop_blocked", {
                tool: tool.name,
                reason: "loop",
                stale,
                key: evidenceKey,
              });
            }
            return {
              content: [{
                type: "text" as const,
                text:
                  "Loop detected: recent actions produced no new evidence. " +
                  "Stop. Report the result and what is blocked.",
              }],
              details: undefined,
              isError: true,
              terminate: true,
            };
          };

          const issueAction =
            tool.name === "issue" ? String((params as { action?: unknown }).action ?? "") : "";
          const contextAction =
            tool.name === "context" ? String((params as { action?: unknown }).action ?? "") : "";
          const contextKind =
            tool.name === "context" ? String((params as { kind?: unknown }).kind ?? "finding") : "";
          const planNote = tool.name === "context" && contextAction === "note" && contextKind === "decision";
          // Memory operations (context note/focus/recall/state) are not new
          // research. Counting them made the plan gate fire sooner and blocked
          // cheap rehydration exactly when the model needed it.
          const researchTool =
            tool.name === "read" ||
            tool.name === "search" ||
            (tool.name === "issue" && ["list", "view", "tree"].includes(issueAction));
          if (researchTool) researchCalls += 1;
          const needsPlan = needsBuildPlan(input.agent.name);
          const planReady = needsPlan && hasPlanDecision(memory.getState().facts);
          const readPath = tool.name === "read" ? String((params as { path?: unknown }).path ?? "") : "";
          const blocksAfterPlan =
            tool.name === "search" ||
            tool.name === "read" ||
            (tool.name === "issue" && ["list", "view", "tree"].includes(issueAction));
          const postPlanResearchLimit = BUILD_PLAN_RESEARCH_LIMIT + BUILD_PLAN_POST_RESEARCH_LIMIT;
          const hasChanges = memory.getState().facts.some(
            (fact) => fact.kind === "change" && fact.status === "active",
          );
          const nextNote = tool.name === "context" && contextAction === "note" && contextKind === "next";
          const nextText = nextNote ? String((params as { text?: unknown }).text ?? "").trim() : "";
          if (
            needsPlan &&
            planReady &&
            !hasChanges &&
            nextNote &&
            /^(?:read|search|explore|inspect|find|look|verify|check|review|map|outline)\b/i.test(nextText)
          ) {
            return {
              content: [{
                type: "text" as const,
                text:
                  "Plan is recorded. Next must be an edit or needs_planning. " +
                  'Example: {"action":"note","kind":"next","text":"Edit src/tui.ts to remove the orchestrator tab."}',
              }],
              details: undefined,
              isError: true,
            };
          }
          if (
            needsPlan &&
            researchTool &&
            !planNote &&
            researchCalls >= BUILD_PLAN_RESEARCH_LIMIT &&
            !planReady
          ) {
            return planBlock(
              `Plan checkpoint: ${researchCalls} research calls without a concrete change plan. ` +
                `Call context now: {"action":"note","kind":"decision","text":"1) Edit src/file.ts to ... 2) Edit src/file.ts to ... 3) Add test/file.ts ..."}. ` +
                `Then make the first edit.`,
              { args: capJson(params), researchCalls },
            );
          }
          if (
            needsPlan &&
            planReady &&
            !hasChanges &&
            blocksAfterPlan &&
            researchCalls >= postPlanResearchLimit
          ) {
            return planBlock(
              `Plan recorded; ${researchCalls - BUILD_PLAN_RESEARCH_LIMIT} extra research calls used. ` +
                "Make the first edit now with edit or write, or record a revised plan with context note.",
              { args: capJson(params), plan: true, researchCalls },
            );
          }

          // Evidence keys for the loop detector. A read is one 100-line band
          // (or one symbol/section) at a file version; a search is one scope
          // with one result set. Repeated evidence is stale even if the model
          // changes the offset or paraphrases the pattern.
          const searchMode =
            tool.name === "search" ? String((params as { mode?: unknown }).mode ?? "text") : "";
          const searchPaths = tool.name === "search" && Array.isArray((params as { paths?: unknown }).paths)
            ? ((params as { paths?: unknown }).paths as unknown[]).filter(
                (item): item is string => typeof item === "string",
              )
            : [];
          const searchScope =
            tool.name === "search" && searchMode === "text"
              ? searchPaths.length > 0
                ? searchPaths.slice().sort().join(",")
                : String((params as { path?: unknown }).path ?? ".")
              : "";
          const keyParams =
            tool.name === "issue"
              ? normalizedIssueKey(params as Record<string, unknown>)
              : params;
          const key = `${tool.name}:${stableKey(keyParams)}`;
          const commandAction =
            tool.name === "command" ? String((params as { action?: unknown }).action ?? "") : "";
          const commandName =
            tool.name === "command" ? String((params as { name?: unknown }).name ?? "") : "";
          const cacheableCommand =
            commandAction === "run" &&
            commandName.length > 0 &&
            input.commands.get(commandName)?.readonly === true;
          const cached = cacheableCommand ? commandCache.get(key) : undefined;
          if (cached && cached.epoch === changeEpoch) {
            const check = evidence.observe(`command:${commandName}:cached`, false);
            if (check.loop) return killLoop(`command:${commandName}:cached`, check.stale);
            return {
              content: [{
                type: "text" as const,
                text:
                  `[cached ${commandName} from turn ${cached.turn}; no files changed since]\n` +
                  cached.text,
              }],
              details: undefined,
            };
          }
          const result = await execute(id, params, signal, onUpdate);
          if (needsPlan && planNote && !result.isError && hasPlanDecision(memory.getState().facts)) {
            // The plan is the next action. Do not let the old "explore" next
            // note survive and steer the model back into reading. Only Build
            // has an edit contract; a Planner or Sudo run must not inherit it.
            memory.note("next", "Execute the plan: make the first edit.", [], memory.currentTurn());
            packDirty = true;
          }
          if (!result.isError && (tool.name === "edit" || tool.name === "write")) {
            changeEpoch += 1;
            commandCache.clear();
            packDirty = true;
          }
          if (!result.isError && tool.name === "command" && commandAction === "run" && !cacheableCommand) {
            // A mutating command can change files without an edit/write call.
            changeEpoch += 1;
            commandCache.clear();
            packDirty = true;
          }
          const preview = result.content
            .filter((item): item is { type: "text"; text: string } => item.type === "text")
            .map((item) => item.text)
            .join("\n")
            .replace(/\s+/g, " ")
            .slice(0, 300);
          if (!result.isError && cacheableCommand) {
            const text = result.content
              .filter((item): item is { type: "text"; text: string } => item.type === "text")
              .map((item) => item.text)
              .join("\n");
            commandCache.set(key, {
              epoch: changeEpoch,
              turn: memory.currentTurn(),
              text,
              preview,
            });
          }
          // Evidence novelty: repeated reads of one band at the same file
          // version, repeated search result sets, and repeated command output
          // are not new information. A mutation resets the stale streak.
          if (!result.isError) {
            const resultText = result.content
              .filter((item): item is { type: "text"; text: string } => item.type === "text")
              .map((item) => item.text)
              .join("\n");
            const resultHash = createHash("sha1").update(resultText).digest("hex").slice(0, 16);
            const isProgress =
              tool.name === "edit" ||
              tool.name === "write" ||
              (tool.name === "command" && commandAction === "run" && !cacheableCommand);
            let evidenceKey: string | null = null;
            if (tool.name === "read" && readPath) {
              evidenceKey = `read:${readBucket(params as Record<string, unknown>)}:${fileVersion(readPath) ?? resultHash}`;
            } else if (tool.name === "search" && searchScope) {
              evidenceKey = `search:${searchScope}:${searchMode}:${resultHash}`;
            } else if (tool.name === "command" && commandAction === "run") {
              evidenceKey = cacheableCommand
                ? `command:${commandName}:cached`
                : `command:${commandName}:${resultHash}`;
            } else if (tool.name === "issue") {
              evidenceKey = `issue:${issueAction}:${resultHash}`;
            } else if (tool.name === "context" && contextAction === "recall") {
              evidenceKey = `recall:${resultHash}`;
            }
            const check = evidence.observe(evidenceKey, isProgress);
            if (check.loop) return killLoop(evidenceKey, check.stale);
          }
          return result;
        },
      } as AgentTool;
    });
    const toolChars = toolDefinitionChars(tools);
    recorder.event("tools_registered", {
      names: tools.map((tool) => tool.name),
      constrained: tools.filter((tool) => tool.constrainedSampling).map((tool) => tool.name),
    });

    agent = new Agent({
      initialState: {
        model: currentModel,
        thinkingLevel: "low",
        systemPrompt: input.agent.prompt,
        tools,
        ...(input.initialMessages && input.initialMessages.length > 0 ? { messages: input.initialMessages } : {}),
      },
      sessionId: recorder.id,
      convertToLlm,
      streamFn: (model, context, options) => {
        const call = callIndex;
        const firstTokenTimeoutMs =
          input.machine.selection?.firstTokenTimeoutMs ?? DEFAULT_FIRST_TOKEN_TIMEOUT_MS;
        const requestText = renderModelInput((context as Context).messages);
        recorder.event("model_request", {
          call,
          provider: model.provider,
          model: model.id,
          messages: (context as Context).messages.length,
          chars: requestText.length,
          input:
            requestText.length > MODEL_IO_CAP
              ? requestText.slice(0, MODEL_IO_CAP) + "\n…[truncated]"
              : requestText,
        });

        // Abort the request if the provider produces nothing for too long. The
        // synthetic error below is classified as retryable, so the loop cools
        // this model and re-picks another one.
        const abort = new AbortController();
        const outerSignal = options?.signal;
        const onOuterAbort = () => abort.abort();
        if (outerSignal) {
          if (outerSignal.aborted) abort.abort();
          else outerSignal.addEventListener("abort", onOuterAbort, { once: true });
        }

        const maxTokens =
          ceiling === undefined
            ? Math.min(model.maxTokens > 0 ? model.maxTokens : MAX_REQUESTED_OUTPUT_TOKENS, MAX_REQUESTED_OUTPUT_TOKENS)
            : Math.min(ceiling, model.maxTokens > 0 ? model.maxTokens : ceiling);

        const source = input.models.stream(model, context as Context, {
          ...options,
          signal: abort.signal,
          maxTokens,
          identity: {
            userAgent: { custom: "machine_code/0.0.0" },
            attribution: { name: "machine_code", url: "https://github.com/extropian/machine-code" },
          },
        });
        // Mirror text/thinking deltas into the event log so the run detail
        // screen can show live reasoning without a second provider stream.
        const wrapped = createAssistantMessageEventStream();
        let text = "";
        let thinking = "";
        let lastFlush = Date.now();
        let settled = false;
        const flush = (): void => {
          if (text) {
            recorder.event("model_delta", { call, kind: "text", text });
            text = "";
          }
          if (thinking) {
            recorder.event("model_delta", { call, kind: "thinking", text: thinking });
            thinking = "";
          }
          lastFlush = Date.now();
        };
        const finish = (message: AssistantMessage): void => {
          if (settled) return;
          settled = true;
          flush();
          wrapped.end(message);
        };
        const timer = setTimeout(() => {
          if (settled) return;
          abort.abort();
          const message = assistantError(
            model,
            `provider timeout: no stream event within ${Math.round(firstTokenTimeoutMs / 1000)}s`,
          );
          flush();
          if (!settled) {
            settled = true;
            wrapped.push({ type: "error", reason: "error", error: message } as AssistantMessageEvent);
            wrapped.end(message);
          }
          recorder.event("error_classified", {
            kind: "timeout",
            target: "model",
            retryable: true,
            disableProvider: false,
            needsAuth: false,
          });
        }, Math.max(1_000, firstTokenTimeoutMs));

        void (async () => {
          try {
            for await (const event of source) {
              if (settled) continue; // drain after a timeout so the source can close
              clearTimeout(timer);
              if (event.type === "text_delta") {
                text += event.delta;
              } else if (event.type === "thinking_delta") {
                thinking += event.delta;
              }
              if (text.length >= 160 || thinking.length >= 160 || Date.now() - lastFlush >= 250) flush();
              if (event.type === "text_end" || event.type === "thinking_end" || event.type === "done" || event.type === "error") flush();
              wrapped.push(event as AssistantMessageEvent);
            }
            const result = await source.result();
            clearTimeout(timer);
            finish(result);
          } catch {
            clearTimeout(timer);
            if (!settled) {
              settled = true;
              flush();
              wrapped.end();
            }
          } finally {
            clearTimeout(timer);
            outerSignal?.removeEventListener("abort", onOuterAbort);
          }
        })();
        return wrapped;
      },
      transformContext: async (messages) => {
        if (pendingMessages) {
          const rendered = pendingMessages;
          pendingMessages = null;
          return rendered;
        }
        return renderPromptMessages(messages, memory, mapIndex, input.contextText).messages;
      },
      prepareRequest: async ({ context }) => {
        const renderFor = (row: CatalogueRow | null) => {
          if (taskPack && packDirty) {
            taskPack = buildPack();
            packDirty = false;
          }
          const budget = row ? contextBudget(row.context, policy.expectedOutputTokens) : null;
          lastBudget = budget;
          const overhead =
            input.agent.prompt.length +
            (input.contextText?.length ?? 0) +
            mapIndex.length +
            memory.renderBlock().length +
            toolChars +
            24_000;
          const packChars = taskPack && budget ? Math.max(4_000, budget.inputChars - overhead) : 0;
          const renderedPack = taskPack
            ? renderContextPack(taskPack, { maxChars: packChars })
            : null;
          const packText = renderedPack?.text;
          lastPackChars = packText?.length ?? 0;
          lastPackOmitted = renderedPack?.omitted.length ?? 0;
          const remaining = Math.max(0, packChars - lastPackChars);
          const ledgerText = taskPack && remaining > 0
            ? memory.renderLedger({
                maxChars: Math.min(remaining, 200_000),
                excludePaths: new Set(taskPack.files),
              })
            : undefined;
          lastLedgerChars = ledgerText?.length ?? 0;
          return renderPromptMessages(
            context.messages,
            memory,
            mapIndex,
            input.contextText,
            packText,
            ledgerText,
          );
        };

        let rendered = renderFor(currentRow);
        pendingMessages = rendered.messages;
        lastPromptChars = rendered.chars;
        let chars = rendered.chars + toolChars;
        lastRequestChars = chars;
        recorder.recordContext(chars);
        const estimate = estimateTokens(chars, policy.expectedOutputTokens);
        let repickReason: "initial" | "retry" | "context" | "model-missing" | undefined =
          !currentRow
            ? "initial"
            : triedModels.has(currentRow.key)
              ? "retry"
              : currentRow.context > 0 && currentRow.context < estimate.inputTokens + estimate.outputTokens
                ? "context"
                : undefined;
        if (!repickReason && currentRow) {
          const stickyModel = input.models.getModel(currentRow.providerID, currentRow.id);
          if (stickyModel) {
            callIndex += 1;
            recorder.event("model_select", {
              call: callIndex,
              key: currentRow.key,
              estimate,
              candidates: [],
              rejectedCount: 0,
              sticky: true,
            });
            currentModel = stickyModel;
            return { model: stickyModel };
          }
          repickReason = "model-missing";
        }
        const result = selectFor(chars);
        if ("error" in result) {
          recorder.event("model_select", { call: callIndex + 1, error: result.error, rejected: result.rejected });
          return undefined;
        }
        callIndex += 1;
        currentRow = result.selected;
        const model = input.models.getModel(currentRow.providerID, currentRow.id);
        // The new model may have a different window. Re-render the pack to its
        // budget and record the actual request size.
        rendered = renderFor(currentRow);
        pendingMessages = rendered.messages;
        lastPromptChars = rendered.chars;
        chars = rendered.chars + toolChars;
        lastRequestChars = chars;
        recorder.recordContext(chars);
        recorder.event("model_select", {
          call: callIndex,
          key: currentRow.key,
          estimate: estimateTokens(chars, policy.expectedOutputTokens),
          candidates: result.candidates,
          rejectedCount: result.rejectedCount,
          ...(repickReason ? { repick: repickReason } : {}),
        });
        if (!model) return undefined;
        currentModel = model;
        return { model };
      },
      finishTurn: ({ message }) => {
        turns += 1;
        reportedTurns += 1;
        recorder.recordTurn(reportedTurns);
        const usage = message.usage ?? zeroUsage;
        totalTokens += usage.totalTokens;
        if (policy.budgetTokens !== undefined && totalTokens > policy.budgetTokens) {
          budgetExhausted = true;
          recorder.event("budget_exhausted", { totalTokens, budget: policy.budgetTokens });
          return { action: "end" as const };
        }
        if (loopBlocked) {
          return { action: "end" as const };
        }
        if (maxTurns > 0 && turns >= maxTurns) {
          // A final answer with no tool calls is a natural completion, not a cap.
          const wantsMore = message.content.some((block) => block.type === "toolCall");
          if (wantsMore) {
            turnCapHit = true;
            recorder.event("turn_cap", { turns, maxTurns });
            return { action: "end" as const };
          }
        }
        return undefined;
      },
    });

    const onExternalAbort = () => agent?.abort();
    input.signal?.addEventListener("abort", onExternalAbort, { once: true });

    agent.subscribe(async (event) => {
      switch (event.type) {
        case "turn_end": {
          const message = event.message as AssistantMessage;
          if (message.role === "assistant") {
            lastAssistant = message;
            const usage = message.usage ?? zeroUsage;
            const actual = usage.cost?.total;
            const actualContextTokens = usage.input + usage.cacheRead;
            recorder.recordContext(
              lastRequestChars,
              actualContextTokens > 0 ? actualContextTokens : undefined,
            );
            const ingested = memory.ingestTurn(
              agent?.state.messages ?? [],
              turns + 1,
              { agent: input.agent.name, model: currentRow?.key },
            );
            if (ingested.changed) scheduleSemanticRefresh(turns + 1);
            recorder.event("context_state", {
              turn: turns + 1,
              chars: lastRequestChars,
              promptChars: lastPromptChars,
              tokens: actualContextTokens > 0 ? actualContextTokens : Math.ceil(lastRequestChars / 4),
              stateChars: memory.renderBlock().length,
              packChars: lastPackChars,
              packOmitted: lastPackOmitted,
              ledgerChars: lastLedgerChars,
              ...(lastBudget
                ? {
                    contextWindow: lastBudget.contextWindowTokens,
                    inputBudgetTokens: lastBudget.inputTokens,
                    inputBudgetChars: lastBudget.inputChars,
                  }
                : {}),
            });
            // Record the assistant's text output for this turn (for the TUI).
            const turnText = message.content
              .filter((c): c is { type: "text"; text: string } => c.type === "text")
              .map((c) => c.text)
              .join("\n");
            recorder.event("model_call_end", {
              call: callIndex,
              provider: message.provider,
              model: message.model,
              stopReason: message.stopReason,
              usage: {
                input: usage.input,
                output: usage.output,
                cacheRead: usage.cacheRead,
                cacheWrite: usage.cacheWrite,
                totalTokens: usage.totalTokens,
              },
              context: {
                chars: lastRequestChars,
                tokens: actualContextTokens > 0 ? actualContextTokens : Math.ceil(lastRequestChars / 4),
              },
              cost: typeof actual === "number" && Number.isFinite(actual) ? actual : null,
              durationMs: message.durationMs ?? null,
              ...(message.errorMessage ? { error: message.errorMessage } : {}),
              ...(turnText ? { text: turnText.length > MODEL_IO_CAP ? turnText.slice(0, MODEL_IO_CAP) + "\n…[truncated]" : turnText } : {}),
            });
            const estimatedCost =
              estimateCallCost(currentRow!.pricing, usage.input, Math.max(usage.output, policy.expectedOutputTokens)) *
              providerMultiplier(input.machine, currentRow!.providerID);
            recorder.recordCall(
              {
                input: usage.input,
                output: usage.output,
                cacheRead: usage.cacheRead,
                cacheWrite: usage.cacheWrite,
                totalTokens: usage.totalTokens,
              },
              typeof actual === "number" && Number.isFinite(actual) ? actual : null,
              estimatedCost,
            );
            // Transcript checkpoint at the turn boundary: assistant message
            // plus all tool results are in state here.
            checkpoint();
            recorder.event("checkpoint", { turn: turns, messages: agent?.state.messages.length ?? 0 });
            try {
              const { appendSpendRecord } = await import("./spend.js");
              appendSpendRecord(input.home, {
                id: crypto.randomUUID(),
                t: new Date().toISOString(),
                repoRoot: input.root,
                runId: recorder.id,
                agent: input.agent.name,
                provider: message.provider,
                model: message.model,
                usage: {
                  input: usage.input,
                  output: usage.output,
                  cacheRead: usage.cacheRead,
                  cacheWrite: usage.cacheWrite,
                  totalTokens: usage.totalTokens,
                },
                cost: {
                  actual: typeof actual === "number" && Number.isFinite(actual) ? actual : null,
                  estimated: estimatedCost,
                },
                stopReason: message.stopReason,
              });
            } catch {
              // ledger write failure must not break the run
            }
            // Error classification + availability update (M2).
            if (message.stopReason === "error" && message.errorMessage) {
              try {
                const classified = classifyError(new Error(message.errorMessage));
                const provider = message.provider;
                const key = currentRow?.key ?? `${provider}/${message.model}`;
                applyErrorState(provider, key, classified);
                appliedError = { key, message: message.errorMessage };
                recorder.event("error_classified", {
                  kind: classified.kind,
                  target: classified.target,
                  retryable: classified.retryable,
                  disableProvider: classified.disableProvider,
                  needsAuth: classified.needsAuth,
                });
                // retry decision is made after the run completes
              } catch {
                // availability update failure must not break the run
              }
            }
          }
          break;
        }
        case "tool_execution_start": {
          if (looksLikeSerializedArgs(event.args)) serializedArgCalls.add(event.toolCallId);
          recorder.event("tool_call_start", {
            toolCallId: event.toolCallId,
            tool: event.toolName,
            ...(event.args !== undefined ? { args: capJson(event.args) } : {}),
          });
          break;
        }
        case "tool_execution_end": {
          if (event.isError) {
            toolErrors += 1;
          } else {
            successfulToolCalls.add(event.toolCallId);
            if (SUBSTANTIVE_TOOLS.has(event.toolName)) substantiveSuccesses += 1;
          }
          recorder.event("tool_call", {
            toolCallId: event.toolCallId,
            tool: event.toolName,
            isError: event.isError,
            durationMs: event.durationMs ?? null,
            ...(event.result !== undefined ? { result: capJson(event.result) } : {}),
          });
          break;
        }
        default:
          break;
      }
    });

    try {
      if (input.startMode === "continue") {
        // Resume: the reconstructed transcript tail is already continuable.
        await agent.continue();
      } else {
        const promptText = [
          input.contextText,
          recoveryPlan ? `Change plan:\n${recoveryPlan}\n\nExecute this plan. Make the first edit now.` : "",
          mapIndex,
          input.request,
        ].filter(Boolean).join("\n\n");
        await agent.prompt(promptText);
      }
      await agent.waitForIdle();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!cancelRequested && !pauseRequested && !input.signal?.aborted) {
        try {
          const classified = classifyError(new Error(message));
          if (classified.retryable) {
            const provider = currentRow?.providerID ?? "";
            const failedKey = currentRow?.key ?? "";
            if (provider && failedKey) {
              try {
                applyErrorState(provider, failedKey, classified);
              } catch {
                // availability write failure must not stop rotation
              }
              triedModels.add(failedKey);
            }
            lastFailure = message;
            recorder.event("retry", {
              failedModel: failedKey || "(unknown)",
              kind: classified.kind,
              attempt: triedModels.size,
            });
            continue;
          }
        } catch {
          // classification failure falls through to the ordinary error path
        }
      }
      clearInterval(heartbeatTimer); clearInterval(controlTimer); unregisterInstance(input.home);
      if (cancelRequested) return { status: "cancelled", finalText: "" };
      if (pauseRequested) return { status: "paused", finalText: "" };
      if (input.signal?.aborted) return { status: "interrupted", finalText: "" };
      return { status: "failed", finalText: "", error: message };
    } finally {
      input.signal?.removeEventListener("abort", onExternalAbort);
    }

    // Some providers (notably weak free fallbacks) return tool-call markup as
    // ordinary text. The agent sees no toolCall block and stops. Do not treat
    // that as a final answer: cool the model and rotate to another one.
    const malformed = lastAssistant as AssistantMessage | undefined;
    const malformedText = assistantText(malformed);
    const toolArgText = (malformed?.content ?? [])
      .map((block) =>
        block.type === "toolCall"
          ? JSON.stringify((block as { arguments?: unknown }).arguments ?? {})
          : "",
      )
      .filter(Boolean)
      .join("\n");
    const hasNativeToolCall = malformed?.content.some((block) => block.type === "toolCall") ?? false;
    const badArgs = toolArgText.length > 0 && hasToolCallMarkup(toolArgText);
    // A serialized-args defect that was repaired and executed is not a failed
    // response. Only an unresolved one rotates the model.
    const unrepairedSerialized = [...serializedArgCalls].some((id) => !successfulToolCalls.has(id));
    if (
      malformed &&
      malformed.stopReason !== "error" &&
      malformed.stopReason !== "aborted" &&
      (badArgs || unrepairedSerialized || (!hasNativeToolCall && hasToolCallMarkup(malformedText)))
    ) {
      const provider = currentRow?.providerID ?? malformed.provider;
      const failedKey = currentRow?.key ?? `${malformed.provider}/${malformed.model}`;
      const message = unrepairedSerialized
        ? `model ${failedKey} returned malformed tool arguments`
        : badArgs
          ? `model ${failedKey} returned provider markup inside tool arguments`
          : `model ${failedKey} returned tool-call markup as plain text`;
      triedModels.add(failedKey);
      lastFailure = message;
      try {
        const classified = classifyError(new Error(`malformed response: ${message}`));
        applyErrorState(provider, failedKey, classified);
        recorder.event("error_classified", {
          kind: classified.kind,
          target: classified.target,
          retryable: classified.retryable,
          disableProvider: classified.disableProvider,
          needsAuth: classified.needsAuth,
        });
      } catch {
        // availability update failure must not stop rotation
      }
      recorder.event("malformed_tool_call", {
        provider,
        model: failedKey,
        text: `${malformedText}\n${toolArgText}`.trim().slice(0, 1_000),
      });
      recorder.event("retry", {
        failedModel: failedKey,
        kind: "malformed",
        attempt: triedModels.size,
      });
      continue;
    }

    const la2 = lastAssistant as AssistantMessage | undefined;
    let finalText = assistantText(la2);
    if (loopBlocked && loopBlockedReason === "plan-required" && !planRecovered && currentModel) {
      planRecovered = true;
      const plan = await finalAnswer(
        currentModel,
        "Return a concrete 3-line change plan. Name exact files and edits. Do not call tools.",
        4_000,
        "You plan a code change. Return only a 3-line change plan naming exact files and edits. Do not call tools.",
      );
      const trimmed = plan.trim();
      if (trimmed) {
        memory.note("decision", trimmed, [], turns + 1);
        recoveryPlan = trimmed;
        packDirty = true;
        recorder.event("plan_recovered", { chars: trimmed.length });
        // Fresh attempt with the plan in context. Per-attempt guards reset.
        continue;
      }
    }
    const stop = la2?.stopReason;
    let status: RunLoopResult["status"] = "completed";
    let error: string | undefined;
    if (cancelRequested) {
      status = "cancelled";
    } else if (pauseRequested) {
      status = "paused";
    } else if (input.signal?.aborted) {
      status = "interrupted";
    } else if (loopBlocked) {
      status = "blocked";
      error =
        loopBlockedReason === "plan-required"
          ? "build plan required before more research"
          : loopBlockedReason === "loop"
            ? "no new evidence; loop detected"
            : "repeated identical tool calls detected";
    } else if (budgetExhausted) {
      status = "blocked";
      error = `token budget exhausted (${policy.budgetTokens})`;
    } else if (turnCapHit) {
      status = "blocked";
      error = `turn cap reached (${maxTurns}) before the run finished`;
    } else if (stop === "aborted") {
      status = "interrupted";
    } else if (stop === "error") {
      status = "failed";
      error = la2?.errorMessage ?? "provider error";
    }

    if (!finalText.trim() && currentModel && (turnCapHit || loopBlocked || budgetExhausted)) {
      const reason = turnCapHit
        ? "You have reached the turn cap."
        : loopBlocked
          ? loopBlockedReason === "plan-required"
            ? "The harness stopped the run: no concrete build plan was recorded. Return a 3-line change plan and stop."
            : loopBlockedReason === "loop"
              ? "The harness stopped the run: recent actions produced no new evidence. Return the result and the blocking evidence."
              : "The harness stopped repeated tool calls."
          : "The token budget is exhausted.";
      finalText = await finalAnswer(currentModel, reason);
    }
    finalText = appendIssueEvidence(finalText, readIssueEvidence(recorder.dir));

    // An empty stop is not a completed run. This happens when a provider
    // returns an empty assistant message after tool errors; the old loop
    // marked it `completed` with no answer.
    if (status === "completed" && !finalText.trim()) {
      status = "blocked";
      error = "model returned an empty final response";
    } else if (status === "completed" && toolErrors >= 2 && substantiveSuccesses === 0) {
      // Schema errors and memory-only reads are not work. Do not report a
      // completed outcome when every substantive call was rejected.
      status = "blocked";
      error = "tool calls were rejected; no work completed";
    }

    // Retry decision: rotate to the next eligible model on a retryable error.
    const la = lastAssistant as AssistantMessage | undefined;
    if (status === "failed" && la?.errorMessage) {
      let classified: ReturnType<typeof classifyError> | undefined;
      try {
        classified = classifyError(new Error(la.errorMessage));
      } catch {
        // classification failure falls through to the ordinary failure path
      }
      if (classified?.retryable) {
        const failedKey = currentRow?.key ?? `${la.provider}/${la.model}`;
        if (!appliedError || appliedError.key !== failedKey || appliedError.message !== la.errorMessage) {
          try {
            applyErrorState(la.provider, failedKey, classified);
          } catch {
            // availability write failure must not stop rotation
          }
        }
        const failedModel = currentRow?.key ?? failedKey;
        triedModels.add(failedModel);
        lastFailure = la.errorMessage;
        recorder.event("retry", {
          failedModel,
          kind: classified.kind,
          attempt: triedModels.size,
        });
        continue; // retry with a fresh agent; the failed/cooled model is excluded
      }
    }

    clearInterval(heartbeatTimer); clearInterval(controlTimer); unregisterInstance(input.home);
    return { status, finalText, error };
  }
}
