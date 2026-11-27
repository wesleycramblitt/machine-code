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
 *
 * Acceptance gates: when the agent finishes, the run runs gates inline. If
 * they fail, the gate output is fed back to the model and it retries — all
 * within the same run. A gate attempt cap prevents infinite loops.
 */
import { Agent, type AgentMessage, type AgentTool } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream, type Api, type AssistantMessage, type AssistantMessageEvent, type Context, type Message, type Model, type Usage } from "@earendil-works/pi-ai";
import { effectiveOutputCeiling, DEFAULT_FIRST_TOKEN_TIMEOUT_MS, DEFAULT_OLLAMA_FIRST_TOKEN_TIMEOUT_MS, type MachineConfig } from "./config.js";
import { estimateCallCost } from "./catalogue/scoring.js";
import { estimateTokens, pickWithContext, providerMultiplier, relaxPinForFailure, resolveSelectionContext } from "./select.js";
import { applyClassification, classifyError, loadAvailability, saveAvailability } from "./availability.js";
import { fundedProviderIds } from "./data.js";
import type { CatalogueRow } from "./catalogue/types.js";
import type { AgentDef, AgentName } from "./agents.js";
import { roleSkillPresets } from "./agents.js";
import type { MutableModels } from "./models.js";
import { coreTools } from "./tools/index.js";
import { toolDefinitionChars, toolSchemaChars } from "./tools/schema.js";
import type { AgentConfig } from "./agents/config.js";
import { addCurationVeto } from "./catalogue/overlay.js";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Layout } from "./paths.js";
import { layout as layoutFor } from "./paths.js";
import type { RunRecorder } from "./state/runs.js";
import { buildRepoMap, mapBytes, renderMapIndex, symbolCount, type RepoMap } from "./map/deterministic.js";
import { RunStateStore } from "./context/state.js";
import { contextBudget, requestedOutputTokens, charsToTokens, type ContextBudget } from "./context/budget.js";
import { hasToolCallMarkup } from "./state/tool-call-text.js";
import { looksLikeSerializedArgs, repairToolArguments } from "./tools/args.js";
import { extractNamedBlocks, writeNamedBlocks } from "./tools/named-blocks.js";
import { ProcessSupervisor } from "./processes/supervisor.js";
import { renderPromptMessages, keptToolCallIds } from "./context/render.js";
import { toolIndexBody } from "./context/references.js";
import { findIssue } from "./plan/issues.js";
import { buildEvidence, changedIssuesText, evidenceHandle, MAX_LEDGER_ENTRIES, type RetainedCall } from "./context/evidence.js";
import { runCommand } from "./commands/registry.js";
import type { FinishRequest } from "./tools/finish.js";
import { gateFailureText, runGates, type GateResult, type GateSpec } from "./verify.js";
import { vcsSyncCommand } from "./commands/vcs.js";


/** Prompt for the post-gate closing summary: decisions + work, grounded in
 * run state. Pure so the contract (three sections, grounded, short, no
 * tools) is unit-testable without a model. */
export function buildClosingSummaryPrompt(request: string, stateText: string): string {
  return [
    stateText,
    "All acceptance gates passed. Write the final summary a human needs in order to understand WHY this run did what it did — not just what changed.",
    "Three sections, grounded strictly in the state above (notes, changes, gates). Do not invent rationale that is not recorded; say 'not recorded' instead.",
    "## Decisions — one line each: the scope/behavior call made, the option chosen, the alternative rejected and why.",
    "## Work — one line per file created, changed, or deleted: path, what changed, why.",
    "## Verification — the gates that passed.",
    "Keep it under 30 lines. Do not call tools.",
    `Request: ${request}`,
  ].join("\n\n");
}

/** Default turn cap. 0 means no cap; set max_turns per role or run. */
export const MAX_TURNS = 0;

/** Default model call cap for a single run. Prevents runaway costs. */
const MAX_CALLS = 250;

/** Default maximum number of gate retry attempts within a run. */
const MAX_GATE_ATTEMPTS = 5;

/** Successes that show a run did real work, not just memory bookkeeping. */
const SUBSTANTIVE_TOOLS = new Set(["inspect", "map", "glob", "grep", "command", "edit", "write"]);

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
  /** Hint symbol ranges pre-filling the living map (rendered as turn-1 deltas). */
  seedRanges?: Array<{ path: string; range: [number, number] }>;
  /** Selection tier (paid filters out ollama/free; local only allows ollama). */
  tier?: import("./config.js").SelectionTier;
  /** Fallback tier when tier-one selection finds no eligible model. Absent or equal to tier means none. */
  tier2?: import("./config.js").SelectionTier;
  /** Layout + full policy: enable the task tool (delegation). */
  layout?: Layout;
  fullPolicy?: import("./config.js").Policy;
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
  /** Repo-relative files the run is about, seeded into evidence as native
   * inspect pairs from turn 0. Short files arrive whole (< 200 lines);
   * longer ones arrive as an outline, which is what the model reads anyway. */
  seedEvidence?: string[];
  /** Skip the deterministic repo map index in the model's up-front context. */
  skipMap?: boolean;
  /** Per-turn symbol-map cap override (default: machine context.symbols_max_chars,
   * clamped per model to 10% of its input budget). */
  symbolsMaxChars?: number;
  
  /** Composer-excluded skill names the skill tool must refuse. */
  skillExcludes?: string[];

  /** Acceptance gates to run after the agent finishes. If they fail, the
   * output is fed back to the model for repair — all in the same run. */
  gates?: GateSpec[];
  /** Maximum model calls before the run is blocked (default: 50). */
  maxCalls?: number;
  /** Maximum gate-retry iterations within a run (default: 5). */
  maxGateAttempts?: number;
}

export interface RunLoopResult {
  status: "completed" | "blocked" | "failed" | "interrupted" | "paused" | "cancelled";
  finalText: string;
  error?: string;
  /** When gates fail after exhausting attempts, the last gate failure text so
   * the caller can append it to the issue file. */
  lastGateFailure?: string;
}

function convertToLlm(messages: AgentMessage[]): Message[] {
  return messages.filter(
    (m): m is Message =>
      m.role === "system" || m.role === "user" || m.role === "assistant" || m.role === "toolResult",
  );
}


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
  const maxTurns =
    input.agent.maxTurns === undefined ? MAX_TURNS : Math.max(0, Math.floor(input.agent.maxTurns));
  const ceiling = effectiveOutputCeiling(input.agent, input.machine);
  /** Lowered on an account funds/quota error so the next request fits the balance. */
  let outputDownshift: number | undefined;
  let outputDownshifts = 0;
  let lastRequestedMaxTokens: number | undefined;
  let fundsRetryArmed = false;
  const configuredProviders = input.configuredProviders;
  const fundedProviders = fundedProviderIds(input.machine.providers);
  // Callers normally load this, but a direct run must still respect persisted
  // availability. Loading here also keeps the in-memory state current.
  const availability = input.availability ?? loadAvailability(input.home);
  const triedModels = new Set<string>();

  /**
   * Free-tier retry keeps an in-attempt exclusion set only, never persisted.
   * A failed free model is excluded for the rest of the run attempt; a
   * provider-wide hard error excludes every model on that provider so the
   * next pick moves to another free-supported provider. Paid and local retry
   * behavior is unchanged.
   */
  const isFreeRow = (row: { providerID: string; free?: boolean; pricing: { input: number; output: number } }): boolean =>
    row.providerID !== "ollama" && (row.free === true || (row.pricing.input === 0 && row.pricing.output === 0));
  const isFreeMode = (): boolean => input.machine.selection.freeCloudModelsEnabled === true;
  const isProviderWideHardError = (classified: ReturnType<typeof classifyError>): boolean => {
    if (classified.kind === "rate-limit-provider") return true;
    if (classified.kind === "funds" || classified.kind === "quota") {
      const msg = classified.message;
      return (
        msg.includes("organization") ||
        msg.includes("account") ||
        msg.includes("quota") ||
        msg.includes("monthly") ||
        msg.includes("plan limit") ||
        msg.includes("workspace") ||
        msg.includes("provider-wide") ||
        msg.includes("provider wide")
      );
    }
    return false;
  };
  /** A free row this run could actually call: its provider is configured and
   * not disabled. Catalogue rows for providers that can never run (e.g. nvidia,
   * disabled and keyless) are not free capacity and must not be named as such
   * when the run reports exhaustion. */
  const usableFreeRow = (row: { providerID: string }): boolean => {
    if (!configuredProviders.has(row.providerID)) return false;
    const state = availability.providers[row.providerID];
    if (state?.disabled === true || state?.needsAuth === true) return false;
    return true;
  };
  const freeProviderIDs = (): string[] => {
    const ids = new Set<string>();
    for (const row of input.catalogue) {
      if (isFreeRow(row) && usableFreeRow(row)) ids.add(row.providerID);
    }
    return [...ids].sort();
  };
  const freeRowsExhausted = (): boolean => {
    if (!isFreeMode()) return false;
    const freeRows = input.catalogue.filter((row) => isFreeRow(row) && usableFreeRow(row));
    if (freeRows.length === 0) return false;
    return freeRows.every((row) => triedModels.has(row.key));
  };
  const freeExhaustionError = (): string => {
    const providers = freeProviderIDs();
    const named = providers.length > 0 ? providers.join(", ") : "unknown";
    return "free models exhausted on provider" + (providers.length === 1 ? "" : "s") + " (" + named + "); last error kind: " + String(lastErrorKind ?? "unknown") + "; last error: " + String(lastFailure ?? "unknown");
  };

  /**
   * First-token timeout for one provider call (ms), or undefined for no
   * first-token timeout. Remote providers keep the finite default so a stall
   * is abandoned and rotated. Ollama is local and may sit queued behind
   * another GPU request (loading a model, finishing a long generation), so a
   * queue wait is not an error: by default local calls wait indefinitely, and
   * the call is bounded only by the run's own caps and the user's Ctrl-C. A
   * finite `ollama_first_token_timeout_ms` override still applies.
   */
  const firstTokenTimeoutMsFor = (providerID: string): number | undefined => {
    const base = input.machine.selection?.firstTokenTimeoutMs ?? DEFAULT_FIRST_TOKEN_TIMEOUT_MS;
    if (providerID !== "ollama") return base;
    return input.machine.selection?.ollamaFirstTokenTimeoutMs;
  };

  const applyErrorState = (
    provider: string,
    modelKey: string,
    classified: ReturnType<typeof classifyError>,
  ): void => {
    const failedRow = input.catalogue.find((row) => row.key === modelKey);
    if (isFreeMode() && failedRow && isFreeRow(failedRow)) {
      // Free tier: in-attempt exclusion only, never persisted. Provider-wide
      // hard errors exclude every model on that provider so the next pick
      // moves to another free-supported provider. Per-model limits, route
      // noise (timeout/network/5xx), and other errors exclude only the
      // failing model.
      if (classified.needsAuth) {
        try {
          const state = loadAvailability(input.home);
          state.providers[provider] = { ...(state.providers[provider] ?? {}), needsAuth: true };
          saveAvailability(input.home, state);
          Object.assign(availability, state);
        } catch {
          // availability write failure must not stop rotation
        }
      }
      if (classified.permanent === true) {
        const reason = "auto-vetoed: gone at runtime (" + classified.message.slice(0, 140) + ")";
        try {
          if (addCurationVeto(input.home, modelKey, reason + " (run " + input.recorder.current.id + ")")) {
            recorder.event("model_vetoed", { key: modelKey, reason });
          }
        } catch {
          // veto failure must not stop rotation
        }
      }
      if (isProviderWideHardError(classified)) {
        for (const row of input.catalogue) {
          if (row.providerID === provider) triedModels.add(row.key);
        }
      }
      triedModels.add(modelKey);
      return;
    }
    if (classified.kind === "funds") {
      for (const row of input.catalogue) {
        if (row.providerID === provider) triedModels.add(row.key);
      }
      triedModels.add(modelKey);
      return;
    }
    const state = loadAvailability(input.home);
    applyClassification(state, provider, modelKey, classified);
    // A permanent missing-model failure is recorded as a catalogue veto so the
    // row stops being selected (see the catalogue veto path).
    if (classified.permanent === true && input.catalogue.some((row) => row.key === modelKey)) {
      const reason = `auto-vetoed: gone at runtime (${classified.message.slice(0, 140)})`;
      if (addCurationVeto(input.home, modelKey, `${reason} (run ${input.recorder.current.id})`)) {
        recorder.event("model_vetoed", { key: modelKey, reason });
      }
    }
    saveAvailability(input.home, state);
    Object.assign(availability, state);
  };

  const resetSuccessState = (_provider: string, _modelKey: string): void => {
    // Success performs no availability write: temporary failures never exclude.
  };

  // A `--model`/`--provider` pin starts as a hard filter but relaxes to a
  // preference the moment the pinned model fails (see relaxPin below).
  // The pin lives on the selection context so every pick uses it.
  const selection = resolveSelectionContext({
    role: input.agent.name,
    layout: input.layout ?? layoutFor(input.root),
    machine: input.machine,
    def: input.agent,
    ...(input.tier ? { tier: input.tier } : {}),
    pin: {
      ...(input.requireModel ? { model: input.requireModel } : {}),
      ...(input.requireProvider ? { provider: input.requireProvider } : {}),
    },
    hasRuntimeModel: (providerID: string, id: string) => input.models.getModel(providerID, id) !== undefined,
  });

  // Tier two activates only when tier-one selection finds no eligible
  // model: the pick retries on the fallback tier with the same floors, pin,
  // and exclusion list. Every attempt restarts at tier one (resume included)
  // because all picks flow through here.
  const fallbackTier = input.tier2 && input.tier2 !== selection.tier ? input.tier2 : undefined;
  const selectFor = (chars: number) => {
    const parts = {
      agent: input.agent.name,
      machine: input.machine,
      catalogue:
        triedModels.size === 0
          ? input.catalogue
          : input.catalogue.filter((row) => !triedModels.has(row.key)),
      configuredProviders,
      availability,
      fundedProviders,
      contextChars: chars,
    };
    const first = pickWithContext(selection, parts);
    if (!("error" in first) || !fallbackTier) return first;
    const retry = pickWithContext({ ...selection, tier: fallbackTier }, parts);
    if ("error" in retry) {
      const rejectedByReason: Record<string, number> = { ...first.rejectedByReason };
      for (const [reason, count] of Object.entries(retry.rejectedByReason)) {
        rejectedByReason[reason] = (rejectedByReason[reason] ?? 0) + count;
      }
      return {
        error:
          `${first.error} (tier ${selection.tier ?? "default"} exhausted; ` +
          `fallback ${fallbackTier} also has no eligible model: ${retry.error})`,
        rejected: [...first.rejected, ...retry.rejected],
        rejectedCount: first.rejectedCount + retry.rejectedCount,
        rejectedByReason,
      };
    }
    recorder.event("tier_fallback", {
      from: selection.tier ?? "default",
      to: fallbackTier,
      reason: first.error,
    });
    return retry;
  };

  /**
   * A `--model`/`--provider` pin is a preference. Once the pinned model has
   * failed, holding the pin across retries filters the catalogue down to the
   * one model that just failed and the run dies with "no eligible model".
   * Drop the pin so the retry falls back to auto-selection.
   */
  const relaxPin = (failedKey: string, providerID: string): void => {
    const next = relaxPinForFailure(
      { model: selection.requireModel, provider: selection.requireProvider },
      failedKey,
      providerID,
    );
    if (next.dropped.length > 0) {
      recorder.event("model_pin_relaxed", {
        failedModel: failedKey,
        dropped: next.dropped,
        attempt: triedModels.size,
      });
    }
    selection.requireModel = next.pin.model;
    selection.requireProvider = next.pin.provider;
  };

  const mapRoot = input.toolRoot ?? input.root;
  // The issue file is the durable home of the task. Derive it from
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
  let repoMap: RepoMap | null = null;
  // Names only. The model must know a command exists before it can ask for
  // its schema; guessing core:run/typescript:check was a wasted call in every
  // observed run. The full schemas stay behind command action "describe".
  const commandIndex =
    input.agent.tools.includes("command") && input.commands.size > 0
      ? [
          "<commands>",
          'Call: {"action":"run","name":"...","args":{}} to run a command, {"action":"describe","name":"..."} for its schema.',
          "",
          ...toolIndexBody(input.commands).split("\n"),
        ].join("\n")
      : "";
  if (wantMap) try {
    const built = await buildRepoMap(mapRoot);
    repoMap = built.map;
    // Render with a reasonable budget initially. The model-specific budget
    // is applied in prepareRequest after the model is selected.
    mapIndex = renderMapIndex(built.map, 102_400);
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

  // The goal labels the state file, not the prompt: the full request rides
  // every prompt in the transcript head and the recap re-anchors it, so
  // the stored goal stays one line.
  const goalHead = input.request.split(/\n\n## (?:Context|Skills|Existing branch state|Worktree)\b/)[0]!.trim() || input.request;
  const firstLine = goalHead.split("\n").find((line) => line.trim() !== "")?.trim() ?? goalHead;
  const goal = firstLine.length > 300 ? `${firstLine.slice(0, 299)}…` : firstLine;
  const memory = new RunStateStore({
    runDir: recorder.dir,
    runId: recorder.id,
    goal,
    repoRoot: mapRoot,
    recorder,
    processes,
  });
  // Preload the task files so the first prompt already indexes them.
  if (input.seedFiles && input.seedFiles.length > 0) {
    memory.seedFiles(input.seedFiles, 0);
  }
  if (input.seedRanges && input.seedRanges.length > 0) {
    memory.seedHints(input.seedRanges, 0);
  }
  // Rebuild the map and module index after a changed turn. The map cache is
  // keyed by the exact working tree, so this is a cheap stat pass when
  // nothing changed. Coalesce a burst of edits into one rebuild.
  let mapRefreshInFlight = false;
  let mapRefreshQueued = false;
  const refreshMapIndex = async (turn: number): Promise<void> => {
    if (!wantMap) return;
    const built = await buildRepoMap(mapRoot);
    repoMap = built.map;
    const { map: mapBudget } = computeBudgets(lastBudget?.inputChars);
    mapIndex = renderMapIndex(repoMap, mapBudget);
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
  let lastSymbolsChars = 0;
  /** Consecutive turns with tool calls but no note, plan update, or edit.
   * Any streak at all carries a reminder on the next prompt. */
  let readOnlyStreak = 0;
  /** Consecutive text-only turns (no tool calls, no finish) on a run that
   * owes a change. The first ones get a reprompt and a continue; past the
   * cap the run ends and the existing blocked handling applies. */
  let textOnlyStreak = 0;
  let continuePromptArmed = false;
  const MAX_TEXT_ONLY_CONTINUES = 2;
  /** Files shorter than this seed their whole body into evidence; longer files
 * seed an outline (signatures), which is what a model reads anyway. */
const SEED_BODY_LINES = 200;
/** Absolute ceiling for re-served evidence per prompt. The share below is
   * unbounded on large windows; without this, old reads crowd out the
   * instructions. Most-recent-first with oldest-drop still applies. */
  const EVIDENCE_MAX_CHARS = 96_000;
  const ctxBudget = input.machine.context.budget;

  /**
   * Compute per-component budgets from a unified pool that covers ALL context.
   * pool = modelInputChars * ctxBudget.total (0.95).
   *
   * Fixed overhead (system/agent/tool guide/command index) gets ctxBudget.overhead
   * of the pool. The remaining variable pool (symbols, map, state, evidence,
   * context block) is split by share. The context block gets what's left.
   */
  const computeBudgets = (inputChars: number | undefined, hardCap?: number): { symbols: number; map: number; state: number; evidence: number; transcript: number; wholeFile: number; contextBlock: number } => {
    const pool = inputChars ? Math.floor(inputChars * ctxBudget.total) : 256_000;
    const variableShare = 1.0 - ctxBudget.overhead;
    const variablePool = Math.floor(pool * variableShare);
    const symbols = Math.max(2_048, Math.floor(variablePool * ctxBudget.symbols));
    const map = Math.max(1_024, Math.floor(variablePool * ctxBudget.map));
    const state = Math.max(4_096, Math.floor(variablePool * ctxBudget.state));
    // Seeded files ride in evidence, so their bytes move out of the context
    // block instead of doubling the pool. Long files seed an outline, so this
    // stays small in practice.
    const seedChars = (input.seedEvidence ?? []).reduce((sum, path) => {
      try {
        const text = readFileSync(join(input.root, path), "utf8");
        return sum + (text.split("\n").length < SEED_BODY_LINES ? text.length : 4_096);
      } catch {
        return sum;
      }
    }, 0);
    const evidence = Math.min(
      EVIDENCE_MAX_CHARS,
      Math.max(2_048, Math.floor(variablePool * ctxBudget.evidence)) + seedChars,
    );
    const wholeFile = Math.max(2_048, Math.floor(variablePool * ctxBudget.wholeFile));
    // Retained prose turns: the conversation, not the old tool traffic.
    const transcript = Math.min(48_000, Math.max(4_096, Math.floor(variablePool * ctxBudget.transcript)));
    const contextBlock = Math.max(4_096, variablePool - symbols - map - state - evidence - transcript);
    if (hardCap !== undefined) {
      return { symbols: Math.min(symbols, hardCap), map, state, evidence, transcript, wholeFile, contextBlock };
    }
    return { symbols, map, state, evidence, transcript, wholeFile, contextBlock };
  };

  /** Reminder appended to the next prompt after a read-only turn.
   * Progress means an edit, a write, a finish, or a completed plan step — not
   * another note. Prompt text alone did not hold, so the streak count names
   * the lapse; the asks are all actions that advance the tree or the plan. */
  const recordNudge = (streak: number): string =>
    `${streak} turn${streak === 1 ? "" : "s"} since the last edit, write, finish, or completed plan step. ` +
    `Advance the work now: edit the file you are working on, or mark the current plan step done and start the next one. ` +
    `A note does not move the run forward; if the next step needs no new fact, edit instead of reading again.`;
  const withRecordNudge = (
    messages: import("@earendil-works/pi-agent-core").AgentMessage[],
  ): import("@earendil-works/pi-agent-core").AgentMessage[] => {
    if (readOnlyStreak < 1) return messages;
    recorder.event("record_nudge", { streak: readOnlyStreak });
    return [
      ...messages,
      {
        role: "user",
        content: recordNudge(readOnlyStreak),
        timestamp: Date.now(),
      } as unknown as import("@earendil-works/pi-agent-core").AgentMessage,
    ];
  };

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
  let lastErrorKind: string | undefined;
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
  /** Re-served evidence for the prompt being prepared. */
  let pendingEvidence: import("./context/evidence.js").BuiltEvidence | undefined;

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
      "Keep the answer under 20 lines. For an architect run, list the created issues and the next concrete step; do not restate bodies.",
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

  /**
   * After gates pass, ask the run's model for the closing summary a human
   * needs to understand WHY: decisions taken (with rejected alternatives)
   * plus work done (per file). Same tool-free mechanics as finalAnswer: one
   * bounded call, usage recorded, empty string on any failure (the caller
   * keeps the finish-tool receipt as fallback).
   */
  const closingSummary = async (model: Model<Api>): Promise<string> => {
    const prompt = buildClosingSummaryPrompt(input.request, memory.renderBlock());
    try {
      const source = input.models.streamSimple(
        model,
        {
          systemPrompt: "You close out a coding run. Be concise, factual, and decision-focused. Do not call tools.",
          messages: [{ role: "user", content: prompt, timestamp: Date.now() }],
        },
        {
          maxTokens: 1_500,
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
      for await (const event of source) {
        if (event.type === "text_delta") text += event.delta;
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
          // ledger write failure must not break the closing summary
        }
      }
      const final = text.trim() || assistantText(result).trim();
      recorder.event("closing_summary", {
        chars: final.length,
        stopReason: result.stopReason,
        ...(result.errorMessage ? { error: result.errorMessage } : {}),
        ...(final ? { text: final.slice(0, 2_000) } : {}),
      });
      return final;
    } catch (error) {
      recorder.event("closing_summary", {
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
  let interruptRequested = false;
  let finishRequested: FinishRequest | null = null;
  const controlTimer = setInterval(() => {
    const controlFile = join(recorder.dir, "control");
    try {
      if (!existsSync(controlFile)) return;
      const req = JSON.parse(readFileSync(controlFile, "utf8")) as { seq?: number; action?: string };
      if (typeof req.seq !== "number" || req.seq <= lastControlSeq) return;
      lastControlSeq = req.seq;
      recorder.event("control", { action: req.action, seq: req.seq });
      if (req.action === "prompt") {
        const rawPrompt = (req as { prompt?: unknown }).prompt;
        const prompt = typeof rawPrompt === "string" ? rawPrompt : "";
        if (prompt.trim()) {
          // Inject the prompt as a user message so the next request carries it
          // (same mechanism the gate-failure append uses below).
          const msgs = agent?.state.messages ?? carriedMessages ?? [];
          carriedMessages = [
            ...msgs,
            { role: "user", content: prompt, timestamp: Date.now() },
          ];
        }
      }
      if (req.action === "interrupt") {
        interruptRequested = true;
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

  /** Gate retries persist across provider rotations since the same run owns them. */
  let gateAttempts = 0;

  while (true) {
    // Reset per-attempt state. Turn and token budgets are per run, not per
    // provider attempt: a rate-limit rotation must not refill them.
    lastAssistant = undefined;
    budgetExhausted = false;
    fundsRetryArmed = false;
    let appliedError: { key: string; message: string } | undefined;
    let turnCapHit = false;
    let modelCallCapHit = false;

    /** Tool contract health: enough failures with no work is not "completed". */
    let toolErrors = 0;
    let substantiveSuccesses = 0;
    /** Tool calls whose raw arguments leaked XML attribute syntax. */
    const serializedArgCalls = new Set<string>();
    /** Successful tool call ids, to distinguish repaired args from a dead end. */
    const successfulToolCalls = new Set<string>();
    /** Set when the response hit the output limit; the next turn recovers with
     * a chunked-write instruction instead of stranding the model on a generic
     * "re-issue" error. */
    let truncationRecovery = false;
    /** Salvaged args of this turn's tool calls, so a cut write can be persisted. */
    const pendingToolArgs = new Map<string, unknown>();
    /** Fewest open plan steps seen so far; a decrease is real progress. */
    let openPlanSteps = Number.POSITIVE_INFINITY;
    /** Successful read-only command results for the current file state. */
    const commandCache = new Map<string, { epoch: number; turn: number; text: string; preview: string }>();
    /** Distinct successful inspect calls, for re-served evidence. Insertion
     * order is oldest first; re-asking refreshes recency. */
    // Seeds are the files this run edits: they stay in evidence for the whole
    // run even when the ledger is full, so the model never loses what it is
    // working on. Oldest non-seed entries go first.
    const evictOldest = (ledger: Map<string, RetainedCall>): void => {
      if (ledger.size < MAX_LEDGER_ENTRIES) return;
      for (const [key, call] of ledger) {
        if (call.seeded) continue;
        ledger.delete(key);
        return;
      }
    };
    const retained = new Map<string, RetainedCall>();
    /** Handles the model pruned: never re-served again this run. */
    const prunedEvidence = new Set<string>();
    const forgetEvidence = (handles: readonly string[]): number => {
      let removed = 0;
      for (const handle of handles) {
        for (const [key, call] of retained) {
          if (evidenceHandle(call) !== handle) continue;
          retained.delete(key);
          prunedEvidence.add(handle);
          removed += 1;
          break;
        }
      }
      return removed;
    };
    let changeEpoch = 0;
    /** Verbatim-retry escalation state (same tool+args+error across turns). */
    let lastFailSig = "";
    let identicalFailures = 0;
    /** Whether named code blocks have been extracted for the current turn. */
    let namedBlocksExtracted = false;

    // First selection up front.
    const first = selectFor(initialChars);
    if ("error" in first) {
      const error =
        triedModels.size > 0
          ? `all eligible models failed (${triedModels.size} tried); last error: ${lastFailure ?? first.error}`
          : first.error;
      recorder.event("model_select", { error, rejected: first.rejected, rejectedByReason: first.rejectedByReason });
      if (triedModels.size > 0 && freeRowsExhausted()) {
        const exhaustionError = freeExhaustionError();
        recorder.event("retry_exhausted", { tried: [...triedModels], lastError: lastFailure, lastErrorKind: lastErrorKind });
        clearInterval(heartbeatTimer); clearInterval(controlTimer); unregisterInstance(input.home);
        return { status: "blocked", finalText: "", error: exhaustionError };
      }
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
      lastErrorKind = "missing-runtime-model";
      if (freeRowsExhausted()) {
        const exhaustionError = freeExhaustionError();
        recorder.event("retry_exhausted", { tried: [...triedModels], lastError: lastFailure, lastErrorKind: lastErrorKind });
        clearInterval(heartbeatTimer); clearInterval(controlTimer); unregisterInstance(input.home);
        return { status: "blocked", finalText: "", error: exhaustionError };
      }
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

    const namedBlocksDir = join(input.root, ".machine_code", "blocks", recorder.id);
    const toolCtx: import("./tools/index.js").ToolContext = {
      root: input.toolRoot ?? input.root,
      commands: input.commands,
      tools: input.agent.tools,
      ask: askContext,
      skills: skillContext,
      state: memory,
      repoRoot: input.root,
      namedBlocksDir,
      runDir: recorder.dir,
      ...(issuePath ? { issuePath } : {}),
      forgetEvidence,
      finish: (result) => {
        finishRequested = result;
        recorder.event("finish", { outcome: result.outcome, summary: result.summary });
      },
      processes,
      allowMutations: (input.agentCapabilities ?? []).includes("code:write"),
      capabilities: input.agentCapabilities ?? [],
      allowedPaths: input.agent.allowedPaths,
    };
    const rawTools = coreTools(toolCtx, input.agent.tools);
    // Files the run is about ride in as native inspect pairs from turn 0: the
    // same shape as a live read, re-executed from disk each turn, so the model
    // sees current state instead of static context it may distrust. Long files
    // seed an outline — models read a wall of body as noise and search anyway.
    const seedCall = (path: string, index: number): RetainedCall => {
      let lines = 0;
      try {
        lines = readFileSync(join(input.root, path), "utf8").split("\n").length;
      } catch {
        lines = 0;
      }
      const short = lines > 0 && lines < SEED_BODY_LINES;
      return {
        id: `seed-${index + 1}`,
        tool: "inspect" as const,
        params: short ? { query: path } : { query: path, detail: "outline" },
        turn: 0,
        seeded: true,
      };
    };
    const seeded: RetainedCall[] = (input.seedEvidence ?? []).map(seedCall);
    for (const call of seeded) {
      const rawInspect = rawTools.find((t) => t.name === "inspect");
      const prepared = (rawInspect?.prepareArguments?.(call.params) ?? call.params) as Record<string, unknown>;
      call.params = prepared;
      retained.set(`inspect:${stableKey(prepared)}`, call);
    }
    // Rebuild the retained-call ledger from a resumed transcript so
    // re-served evidence covers pre-resume reads (turn unknown). Inspect
    // bodies and issue:show reads both re-serve; anything else is live
    // work, not reference.
    for (const message of input.initialMessages ?? []) {
      const content = (message as { content?: unknown }).content;
      if (!Array.isArray(content)) continue;
      for (const block of content) {
        if (!block || typeof block !== "object") continue;
        const b = block as { type?: unknown; id?: unknown; name?: unknown; arguments?: unknown };
        if (b.type !== "toolCall" || typeof b.id !== "string") continue;
        if (!b.arguments || typeof b.arguments !== "object") continue;
        try {
          let tool: "inspect" | "command" | null = null;
          let prepared: Record<string, unknown> | null = null;
          if (b.name === "inspect") {
            const rawInspect = rawTools.find((t) => t.name === "inspect");
            prepared = (rawInspect?.prepareArguments?.(b.arguments) ?? b.arguments) as Record<string, unknown>;
            tool = "inspect";
          } else if (b.name === "command") {
            const rawCommand = rawTools.find((t) => t.name === "command");
            const cleaned = (rawCommand?.prepareArguments?.(b.arguments) ?? b.arguments) as Record<string, unknown>;
            if (String(cleaned.action ?? "run") === "run" && String(cleaned.name ?? "") === "issue:show") {
              prepared = cleaned;
              tool = "command";
            }
          }
          if (!tool || !prepared) continue;
          const key = `${tool}:${stableKey(prepared)}`;
          const prior = retained.get(key);
          retained.delete(key);
          evictOldest(retained);
          retained.set(key, { id: b.id, tool, params: prepared, turn: null, ...(prior?.seeded ? { seeded: true } : {}) });
        } catch {
          // Unparseable history never blocks the run.
        }
      }
    }
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
          // Verbatim-retry escalation: the same tool+args failing with the
          // same error three turns running means the model is stuck, not
          // exploring (observed: identical edit/write args resubmitted 5-8x).
          // Not a gate — just a louder hint pointing at the way out.
          if (result.isError) {
            const errText = result.content
              .filter((item): item is { type: "text"; text: string } => item.type === "text")
              .map((item) => item.text)
              .join("\n");
            const failSig = `${key}::${errText.slice(0, 200)}`;
            if (failSig === lastFailSig) {
              identicalFailures += 1;
            } else {
              lastFailSig = failSig;
              identicalFailures = 1;
            }
            if (identicalFailures >= 3) {
              recorder.event("identical_failure", { tool: tool.name, count: identicalFailures });
              result.content.push({
                type: "text" as const,
                text: `[loop: this exact call failed ${identicalFailures} times with the same error. Stop resubmitting it — re-read the target first (inspect the file or symbol to see its current state), then change the approach.]`,
              });
            }
          } else {
            lastFailSig = "";
            identicalFailures = 0;
          }
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
          if (!result.isError && tool.name === "inspect") {
            const prior = retained.get(key);
            retained.delete(key);
            evictOldest(retained);
            retained.set(key, {
              id,
              tool: "inspect",
              params: params as Record<string, unknown>,
              turn: memory.currentTurn(),
              ...(prior?.seeded ? { seeded: true } : {}),
            });
          }
          // issue:show is the command-side equivalent of an inspect read:
          // read-only, deterministic, and re-shown constantly (observed: 27
          // re-shows of 5 issues in 99 turns). Retain it for re-serving;
          // every other command is live work, not reference.
          if (
            !result.isError &&
            tool.name === "command" &&
            commandAction === "run" &&
            commandName === "issue:show"
          ) {
            retained.delete(key);
            evictOldest(retained);
            retained.set(key, {
              id,
              tool: "command",
              params: params as Record<string, unknown>,
              turn: memory.currentTurn(),
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
        // The event keeps a bounded head preview so events.jsonl stays
        // greppable; the full prompt goes to prompts/ so the timeline can
        // load exactly what the model saw on demand (lazy, not per tick).
        let inputFile: string | undefined;
        if (requestText.length > MODEL_IO_CAP) {
          try {
            const promptsDir = join(recorder.dir, "prompts");
            mkdirSync(promptsDir, { recursive: true });
            let name = `call-${String(call).padStart(3, "0")}.txt`;
            for (let dup = 2; existsSync(join(promptsDir, name)); dup += 1) {
              name = `call-${String(call).padStart(3, "0")}-r${dup}.txt`;
            }
            writeFileSync(join(promptsDir, name), requestText, "utf8");
            inputFile = `prompts/${name}`;
          } catch {
            inputFile = undefined;
          }
        }
        const computedMaxTokens = requestedOutputTokens({
          contextWindowTokens: model.contextWindow,
          inputTokens: charsToTokens(requestText.length),
          modelMaxTokens: model.maxTokens,
          ...(ceiling !== undefined ? { ceiling } : {}),
        });
        const maxTokens =
          outputDownshift === undefined
            ? computedMaxTokens
            : Math.min(computedMaxTokens, outputDownshift);
        lastRequestedMaxTokens = maxTokens;
        recorder.event("model_request", {
          call,
          provider: model.provider,
          model: model.id,
          firstTokenTimeoutMs,
          maxTokens,
          messages: (context as Context).messages.length,
          chars: requestText.length,
          input:
            requestText.length > MODEL_IO_CAP
              ? requestText.slice(0, MODEL_IO_CAP) + "\n…[truncated]"
              : requestText,
          ...(inputFile ? { inputFile } : {}),
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
        /** Unbounded local (ollama) calls never set a first-token timer; a
         * queue wait is not an error. Remote calls keep the finite timer and
         * abandon on a stall, rotating to the next model as today. */
        const timer =
          firstTokenTimeoutMs === undefined
            ? undefined
            : setTimeout(() => {
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
        const { symbols: sBudget, state: stBudget } = computeBudgets(undefined, input.symbolsMaxChars);
        const tb = computeBudgets(lastBudget?.inputChars).transcript;
        return withRecordNudge(renderPromptMessages(
          messages,
          memory,
          mapIndex,
          input.contextText,
          undefined,
          commandIndex,
          sBudget,
          stBudget,
          pendingEvidence?.text ?? undefined,
          pendingEvidence?.messages,
          tb,
        ).messages);
      },
      prepareRequest: async ({ context }) => {
        const renderFor = async (row: CatalogueRow | null) => {
          const agentPolicy = input.fullPolicy?.agents?.[input.agent.name];
          const budget = row ? contextBudget(row.context, agentPolicy?.expectedOutputTokens ?? 16_000) : null;
          lastBudget = budget;

          // Unified budget pool: 90% of the model's input window covers
          // all variable context (symbols, map, context block, workspace,
          // state block).
          const budgets = computeBudgets(budget?.inputChars, input.symbolsMaxChars);
          lastSymbolsChars = budgets.symbols;
          // Deterministic fit for whole-file reads, refreshed per turn
          // from the same pool as every other share.
          toolCtx.maxWholeFileChars = budgets.wholeFile;

          // Re-render the map with the model-specific budget
          if (repoMap && budgets.map >= 1024) {
            mapIndex = renderMapIndex(repoMap, budgets.map);
          }

          // The context block gets the remaining pool (after symbols, map,
          // and state) minus a small overhead for the workspace diff (~2KB).
          const overviewMaxChars = Math.max(4_096, budgets.contextBlock - 2_048);
          const overviewBaseChars = input.contextText?.length ?? 0;
          lastOverviewChars = Math.min(overviewBaseChars, overviewMaxChars);

          // The last two steps replay in full; the symbol map plus notes
          // carry everything older worth keeping.
          const keptIds = keptToolCallIds(context.messages, budgets.transcript);
          // Seeds lead: they are the files this run edits, so budget
          // pressure drops incidental reads before them.
          const allRetained = [...retained.values()];
          const ordered = [
            ...allRetained.filter((call) => call.seeded),
            ...allRetained.filter((call) => !call.seeded).reverse(),
          ];
          const rawInspect = rawTools.find((t) => t.name === "inspect");
          const rawCommand = rawTools.find((t) => t.name === "command");
          const freshDiff = async (): Promise<string> => {
            const parts: string[] = [];
            try {
              const result = await runCommand("core:diff", {}, {
                root: input.toolRoot ?? input.root,
                commands: input.commands,
                processes,
              });
              if (!result.isError && result.text.trim()) parts.push(result.text.trim());
            } catch {
              // A failed worktree diff never blocks the issue list.
            }
            // Issue files live outside git history (gitignored) — append this
            // run's changed issues so the diff the agent sees covers its work.
            const issues = changedIssuesText(input.root, recorder.dir);
            if (issues) parts.push(issues);
            return parts.join("\n\n");
          };
          pendingEvidence = await buildEvidence({
            retained: ordered,
            inspect: rawInspect,
            command: rawCommand,
            diff: freshDiff,
            keptIds,
            maxChars: budgets.evidence,
            dropped: prunedEvidence,
          });
          const _rendered = renderPromptMessages(
            context.messages,
            memory,
            mapIndex,
            input.contextText,
            overviewMaxChars,
            commandIndex,
            budgets.symbols,
            budgets.state,
            pendingEvidence?.text ?? undefined,
            pendingEvidence?.messages,
            budgets.transcript,
          );
          return { ..._rendered, messages: withRecordNudge(_rendered.messages) };
        };

        let rendered = await renderFor(currentRow);
        pendingMessages = rendered.messages;
        lastPromptChars = rendered.chars;
        let chars = rendered.chars + toolChars;
        lastRequestChars = chars;
        recorder.recordContext(chars);
        const agentPolicy = input.fullPolicy?.agents?.[input.agent.name];
        const estimate = estimateTokens(chars, agentPolicy?.expectedOutputTokens ?? 16_000);
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
        rendered = await renderFor(currentRow);
        pendingMessages = rendered.messages;
        lastPromptChars = rendered.chars;
        chars = rendered.chars + toolChars;
        lastRequestChars = chars;
        recorder.recordContext(chars);
        recorder.event("model_select", {
          call: callIndex,
          key: currentRow.key,
          estimate: estimateTokens(chars, (input.fullPolicy?.agents?.[input.agent.name])?.expectedOutputTokens ?? 16_000),
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
      prepareNextTurn: async () => {
        // A truncated response is a checkpoint, not a dead end. The tool calls
        // in it did not run (pi-agent-core fails them all), so the only useful
        // next move is the remaining work, in chunks that fit the budget.
        if (truncationRecovery) {
          truncationRecovery = false;
          continuePromptArmed = false;
          return {
            messages: [
              {
                role: "user",
                content:
                  "Your last response hit the output-token limit, so none of its tool calls ran and nothing was written. " +
                  "Continue the work now. For a large file, call write with the first chunk, then call write again with append=true for each remaining chunk; " +
                  "keep each call comfortably under the response budget. Do not re-emit a whole large file in one call.",
                timestamp: Date.now(),
              } as unknown as import("@earendil-works/pi-agent-core").AgentMessage,
            ],
          };
        }
        // Consume the reprompt armed by a text-only turn (see finishTurn):
        // the model stopped without a tool call or finish, so hand it the
        // rule in plain words and let the next provider request continue.
        if (!continuePromptArmed) return undefined;
        continuePromptArmed = false;
        return {
          messages: [
            {
              role: "user",
              content:
                "You stopped without a tool call or finish, so the run cannot advance. " +
                "Continue now with one of: a context note, a plan update, an edit, a write, or finish. " +
                "Do not answer in prose alone — text without a call ends the run.",
              timestamp: Date.now(),
            } as unknown as import("@earendil-works/pi-agent-core").AgentMessage,
          ],
        };
      },
      finishTurn: async ({ message }) => {
        turns += 1;
        reportedTurns += 1;
        recorder.recordTurn(reportedTurns);
        if (finishRequested) return { action: "end" as const };
        const usage = message.usage ?? zeroUsage;
        totalTokens += usage.totalTokens;
        const agentPol = input.fullPolicy?.agents?.[input.agent.name];
        if (agentPol?.budgetTokens !== undefined && totalTokens > agentPol.budgetTokens) {
          budgetExhausted = true;
          recorder.event("budget_exhausted", { totalTokens, budget: agentPol.budgetTokens });
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
        // Model call cap: prevent runaway costs. Check after the turn cap so
        // the more specific limit fires first. The cap is against the
        // recorder's cumulative count so it spans provider retries too.
        const maxCalls = input.maxCalls ?? MAX_CALLS;
        if (maxCalls > 0 && recorder.current.modelCalls >= maxCalls) {
          const wantsMore = message.content.some((block) => block.type === "toolCall");
          if (wantsMore) {
            modelCallCapHit = true;
            recorder.event("model_call_cap", { calls: recorder.current.modelCalls, maxCalls });
            return { action: "end" as const };
          }
        }
        const hasCalls = message.content.some((block) => block.type === "toolCall");
        // A truncated response never ends the run on a dead-end error: the
        // recovery message in prepareNextTurn asks for the remainder in
        // chunks. This is a continuation, not a repetition guard.
        if (message.stopReason === "length" && !finishRequested) {
          truncationRecovery = true;
          textOnlyStreak = 0;
          recorder.event("output_truncation_continue", { turn: turns });
          if (!hasCalls) return { action: "continue" as const };
        }
        // A text-only turn on a run that owes a change is not an ending —
        // the model stopped mid-thought (observed: a 5-turn run that died
        // mid-plan with prose and no call). Reprompt boundedly and continue;
        // past the cap the run ends and the blocked handling below applies.
        // Pure-question runs are exempt: prose is their deliverable.
        if (!hasCalls && !finishRequested && wantsChange) {
          textOnlyStreak += 1;
          if (textOnlyStreak <= MAX_TEXT_ONLY_CONTINUES) {
            continuePromptArmed = true;
            recorder.event("text_only_continue", { streak: textOnlyStreak });
            return { action: "continue" as const };
          }
        } else if (hasCalls) {
          textOnlyStreak = 0;
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
            // A turn counts as progress when it edits, writes, finishes, or
            // closes a plan step. A note is not progress: rewarding repeated
            // notes is what let one run re-read the same files for hours.
            const turnCalls = message.content.filter((block) => block.type === "toolCall");
            const recorded = turnCalls.some((block) => {
              if (block.type !== "toolCall") return false;
              if (block.name === "edit" || block.name === "write" || block.name === "finish") return true;
              if (block.name !== "context") return false;
              const args = block.arguments as { action?: unknown; steps?: unknown } | undefined;
              if (args?.action !== "plan" || !Array.isArray(args.steps)) return false;
              const open = args.steps.filter((step) => {
                if (!step || typeof step !== "object") return true;
                return (step as { done?: unknown }).done !== true;
              }).length;
              if (open < openPlanSteps) {
                openPlanSteps = open;
                return true;
              }
              openPlanSteps = open;
              return false;
            });
            if (recorded) readOnlyStreak = 0;
            else if (turnCalls.length > 0) readOnlyStreak += 1;
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
              symbolsChars: lastSymbolsChars,
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
              estimateCallCost(currentRow!.pricing, usage.input, Math.max(usage.output, (input.fullPolicy?.agents?.[input.agent.name])?.expectedOutputTokens ?? 16_000)) *
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
            // Skipped when the user stopped the run: an interrupt is not a
            // model failure and must not record any exclusion.
            if (message.stopReason === "error" && message.errorMessage && !interruptRequested && !cancelRequested && !pauseRequested) {
              try {
                const classified = classifyError(new Error(message.errorMessage));
                const provider = message.provider;
                const key = currentRow?.key ?? `${provider}/${message.model}`;
                // A funds error is an account condition, not a bad model or a
                // bad request. Before excluding the provider, shrink the
                // response budget and retry the same route: the flat output cap
                // existed only because a large `max_tokens` can fail the
                // provider's balance check.
                if (classified.kind === "funds" && outputDownshifts < 2) {
                  outputDownshifts += 1;
                  // The observed threshold is that 32k fails and 16k fits, so
                  // step straight to the affordable band before halving again.
                  const base = outputDownshift ?? lastRequestedMaxTokens ?? 32_000;
                  outputDownshift = Math.max(2_000, Math.floor(Math.min(base, 32_000) / 2));
                  fundsRetryArmed = true;
                  appliedError = { key, message: message.errorMessage };
                  lastErrorKind = classified.kind;
                  recorder.event("output_downshift", {
                    reason: classified.kind,
                    maxTokens: outputDownshift,
                    attempt: outputDownshifts,
                  });
                } else {
                  applyErrorState(provider, key, classified);
                  appliedError = { key, message: message.errorMessage };
                  lastErrorKind = classified.kind;
                }
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
            if (message.stopReason === "length") {
              // The response was cut by the output budget. The library will
              // fail every tool call in it; keep the salvaged arguments so the
              // recovery turn can point at them, and record the event.
              const saved: string[] = [];
              try {
                const dir = join(recorder.dir, "pending");
                mkdirSync(dir, { recursive: true });
                for (const [id, args] of pendingToolArgs) {
                  const name = `${id.replace(/[^A-Za-z0-9_-]+/g, "_").slice(0, 80)}.json`;
                  writeFileSync(join(dir, name), JSON.stringify(args, null, 2), "utf8");
                  saved.push(name);
                }
              } catch {
                // Persisting a cut call must never break the run.
              }
              recorder.event("output_truncated", {
                outputTokens: usage.output,
                calls: pendingToolArgs.size,
                saved,
              });
            }
            pendingToolArgs.clear();
          }
          break;
        }
        case "tool_execution_start": {
          if (looksLikeSerializedArgs(event.args)) serializedArgCalls.add(event.toolCallId);
          // Keep the salvaged arguments in memory; only a truncated turn
          // persists them, but the event arrives before we know that.
          if (event.args !== undefined) pendingToolArgs.set(event.toolCallId, event.args);
          recorder.event("tool_call_start", {
            toolCallId: event.toolCallId,
            tool: event.toolName,
            ...(event.args !== undefined ? { args: capJson(event.args) } : {}),
          });
          // Extract named code blocks from the assistant message before any tool
          // executes. These blocks let the model write code with backslashes and
          // quotes as plain fenced text — no JSON escaping needed. Tools reference
          // them via *_named_block fields. The assistant text for this turn is
          // only available once; extract on the first tool execution.
          if (!namedBlocksExtracted) {
            namedBlocksExtracted = true;
            const text = assistantText(lastAssistant);
            const blocks = extractNamedBlocks(text);
            if (blocks.length > 0) {
              const blockDir = join(input.root, ".machine_code", "blocks", recorder.id);
              writeNamedBlocks(blocks, blockDir);
              recorder.event("named_blocks_extracted", {
                count: blocks.length,
                names: blocks.map((b) => b.name),
                dir: blockDir,
              });
            }
          }
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
      if (!cancelRequested && !pauseRequested && !interruptRequested && !input.signal?.aborted) {
        try {
          const classified = classifyError(new Error(message));
          recorder.event("error_classified", {
            kind: classified.kind,
            target: classified.target,
            retryable: classified.retryable,
            disableProvider: classified.disableProvider,
            needsAuth: classified.needsAuth,
          });
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
            lastErrorKind = classified.kind;
            if (freeRowsExhausted()) {
              const exhaustionError = freeExhaustionError();
              recorder.event("retry_exhausted", { tried: [...triedModels], lastError: lastFailure, lastErrorKind: lastErrorKind });
              clearInterval(heartbeatTimer); clearInterval(controlTimer); unregisterInstance(input.home);
              return { status: "blocked", finalText: "", error: exhaustionError };
            }
            recorder.event("retry", {
              failedModel: failedKey || "(unknown)",
              kind: classified.kind,
              attempt: triedModels.size,
            });
            continue;
          }
          if (isFreeMode() && currentRow && isFreeRow(currentRow) && (classified.kind === "auth" || (classified.kind === "missing-model" && classified.permanent === true))) {
            const freeProvider = currentRow?.providerID ?? "";
            const freeFailedKey = currentRow?.key ?? "";
            if (freeProvider && freeFailedKey) {
              try {
                applyErrorState(freeProvider, freeFailedKey, classified);
              } catch {
                // availability write failure must not stop rotation
              }
              triedModels.add(freeFailedKey);
            }
            relaxPin(freeFailedKey, freeProvider);
            lastFailure = message;
            lastErrorKind = classified.kind;
            if (freeRowsExhausted()) {
              const exhaustionError = freeExhaustionError();
              recorder.event("retry_exhausted", { tried: [...triedModels], lastError: lastFailure, lastErrorKind: lastErrorKind });
              clearInterval(heartbeatTimer); clearInterval(controlTimer); unregisterInstance(input.home);
              return { status: "blocked", finalText: "", error: exhaustionError };
            }
            recorder.event("retry", {
              failedModel: freeFailedKey || "(unknown)",
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
      if (interruptRequested || input.signal?.aborted) return { status: "interrupted", finalText: "" };
      return { status: "failed", finalText: "", error: message };
    } finally {
      input.signal?.removeEventListener("abort", onExternalAbort);
    }

    // --- Determine the agent's reported status ---
    // The finish-tool path and the natural-stop path converge into a single
    // status variable so that gates (below) can intercept "completed" and
    // either drive a repair iteration or fall through to the final return.

    const finished = finishRequested as FinishRequest | null;
    let finalText: string;
    let status: RunLoopResult["status"];
    let error: string | undefined;
    // lastGateFailure is set below when gate attempts exhaust; the caller
    // uses it to write the failure log into the issue file.
    let lastGateFailure: string | undefined;

    if (finished) {
      // The finish tool reported an outcome directly.
      status = finished.outcome;
      finalText = finished.summary;
      // Do not return yet — gates may intercept "completed".
    } else {
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
        lastErrorKind = "malformed";
        if (freeRowsExhausted()) {
          const exhaustionError = freeExhaustionError();
          recorder.event("retry_exhausted", { tried: [...triedModels], lastError: lastFailure, lastErrorKind: lastErrorKind });
          clearInterval(heartbeatTimer); clearInterval(controlTimer); unregisterInstance(input.home);
          return { status: "blocked", finalText: "", error: exhaustionError };
        }
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
      finalText = assistantText(la2);
      const stop = la2?.stopReason;
      status = "completed";
      if (cancelRequested) {
        status = "cancelled";
      } else if (pauseRequested) {
        status = "paused";
      } else if (interruptRequested || input.signal?.aborted) {
        status = "interrupted";
      } else if (budgetExhausted) {
        status = "blocked";
        error = `token budget exhausted (${(input.fullPolicy?.agents?.[input.agent.name])?.budgetTokens ?? "unknown"})`;
      } else if (turnCapHit) {
        status = "blocked";
        error = `turn cap reached (${maxTurns}) before the run finished`;
      } else if (modelCallCapHit) {
        status = "blocked";
        error = `model call cap reached (${input.maxCalls ?? MAX_CALLS}) before the run finished`;
      } else if (stop === "aborted") {
        status = "interrupted";
      } else if (stop === "error") {
        status = "failed";
        error = la2?.errorMessage ?? "provider error";
      }

      if (!finalText.trim() && currentModel && (turnCapHit || budgetExhausted || modelCallCapHit)) {
        const reason = modelCallCapHit
          ? "You have reached the model call cap."
          : turnCapHit
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
    }

    // ---- Acceptance gates: run when the agent thinks it is done ----
    // If the gates pass the run completes normally. If they fail, the gate
    // output is fed back to the model as a new context message and the loop
    // continues — all in the same run, with the same conversation.
    const gates = input.gates;
    const maxGateAttempts = input.maxGateAttempts ?? MAX_GATE_ATTEMPTS;
    if (status === "completed" && gates && gates.length > 0) {
      gateAttempts += 1;

      const gateRoot = input.toolRoot ?? input.root;
      // vcs:sync is runner-owned: add it only to the gate command map so the
      // agent can resolve conflicts but cannot start merges on its own.
      // Project scripts also resolve only here: the model's map deliberately
      // excludes script:* (models never run repo scripts), but gates must
      // still find script:build / script:test for the acceptance run.
      const gateCommands = new Map(input.commands);
      gateCommands.set(vcsSyncCommand.name, vcsSyncCommand);
      try {
        const { scriptCommands } = await import("./commands/scripts.js");
        for (const [name, spec] of scriptCommands(gateRoot)) gateCommands.set(name, spec);
      } catch {
        // No scripts dir: gates referencing script:* fail with unknown
        // command, the same as a missing script anywhere else.
      }
      const gateResult = await runGates(gates, {
        root: gateRoot,
        repoRoot: input.root,
        runDir: recorder.dir,
        commands: gateCommands,
      });
      recorder.event("gates", {
        attempt: gateAttempts,
        passed: gateResult.passed,
        results: gateResult.results.map((r) => ({ command: r.command, passed: r.passed, durationMs: r.durationMs })),
      });

      if (gateResult.passed) {
        // Gates passed — fall through to the final return.
      } else if (gateAttempts < maxGateAttempts) {
        // Gates failed but we have retries left. Feed the failure output
        // back to the model as a new user message and continue the loop.
        const failure = gateFailureText(gateResult.results);
        // Name what DID pass so the model can tell its breakage from the
        // runner's: a sync-merge success means later logs ran on the merged
        // tree; a sync failure means later gates were skipped, not green.
        const passed = gateResult.results
          .filter((r) => r.passed)
          .map((r) => `- ${r.command}: ${r.output.trim().split("\n")[0]?.slice(0, 160) ?? ""}`)
          .join("\n");
        const skipped = gateResult.results.some((r) => !r.passed && (gates.find((g) => g.command === r.command)?.stopOnFailure))
          ? "Later gates were skipped (they only run on a synced tree), not passed."
          : "";
        const gateMsg =
          `## Acceptance gates failed (attempt ${gateAttempts}/${maxGateAttempts})\n\n` +
          `Your previous \`finish\` call is superseded — the run continues. Fix the code so the gates pass, then call \`finish\` again.\n\n` +
          `${failure}\n\n` +
          (passed ? `Already passing this attempt:\n${passed}\n\n` : "") +
          (skipped ? `${skipped}\n\n` : "") +
          `Do not call \`finish\` with outcome=completed until all acceptance gates pass.`;
        // The previous finish is superseded: clear it so the next attempt
        // does not end on its first turn via finishTurn. The gate message
        // above re-arms the model to keep fixing and finish again.
        finishRequested = null;
        // Save the conversation and append the gate failure as a user message
        // so the next iteration sees the context.
        const msgs = agent?.state.messages ?? carriedMessages ?? [];
        carriedMessages = [
          ...msgs,
          { role: "user", content: gateMsg, timestamp: Date.now() },
        ];
        lastFailure = `gates failed (attempt ${gateAttempts})`;
        recorder.event("gate_retry", { attempt: gateAttempts, maxAttempts: maxGateAttempts, failure: failure.slice(0, 500) });
        continue;
      } else {
        // Gates exhausted — block the run with the last failure. Name the
        // failed commands AND the tail of their output: command names alone
        // ("vcs:sync") never say which files conflicted.
        lastGateFailure = gateFailureText(gateResult.results);
        const failedNames = gateResult.results.filter((r) => !r.passed).map((r) => r.command).join(", ");
        status = "blocked";
        error = `acceptance gates failed after ${maxGateAttempts} attempts: ${failedNames}\n${lastGateFailure.slice(0, 800)}`;
        finalText = finalText || "";
      }
    }

    // Retry decision: rotate to the next eligible model on a retryable error.
    // Only reached when gates are not applicable or have already been handled.
    const la = lastAssistant as AssistantMessage | undefined;
    if (status === "failed" && la?.errorMessage && !interruptRequested && !cancelRequested && !pauseRequested && !input.signal?.aborted) {
      let classified: ReturnType<typeof classifyError> | undefined;
      try {
        classified = classifyError(new Error(la.errorMessage));
      } catch {
        // classification failure falls through to the ordinary failure path
      }
      if (fundsRetryArmed) {
        fundsRetryArmed = false;
        // Keep the same model eligible: the request shrank, so the account
        // check may now pass. Do not add it to `triedModels`.
        carriedMessages = agent?.state.messages ?? carriedMessages;
        lastFailure = la.errorMessage;
        lastErrorKind = "funds";
        recorder.event("retry", {
          failedModel: currentRow?.key ?? `${la.provider}/${la.model}`,
          kind: "funds-downshift",
          attempt: outputDownshifts,
          maxTokens: outputDownshift,
          carriedMessages: carriedMessages?.length ?? 0,
        });
        continue;
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
        lastErrorKind = classified.kind;
        if (freeRowsExhausted()) {
          const exhaustionError = freeExhaustionError();
          recorder.event("retry_exhausted", { tried: [...triedModels], lastError: lastFailure, lastErrorKind: lastErrorKind });
          clearInterval(heartbeatTimer); clearInterval(controlTimer); unregisterInstance(input.home);
          return { status: "blocked", finalText: "", error: exhaustionError };
        }
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
      if (isFreeMode() && currentRow && isFreeRow(currentRow) && classified !== undefined && !classified.retryable && (classified.kind === "auth" || (classified.kind === "missing-model" && classified.permanent === true))) {
        const authFailedKey = currentRow?.key ?? la.provider + "/" + la.model;
        if (!appliedError || appliedError.key !== authFailedKey || appliedError.message !== la.errorMessage) {
          try {
            applyErrorState(la.provider, authFailedKey, classified);
          } catch {
            // availability write failure must not stop rotation
          }
        }
        const authFailedModel = currentRow?.key ?? authFailedKey;
        triedModels.add(authFailedModel);
        relaxPin(authFailedModel, la.provider);
        lastFailure = la.errorMessage;
        lastErrorKind = classified.kind;
        if (freeRowsExhausted()) {
          const exhaustionError = freeExhaustionError();
          recorder.event("retry_exhausted", { tried: [...triedModels], lastError: lastFailure, lastErrorKind: lastErrorKind });
          clearInterval(heartbeatTimer); clearInterval(controlTimer); unregisterInstance(input.home);
          return { status: "blocked", finalText: "", error: exhaustionError };
        }
        carriedMessages = agent?.state.messages ?? carriedMessages;
        recorder.event("retry", {
          failedModel: authFailedModel,
          kind: classified.kind,
          attempt: triedModels.size,
          carriedMessages: carriedMessages?.length ?? 0,
        });
        continue;
      }
    }

    clearInterval(heartbeatTimer); clearInterval(controlTimer); unregisterInstance(input.home);
    // Gates passed (or none ran) and the run completed: ask the run's model
    // for the decisions+work closing summary. One bounded tool-free call; on
    // any failure the finish-tool receipt stands.
    if (status === "completed" && currentModel) {
      try {
        const closing = await closingSummary(currentModel);
        if (closing.trim()) finalText = closing;
      } catch {
        // closing summary must never fail a completed run
      }
    }
    return { status, finalText, error, ...(lastGateFailure ? { lastGateFailure } : {}) };
  }
}
