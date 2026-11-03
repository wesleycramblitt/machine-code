/**
 * machine_code — the local `Loop` interface: a thin wrapper over pi-agent-core.
 *
 * Selection happens per provider call in prepareRequest: estimate context
 * size, run pick(), log the selection, and hand the loop the chosen model.
 * No stickiness — every call is selected and logged independently.
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
import { pick, providerMultiplier, isFreeRow } from "./select.js";
import { applyClassification, classifyError, loadAvailability, saveAvailability } from "./availability.js";
import { fundedProviderIds } from "./data.js";
import type { CatalogueRow } from "./catalogue/types.js";
import type { AgentDef, AgentName } from "./agents.js";
import type { MutableModels } from "./models.js";
import { coreTools } from "./tools/index.js";
import { toolDefinitionChars, toolSchemaChars } from "./tools/schema.js";
import type { AgentConfig } from "./agents/config.js";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Layout } from "./paths.js";
import type { RunRecorder } from "./state/runs.js";
import { buildRepoMap, mapBytes, renderMapIndex, symbolCount } from "./map/deterministic.js";
import { ensureSemanticMap } from "./map/ensure.js";
import { isSemanticFresh, loadSemantic, readSemanticDirty, renderSemanticIndex, buildModuleIndex, mergeModuleIndex, type SemanticMap } from "./map/semantic.js";
import { RunStateStore } from "./context/state.js";
import { hasToolCallMarkup } from "./state/tool-call-text.js";
import { ProcessSupervisor } from "./processes/supervisor.js";
import { renderPromptMessages } from "./context/render.js";

/** Default turn cap. 0 means no cap; set max_turns per role or run. */
export const MAX_TURNS = 0;

/** Identical calls allowed before the harness blocks the repeat. */
const REPEAT_LIMIT = 2;
/** Blocked repeats allowed before the run terminates. */
const REPEAT_BLOCK_LIMIT = 3;
/** Reads of one path allowed before the harness forces the model to act. */
const READ_PATH_LIMIT = 3;
/** Planner research/verification calls allowed without an issue write. */
const PLANNER_NO_PROGRESS_LIMIT = 10;
/** Build/sudo research calls allowed without an edit, write, or command. */
const MUTATING_NO_PROGRESS_LIMIT = 12;

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

function repeatHint(tool: string): string {
  switch (tool) {
    case "read":
      return "Read a different range or symbol, or proceed with the result you have.";
    case "search":
      return "Use the earlier result or change the pattern or path.";
    case "issue":
      return "Use the earlier issue result or act on the graph; do not view the same issue again.";
    case "command":
      return "Use the earlier command result. issue, pr, and artifact are tools, not commands.";
    case "context":
      return "Use the earlier context result or change the action.";
    default:
      return "Use the earlier result or change the arguments.";
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
  const processes = new ProcessSupervisor({
    runId: recorder.id,
    runDir: recorder.dir,
    onEvent: (type, data) => recorder.event(type, data),
  });
  const wantMap = input.skipMap !== true;
  const wantSemantic = input.skipSemantic !== true;
  let mapIndex = "";
  let semanticMap: SemanticMap | null = null;
  const renderIndex = (map: Awaited<ReturnType<typeof buildRepoMap>>["map"], semantic: SemanticMap | null): string =>
    [
      wantMap ? renderMapIndex(map) : "",
      wantSemantic ? renderSemanticIndex(semantic, 3_072, input.request) : "",
    ].filter(Boolean).join("\n");
  if (wantMap || wantSemantic) try {
    const built = await buildRepoMap(mapRoot, { processes });
    const dirty = wantSemantic ? readSemanticDirty(mapRoot) : [];
    const deterministic = wantSemantic ? buildModuleIndex(built.map) : null;
    const cached = wantSemantic ? loadSemantic(mapRoot) : null;
    const cachedFresh = cached && isSemanticFresh(cached, built.map, dirty) ? cached : null;
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

  const initialChars =
    input.agent.prompt.length +
    input.request.length +
    mapIndex.length +
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
  const finalAnswer = async (model: Model<Api>, reason: string): Promise<string> => {
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
          systemPrompt:
            "You summarize a coding run that stopped early. Be concise and factual. Do not call tools.",
          messages: [{ role: "user", content: prompt, timestamp: Date.now() }],
        },
        {
          maxTokens: 1200,
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
    let repeatBlocked = 0;
    let repeatBlockedTurn = -1;
    const callCounts = new Map<string, { count: number; preview: string }>();
    const readPaths = new Map<string, number>();
    const searchKeys = new Map<string, number>();
    let treeCalls = 0;
    let noProgressCalls = 0;

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
    // Guard against loops: a weak model can burn the whole turn budget repeating
    // the same read/search/issue call. The first two calls run normally; later
    // identical calls return a corrective error, and repeated blocks terminate
    // the turn batch.
    const tools: AgentTool[] = rawTools.map((tool) => {
      const execute = tool.execute.bind(tool);
      return {
        ...tool,
        async execute(id, params, signal, onUpdate) {
          const block = (message: string, detail: Record<string, unknown>) => {
            // A parallel batch can block several calls in one turn. Count one
            // strike per turn so a single batch does not terminate the run.
            const turn = memory.currentTurn();
            if (turn !== repeatBlockedTurn) {
              repeatBlockedTurn = turn;
              repeatBlocked += 1;
            }
            if (repeatBlocked >= REPEAT_BLOCK_LIMIT) {
              loopBlocked = true;
              recorder.event("loop_blocked", { tool: tool.name, ...detail });
            }
            return {
              content: [{ type: "text", text: message }],
              details: undefined,
              isError: true,
              ...(loopBlocked ? { terminate: true } : {}),
            };
          };

          const issueAction =
            tool.name === "issue" ? String((params as { action?: unknown }).action ?? "") : "";
          const issueWrite =
            tool.name === "issue" &&
            ["create", "edit", "plan", "link", "ensure", "close"].includes(issueAction);
          const mutatingProgress =
            tool.name === "edit" ||
            tool.name === "write" ||
            tool.name === "command" ||
            tool.name === "artifact";
          const research =
            tool.name === "read" ||
            tool.name === "search" ||
            tool.name === "context" ||
            (tool.name === "issue" && ["list", "view", "tree"].includes(issueAction));
          const noProgressLimit =
            input.agent.name === "planner"
              ? PLANNER_NO_PROGRESS_LIMIT
              : input.agent.name === "build" || input.agent.name === "sudo"
                ? MUTATING_NO_PROGRESS_LIMIT
                : 0;
          if (noProgressLimit > 0) {
            if (issueWrite || mutatingProgress) {
              noProgressCalls = 0;
            } else if (research) {
              noProgressCalls += 1;
              if (noProgressCalls >= noProgressLimit) {
                return block(
                  input.agent.name === "planner"
                    ? `Planner has made ${noProgressCalls} research/verification calls without an issue write. Create missing Tasks or stop with issue numbers.`
                    : `${noProgressCalls} research calls without an edit, write, or command. Act on the evidence or stop.`,
                  { args: capJson(params), noProgressCalls },
                );
              }
            }
          }

          // The planner needs one tree to inspect and one to verify. More is
          // repeated work: GitHub tree calls are slow and the result is large.
          if (tool.name === "issue" && issueAction === "tree") {
            treeCalls += 1;
            if (treeCalls > 2) {
              return block(
                "Tree already inspected twice. Use the last tree result and stop.",
                { args: capJson(params), treeCalls },
              );
            }
          }

          // Search loops often vary only the limit or scope. Key on the mode,
          // scope, and pattern so the third equivalent search is blocked.
          let searchKey: string | undefined;
          if (tool.name === "search") {
            const args = params as { mode?: unknown; pattern?: unknown; path?: unknown; paths?: unknown };
            const mode = typeof args.mode === "string" ? args.mode : "text";
            const pattern = typeof args.pattern === "string" ? args.pattern : "";
            const path = typeof args.path === "string" ? args.path : "";
            const paths = Array.isArray(args.paths)
              ? args.paths.filter((item): item is string => typeof item === "string").sort().join(",")
              : "";
            searchKey = `${mode}:${path}:${paths}:${pattern}`;
            const prior = searchKeys.get(searchKey) ?? 0;
            if (prior >= REPEAT_LIMIT) {
              return block(
                `Repeated ${mode} search blocked (${prior} earlier call(s) for this pattern and scope). ${repeatHint("search")}`,
                { args: capJson(params), repeats: prior },
              );
            }
          }

          // Reads of the same path are capped separately from identical calls.
          const readPath =
            tool.name === "read" && typeof (params as { path?: unknown }).path === "string"
              ? (params as { path: string }).path
              : "";
          if (readPath) {
            const prior = readPaths.get(readPath) ?? 0;
            if (prior >= READ_PATH_LIMIT) {
              return block(
                `Read limit reached for ${readPath} (${prior} earlier reads). Use the earlier results or answer. ${repeatHint("read")}`,
                { args: capJson(params), repeats: prior },
              );
            }
          }

          const keyParams =
            tool.name === "issue"
              ? normalizedIssueKey(params as Record<string, unknown>)
              : params;
          const key = `${tool.name}:${stableKey(keyParams)}`;
          const prior = callCounts.get(key);
          if (prior && prior.count >= REPEAT_LIMIT) {
            const preview = prior.preview ? ` Previous result: ${prior.preview}` : "";
            return block(
              `Repeated identical ${tool.name} call blocked (${prior.count} earlier identical call(s)). ` +
                `${repeatHint(tool.name)}${preview}`,
              { args: capJson(params), repeats: prior.count },
            );
          }

          const result = await execute(id, params, signal, onUpdate);
          if (!result.isError && tool.name === "search" && searchKey) {
            searchKeys.set(searchKey, (searchKeys.get(searchKey) ?? 0) + 1);
          }
          if (!result.isError && readPath) {
            const count = (readPaths.get(readPath) ?? 0) + 1;
            readPaths.set(readPath, count);
            if (count >= READ_PATH_LIMIT) {
              result.content.push({
                type: "text",
                text:
                  `[harness] ${readPath} has been read ${count} times. ` +
                  "Use the run state and act; do not re-read unchanged ranges.",
              });
            }
          }
          const preview = result.content
            .filter((item): item is { type: "text"; text: string } => item.type === "text")
            .map((item) => item.text)
            .join("\n")
            .replace(/\s+/g, " ")
            .slice(0, 300);
          callCounts.set(key, { count: (prior?.count ?? 0) + 1, preview });
          return result;
        },
      } as AgentTool;
    });
    const toolChars = toolDefinitionChars(tools);
    recorder.event("tools_registered", { names: tools.map((tool) => tool.name) });

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
      prepareRequest: ({ context }) => {
        const rendered = renderPromptMessages(context.messages, memory, mapIndex, input.contextText);
        pendingMessages = rendered.messages;
        lastPromptChars = rendered.chars;
        const chars = rendered.chars + toolChars;
        lastRequestChars = chars;
        recorder.recordContext(chars);
        const result = selectFor(chars);
        if ("error" in result) {
          recorder.event("model_select", { call: callIndex + 1, error: result.error, rejected: result.rejected });
          return undefined;
        }
        callIndex += 1;
        currentRow = result.selected;
        const model = input.models.getModel(currentRow.providerID, currentRow.id);
        recorder.event("model_select", {
          call: callIndex,
          key: currentRow.key,
          estimate: result.estimate,
          candidates: result.candidates,
          rejectedCount: result.rejectedCount,
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
          recorder.event("tool_call_start", {
            toolCallId: event.toolCallId,
            tool: event.toolName,
            ...(event.args !== undefined ? { args: capJson(event.args) } : {}),
          });
          break;
        }
        case "tool_execution_end": {
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
        const promptText = [mapIndex, input.contextText, input.request].filter(Boolean).join("\n\n");
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
    const hasNativeToolCall = malformed?.content.some((block) => block.type === "toolCall") ?? false;
    if (
      malformed &&
      malformed.stopReason !== "error" &&
      malformed.stopReason !== "aborted" &&
      !hasNativeToolCall &&
      hasToolCallMarkup(malformedText)
    ) {
      const provider = currentRow?.providerID ?? malformed.provider;
      const failedKey = currentRow?.key ?? `${malformed.provider}/${malformed.model}`;
      const message = `model ${failedKey} returned tool-call markup as plain text`;
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
        text: malformedText.slice(0, 1_000),
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
      error = "repeated identical tool calls detected";
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
          ? "The harness stopped repeated tool calls."
          : "The token budget is exhausted.";
      finalText = await finalAnswer(currentModel, reason);
    }
    finalText = appendIssueEvidence(finalText, readIssueEvidence(recorder.dir));

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
