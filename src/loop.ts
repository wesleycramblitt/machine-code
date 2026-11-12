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
import { effectiveOutputCeiling, DEFAULT_FIRST_TOKEN_TIMEOUT_MS, DEFAULT_OLLAMA_FIRST_TOKEN_TIMEOUT_MS, type MachineConfig, type AgentPolicy, type Policy } from "./config.js";
import { estimateCallCost } from "./catalogue/scoring.js";
import { estimateTokens, pick, providerMultiplier, relaxPinForFailure } from "./select.js";
import { applyClassification, classifyError, loadAvailability, resetModelTier, resetProviderTier, saveAvailability } from "./availability.js";
import { fundedProviderIds } from "./data.js";
import type { CatalogueRow } from "./catalogue/types.js";
import type { AgentDef, AgentName } from "./agents.js";
import { roleSkillPresets } from "./agents.js";
import type { MutableModels } from "./models.js";
import { coreTools } from "./tools/index.js";
import { toolDefinitionChars, toolSchemaChars } from "./tools/schema.js";
import type { AgentConfig } from "./agents/config.js";
import { addCurationVeto } from "./catalogue/overlay.js";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Layout } from "./paths.js";
import { layout as layoutFor } from "./paths.js";
import type { RunRecorder } from "./state/runs.js";
import { buildRepoMap, mapBytes, renderMapIndex, symbolCount, type RepoMap } from "./map/deterministic.js";
import { RunStateStore } from "./context/state.js";
import { contextBudget, type ContextBudget } from "./context/budget.js";
import { hasToolCallMarkup } from "./state/tool-call-text.js";
import { looksLikeSerializedArgs, repairToolArguments } from "./tools/args.js";
import { ProcessSupervisor } from "./processes/supervisor.js";
import { renderPromptMessages } from "./context/render.js";
import { findIssue } from "./plan/issues.js";
import type { FinishRequest } from "./tools/finish.js";


/** Default turn cap. 0 means no cap; set max_turns per role or run. */
export const MAX_TURNS = 0;

/** Successes that show a run did real work, not just memory bookkeeping. */
const SUBSTANTIVE_TOOLS = new Set(["read", "map", "search", "glob", "grep", "command", "edit", "write"]);

/** A request that is a question, not a change. A writable role answering a
 * question is not expected to edit; everything else (imperatives, bug
 * reports, symptom descriptions) is a change request. */
export function isQuestionRequest(text: string): boolean {
  const trimmed = text.trim();
  if (!/\?\s*$/.test(trimmed)) return false;
  return /^(?:what|why|how|which|when|where|who|explain|describe|list|show|tell|is|are|does|do|can|could|would|should)\b/i.test(trimmed);
}

/** A line the role contract requires on a real finish. */
export function hasTerminalLine(text: string): boolean {
  return /(?:^|\n)\s*(?:Result|Outcome|Changes|Verdict):/i.test(text);
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
  /** Repo-relative files pinned into the working set before the first model call. */
  seedFiles?: string[];
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
  
  /** Composer-excluded skill names the skill tool must refuse. */
  skillExcludes?: string[];
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


/** Never ask a provider for the model's full (possibly 384k) output ceiling.
 * 16k is far more than an edit needs and keeps a request inside a credit
 * balance that rejects 32k. */
const MAX_REQUESTED_OUTPUT_TOKENS = 16_000;
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

/**
 * A model-rotation retry carries the failed attempt's messages, which already
 * end with the request user message that prompt() is about to add. Without
 * stripping, the request is sent twice as two identical adjacent user
 * messages (observed: [system, user, assistant-empty, user]). The failed
 * attempt typically ends with an empty assistant message (the model returned
 * nothing), so pop those first, then the duplicated request underneath.
 * Fresh starts never hit this: their carried list is empty.
 */
export function stripTrailingPrompt(messages: AgentMessage[], request: string): AgentMessage[] {
  let end = messages.length;
  const isEmptyAssistant = (message: AgentMessage): boolean => {
    if ((message as { role?: string }).role !== "assistant") return false;
    const content = (message as { content?: unknown }).content;
    if (!Array.isArray(content) || content.length === 0) return true;
    return content.every(
      (block) =>
        typeof block === "object" &&
        block !== null &&
        (block as { type?: string }).type === "text" &&
        !((block as { text?: unknown }).text ?? ""),
    );
  };
  while (end > 0 && isEmptyAssistant(messages[end - 1]!)) end -= 1;
  const last = messages[end - 1] as { role?: string; content?: unknown } | undefined;
  const content = last?.content;
  const text =
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content
            .filter((block): block is { type: string; text?: string } => typeof block === "object" && block !== null)
            .filter((block) => block.type === "text")
            .map((block) => String(block.text ?? ""))
            .join("")
        : "";
  if (last?.role === "user" && text === request) end -= 1;
  return end === messages.length ? messages : messages.slice(0, end);
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

  /**
   * First-token timeout for one provider call. Ollama is local and known to
   * exist, but it may be busy with another request, so it waits far longer
   * than remote providers before the call is abandoned and rotated.
   */
  const firstTokenTimeoutMsFor = (providerID: string): number => {
    const base = input.machine.selection?.firstTokenTimeoutMs ?? DEFAULT_FIRST_TOKEN_TIMEOUT_MS;
    if (providerID !== "ollama") return base;
    const ollama =
      input.machine.selection?.ollamaFirstTokenTimeoutMs ?? DEFAULT_OLLAMA_FIRST_TOKEN_TIMEOUT_MS;
    return Math.max(ollama, base);
  };

  const applyErrorState = (
    provider: string,
    modelKey: string,
    classified: ReturnType<typeof classifyError>,
  ): void => {
    if (classified.kind === "funds") {
      for (const row of input.catalogue) {
        if (row.providerID === provider) triedModels.add(row.key);
      }
      triedModels.add(modelKey);
      return;
    }
    const state = loadAvailability(input.home);
    applyClassification(state, provider, modelKey, classified);
    if (classified.permanent === true && input.catalogue.some((row) => row.key === modelKey)) {
      const reason = `auto-vetoed: gone at runtime (${classified.message.slice(0, 140)})`;
      if (addCurationVeto(input.home, modelKey, `${reason} (run ${input.recorder.current.id})`)) {
        recorder.event("model_vetoed", { key: modelKey, reason });
      }
    }
    saveAvailability(input.home, state);
    Object.assign(availability, state);
  };

  const resetSuccessState = (provider: string, modelKey: string): void => {
    const state = loadAvailability(input.home);
    resetModelTier(state, modelKey);
    resetProviderTier(state, provider);
    saveAvailability(input.home, state);
    Object.assign(availability, state);
  };

  // A `--model`/`--provider` pin starts as a hard filter but relaxes to a
  // preference the moment the pinned model fails (see relaxPin below).
  let pinModel = input.requireModel;
  let pinProvider = input.requireProvider;

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
      requireProvider: pinProvider,
      requireModel: pinModel,
    });

  /**
   * A `--model`/`--provider` pin is a preference. Once the pinned model has
   * failed, holding the pin across retries filters the catalogue down to the
   * one model that just failed and the run dies with "no eligible model".
   * Drop the pin so the retry falls back to auto-selection.
   */
  const relaxPin = (failedKey: string, providerID: string): void => {
    const next = relaxPinForFailure({ model: pinModel, provider: pinProvider }, failedKey, providerID);
    if (next.dropped.length > 0) {
      recorder.event("model_pin_relaxed", {
        failedModel: failedKey,
        dropped: next.dropped,
        attempt: triedModels.size,
      });
    }
    pinModel = next.pin.model;
    pinProvider = next.pin.provider;
  };

  const mapRoot = input.toolRoot ?? input.root;
  // The issue file is the durable home of the todo checklist. Derive it from
  // the run's item so the todo tool works without another flag on every path.
  const issuePath = input.layout && recorder.current.itemId
    ? findIssue(input.layout, recorder.current.itemId)?.rel
    : undefined;

  const processes = new ProcessSupervisor({
    runId: recorder.id,
    runDir: recorder.dir,
    onEvent: (type, data) => recorder.event(type, data),
  });
  const wantMap = input.skipMap !== true;
  
  // Up-front context stays small and stable so the provider cache absorbs
  // it once: the one-line map index and full file/symbol detail on demand
  // (map outline, read symbol, map slice). The full per-file map is never
  // re-sent.
  let mapIndex = "";
  // Names only. The model must know a command exists before it can ask for
  // its schema; guessing core:run/typescript:check was a wasted call in every
  // observed run. The full schemas stay behind command action "describe".
  const commandIndex =
    input.agent.tools.includes("command") && input.commands.size > 0
      ? [
          "<commands>",
          'Typed commands. Call the command tool: {"action":"run","name":"...","args":{}}; {"action":"describe","name":"..."} for one schema.',
          [...input.commands.keys()].sort().join(" · "),
          "</commands>",
        ].join("\n")
      : "";
  if (wantMap) try {
    const built = await buildRepoMap(mapRoot, { processes });
    mapIndex = renderMapIndex(built.map);
    recorder.event("map_built", {
      files: built.map.files.length,
      symbols: symbolCount(built.map),
      bytes: mapBytes(built.map),
      cached: built.cached,
      head: built.map.head,
    });
  } catch (error) {
    recorder.event("map_built", {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  // The goal is the issue itself. Hints and the reused-branch note are task
  // framing; repeating them inside <run-state> duplicates the prompt.
  const goal = input.request.split(/\n\n## (?:Context|Skills|Existing branch state|Worktree)\b/)[0]!.trim() || input.request;
  const memory = new RunStateStore({
    runDir: recorder.dir,
    runId: recorder.id,
    goal,
    repoRoot: mapRoot,
    recorder,
    processes,
  });
  // Preload the task files so the first prompt already carries them.
  // Working context re-reads from disk, so pins never go stale.
  if (input.seedFiles && input.seedFiles.length > 0) {
    memory.seedWorkingFiles(input.seedFiles, 0);
  }
  // The next action is the first open item in the issue's durable todo.
  const issueForTodo = input.layout && recorder.current.itemId
    ? findIssue(input.layout, recorder.current.itemId)
    : null;
  const firstTodo = issueForTodo?.todo.find((item) => !item.done);
  if (firstTodo) memory.note("next", firstTodo.text, [], 0);
  // Rebuild the map and module index after a changed turn. The map cache is
  // keyed by the exact working tree, so this is a cheap stat pass when
  // nothing changed. Coalesce a burst of edits into one rebuild.
  let mapRefreshInFlight = false;
  let mapRefreshQueued = false;
  const refreshMapIndex = async (turn: number): Promise<void> => {
    if (!wantMap) return;
    const built = await buildRepoMap(mapRoot, { processes });
    mapIndex = renderMapIndex(built.map);
    recorder.event("map_refresh", {
      turn,
      ok: true,
      cached: built.cached,
    });
  };
  const scheduleMapRefresh = (turn: number): void => {
    if (!input.machine.map.enabled || !wantMap) return;
    if (mapRefreshInFlight) {
      mapRefreshQueued = true;
      return;
    }
    mapRefreshInFlight = true;
    recorder.event("map_refresh_scheduled", { turn });
    void (async () => {
      try {
        await refreshMapIndex(turn);
      } catch (error) {
        recorder.event("map_refresh", {
          turn,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
      } finally {
        mapRefreshInFlight = false;
        if (mapRefreshQueued) {
          mapRefreshQueued = false;
          scheduleMapRefresh(turn);
        }
      }
    })();
  };

  // The assembled context is the single source of truth. There is no hidden
  // task pack that selects files after the user curated the context.
  let lastOverviewChars = 0;
  let lastBudget: ContextBudget | null = null;

  const initialChars =
    input.agent.prompt.length +
    input.request.length +
    (input.contextText?.length ?? 0) +
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
  let turns = 0;
  /** Cumulative turns across resumes, for the run summary. */
  let reportedTurns = recorder.current.turns;
  let budgetExhausted = false;
  let currentRow: CatalogueRow | null = null;
  let agent: Agent | undefined;
  /** Conversation carried into a new agent when a retry switches models. The
   * new model must continue the same conversation, not start over. */
  let carriedMessages: import("@earendil-works/pi-agent-core").AgentMessage[] | undefined = input.initialMessages;
  /** Prompt chars for the request being prepared; used for context accounting. */
  let lastRequestChars = initialChars;
  let lastPromptChars = 0;
  /** Rendered prompt for the request being prepared, consumed by transformContext. */
  let pendingMessages: AgentMessage[] | null = null;

  /** Does this run owe the user a code change? Read-only roles and pure
   * questions are exempt; a writable role answering anything else — an
   * imperative, a bug report, a symptom description — is not. */
  const wantsChange =
    input.agent.readonly !== true &&
    input.agentCapabilities?.includes("code:write") !== false &&
    !isQuestionRequest(input.request);
  const hasActiveChange = (): boolean =>
    memory.getState().facts.some((fact) => fact.kind === "change" && fact.status === "active");


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
      reason,
      "Do not call tools. Answer the user's request from the evidence above. If the evidence is insufficient, say exactly what is missing.",
      "Keep the answer under 20 lines. For a research run, list the created issues and the next concrete step; do not restate bodies.",
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
  let finishRequested: FinishRequest | null = null;
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
      relaxPin(currentRow.key, currentRow.providerID);
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
      eligibleCount: first.eligibleCount,
      candidates: first.candidates,
      rejectedCount: first.rejectedCount,
      rejectedByReason: first.rejectedByReason,
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

    const artifactContext: import("./tools/artifact.js").ArtifactToolContext | undefined =
      input.layout && input.agent.tools.includes("artifact")
        ? {
            layout: layoutFor(mapRoot),
            capabilities: input.agentCapabilities ?? [],
            recorder,
            allowScripts: true,
          }
        : undefined;

    // Skill tool: on-demand SKILL.md bodies. Preset-excluded skills plus the
    // composer's per-skill exclusions are invisible here.
    const skillContext: import("./tools/skill.js").SkillToolContext | undefined =
      input.layout && input.agent.tools.includes("skill")
        ? {
            layout: layoutFor(mapRoot),
            recorder,
            excluded: new Set([
              ...Object.entries(roleSkillPresets(input.agent.name))
                .filter(([, mode]) => mode === "exclude")
                .map(([name]) => name),
              ...(input.skillExcludes ?? []),
            ]),
          }
        : undefined;

    const rawTools = coreTools(
      {
        root: input.toolRoot ?? input.root,
        commands: input.commands,
        tools: input.agent.tools,
        ask: askContext,
        artifacts: artifactContext,
        skills: skillContext,
        state: memory,
        repoRoot: input.root,
        ...(issuePath ? { issuePath } : {}),
        finish: (result) => {
          finishRequested = result;
          recorder.event("finish", { outcome: result.outcome, summary: result.summary });
        },
        processes,
        allowMutations: (input.agentCapabilities ?? []).includes("code:write"),
        capabilities: input.agentCapabilities ?? [],
        allowedPaths: input.agent.allowedPaths,
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
          const key = `${tool.name}:${stableKey(params)}`;
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
            return {
              content: [{
                type: "text" as const,
                text:
                  `[cached ${commandName} from turn ${cached.turn}; no files changed since]
` +
                  cached.text,
              }],
              details: undefined,
            };
          }
          const result = await execute(id, params, signal, onUpdate);
          if (!result.isError && (tool.name === "edit" || tool.name === "write")) {
            changeEpoch += 1;
            commandCache.clear();
          }
          if (!result.isError && tool.name === "command" && commandAction === "run" && !cacheableCommand) {
            changeEpoch += 1;
            commandCache.clear();
          }
          if (!result.isError && cacheableCommand) {
            const text = result.content
              .filter((item): item is { type: "text"; text: string } => item.type === "text")
              .map((item) => item.text)
              .join("\n");
            const preview = text.replace(/\s+/g, " ").slice(0, 300);
            commandCache.set(key, {
              epoch: changeEpoch,
              turn: memory.currentTurn(),
              text,
              preview,
            });
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
      toolExecution: "sequential",
      initialState: {
        model: currentModel,
        thinkingLevel: "low",
        systemPrompt: input.agent.prompt,
        tools,
        ...(carriedMessages && carriedMessages.length > 0 ? { messages: stripTrailingPrompt(carriedMessages, input.request) } : {}),
      },
      sessionId: recorder.id,
      convertToLlm,
      streamFn: (model, context, options) => {
        const call = callIndex;
        const firstTokenTimeoutMs = firstTokenTimeoutMsFor(model.provider);
        const requestText = renderModelInput((context as Context).messages);
        recorder.event("model_request", {
          call,
          provider: model.provider,
          model: model.id,
          firstTokenTimeoutMs,
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
        return renderPromptMessages(
          messages,
          memory,
          mapIndex,
          input.contextText,
          undefined,
          commandIndex,
        ).messages;
      },
      prepareRequest: async ({ context }) => {
        const renderFor = (row: CatalogueRow | null) => {
          const budget = row ? contextBudget(row.context, policy.expectedOutputTokens) : null;
          lastBudget = budget;
          const baseOverhead =
            input.agent.prompt.length +
            mapIndex.length +
            memory.renderBlock().length +
            toolChars +
            24_000;
          const overviewBaseChars = input.contextText?.length ?? 0;
          const overviewMaxChars = budget
            ? Math.max(8_000, budget.inputChars - baseOverhead)
            : undefined;
          const overviewEstimate = Math.min(overviewBaseChars, overviewMaxChars ?? overviewBaseChars);
          lastOverviewChars = overviewEstimate;
          if (budget) {
            const projected = overviewBaseChars + baseOverhead;
            const ratio = projected / budget.inputChars;
            if (ratio >= 0.8) {
              recorder.event("context_warning", {
                kind: overviewBaseChars > overviewEstimate ? "overview-trimmed" : "context-near-budget",
                chars: projected,
                inputBudgetChars: budget.inputChars,
                ratio,
                model: row?.key,
                message: overviewBaseChars > overviewEstimate
                  ? "curated context exceeds the model input budget; lower-priority blocks are omitted"
                  : "curated context is near the model input budget",
              });
            }
          }
          // The transcript is replayed whole; the ledger is for explicit
          // context recall, not for re-sending bytes the model already has.
          return renderPromptMessages(
            context.messages,
            memory,
            mapIndex,
            input.contextText,
            overviewMaxChars,
            commandIndex,
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
          eligibleCount: result.eligibleCount,
          candidates: result.candidates,
          rejectedCount: result.rejectedCount,
          rejectedByReason: result.rejectedByReason,
          ...(repickReason ? { repick: repickReason } : {}),
        });
        if (!model) return undefined;
        currentModel = model;
        return { model };
      },
      finishTurn: async ({ message }) => {
        turns += 1;
        reportedTurns += 1;
        recorder.recordTurn(reportedTurns);
        if (finishRequested) return { action: "end" as const };
        const usage = message.usage ?? zeroUsage;
        totalTokens += usage.totalTokens;
        if (policy.budgetTokens !== undefined && totalTokens > policy.budgetTokens) {
          budgetExhausted = true;
          recorder.event("budget_exhausted", { totalTokens, budget: policy.budgetTokens });
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
            if (ingested.changed) scheduleMapRefresh(turns + 1);
            recorder.event("context_state", {
              turn: turns + 1,
              chars: lastRequestChars,
              promptChars: lastPromptChars,
              tokens: actualContextTokens > 0 ? actualContextTokens : Math.ceil(lastRequestChars / 4),
              stateChars: memory.renderBlock().length,
              overviewChars: lastOverviewChars,
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
            } else if (message.stopReason !== "aborted") {
              // A completed call proves the route is healthy: drop any
              // escalated tier so transient blips do not ratchet a provider
              // toward day-long bans.
              try {
                const provider = message.provider || currentRow?.providerID || "";
                const key = currentRow?.key ?? (provider ? `${provider}/${message.model}` : "");
                if (provider && key) resetSuccessState(provider, key);
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
        // The context and map are rendered by renderPromptMessages. Prompt
        // the agent with only the task; passing the context here duplicated
        // the entire prompt on the first turn.
        await agent.prompt(input.request);
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
            relaxPin(failedKey, provider);
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

    const finished = finishRequested as FinishRequest | null;
    if (finished) {
      return { status: finished.outcome, finalText: finished.summary };
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
      relaxPin(failedKey, provider);
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
    const stop = la2?.stopReason;
    let status: RunLoopResult["status"] = "completed";
    let error: string | undefined;
    if (cancelRequested) {
      status = "cancelled";
    } else if (pauseRequested) {
      status = "paused";
    } else if (input.signal?.aborted) {
      status = "interrupted";
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

    if (!finalText.trim() && currentModel && (turnCapHit || budgetExhausted)) {
      const reason = turnCapHit
        ? "You have reached the turn cap."
        : "The token budget is exhausted.";
      finalText = await finalAnswer(currentModel, reason);
    }

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
    } else if (
      status === "completed" &&
      wantsChange &&
      !hasActiveChange() &&
      !hasTerminalLine(finalText)
    ) {
      // Prose is not a deliverable. A writable role that stopped
      // mid-investigation without touching a file is blocked, not done. A
      // clear terminal answer (Result:/Outcome:) is left alone.
      status = "blocked";
      error = "completed without making the requested change";
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
        relaxPin(failedModel, la.provider);
        lastFailure = la.errorMessage;
        // Carry the whole conversation into the replacement agent: a switch
        // is a new model on the same run, not a fresh run.
        carriedMessages = agent?.state.messages ?? carriedMessages;
        recorder.event("retry", {
          failedModel,
          kind: classified.kind,
          attempt: triedModels.size,
          carriedMessages: carriedMessages?.length ?? 0,
        });
        continue; // retry on another model, same conversation
      }
    }

    clearInterval(heartbeatTimer); clearInterval(controlTimer); unregisterInstance(input.home);
    return { status, finalText, error };
  }
}
