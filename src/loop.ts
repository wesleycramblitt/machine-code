/**
 * machine_code — the local `Loop` interface: a thin wrapper over pi-agent-core.
 *
 * Selection happens per provider call in prepareRequest: estimate context
 * size, run pick(), log the selection, and hand the loop the chosen model.
 * No stickiness — every call is selected and logged independently.
 *
 * Retry: a retryable provider error (rate limit, outage, malformed) gets at
 * most ONE bounded fallback retry on a different model. Insufficient funds,
 * auth failures, and refusals do not retry.
 */
import { Agent, type AgentMessage } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream, type AssistantMessage, type AssistantMessageEvent, type Context, type Message, type Usage } from "@earendil-works/pi-ai";
import { effectiveOutputCeiling, type MachineConfig, type AgentPolicy, type Policy } from "./config.js";
import { estimateCallCost } from "./catalogue/scoring.js";
import { pick, providerMultiplier } from "./select.js";
import { fundedProviderIds } from "./data.js";
import type { CatalogueRow } from "./catalogue/types.js";
import type { AgentDef, AgentName } from "./agents.js";
import type { MutableModels } from "./models.js";
import { coreTools } from "./tools/index.js";
import type { AgentConfig } from "./agents/config.js";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Layout } from "./paths.js";
import type { RunRecorder } from "./state/runs.js";

export const MAX_TURNS = 25;

/** Cap a JSON value for the event log: 2 KiB string budget, shallow-safe. */
function capJson(value: unknown): unknown {
  try {
    const s = JSON.stringify(value);
    if (s === undefined) return String(value).slice(0, 256);
    if (s.length <= 2048) return value;
    return { truncated: true, preview: s.slice(0, 2048) + "…" };
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

function contextChars(messages: readonly AgentMessage[]): number {
  let total = 0;
  for (const m of messages) total += JSON.stringify(m).length;
  return total;
}

const TOOL_SCHEMA_CHARS = 1_500;

function assistantText(message: AssistantMessage | undefined): string {
  if (!message) return "";
  return message.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("\n");
}

export async function runLoop(input: RunLoopInput): Promise<RunLoopResult> {
  const { recorder } = input;
  const policy = input.policy;
  const ceiling = effectiveOutputCeiling(policy, input.machine);
  const configuredProviders = input.configuredProviders;
  const fundedProviders = fundedProviderIds(input.machine.providers);

  const selectFor = (chars: number) =>
    pick({
      agent: input.agent.name,
      policy,
      machine: input.machine,
      catalogue: input.catalogue,
      configuredProviders,
      availability: input.availability,
      fundedProviders,
      contextChars: chars,
      requireProvider: input.requireProvider,
      requireModel: input.requireModel,
    });

  const initialChars = input.agent.prompt.length + input.request.length + 2_000;

  const zeroUsage: Usage = {
    input: 0, output: 0, cacheRead: 0, cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };

  let retried = false;
  let lastAssistant: AssistantMessage | undefined;
  let totalTokens = 0;
  let turns = 0;
  let budgetExhausted = false;
  let currentRow: CatalogueRow | null = null;
  let agent: Agent | undefined;

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
    // Reset per-attempt state.
    lastAssistant = undefined;
    totalTokens = 0;
    turns = 0;
    budgetExhausted = false;

    // First selection up front.
    const first = selectFor(initialChars);
    if ("error" in first) {
      recorder.event("model_select", { error: first.error, rejected: first.rejected });
      clearInterval(heartbeatTimer); clearInterval(controlTimer); unregisterInstance(input.home);
      return { status: "failed", finalText: "", error: first.error };
    }
    currentRow = first.selected;
    const firstModel = input.models.getModel(currentRow.providerID, currentRow.id);
    if (!firstModel) {
      const error = `catalogue row ${currentRow.key} is not in the provider's runtime catalog; run: machine_code catalogue refresh`;
      recorder.event("model_select", { call: 0, error });
      clearInterval(heartbeatTimer); clearInterval(controlTimer); unregisterInstance(input.home);
      return { status: "failed", finalText: "", error };
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
    const taskContext =
      input.layout && input.fullPolicy && input.agent.tools.includes("task")
        ? {
            layout: input.layout,
            recorder,
            parentRole: input.agent.name,
            parentCapabilities: input.agentCapabilities ?? [],
            parentConfig: input.agentConfig,
            machine: input.machine,
            policy: input.fullPolicy,
            models: input.models,
            catalogue: input.catalogue,
            configuredProviders: input.configuredProviders,
            commands: input.commands,
            root: input.root,
            toolRoot: input.toolRoot ?? input.root,
            home: input.home,
            requireModel: input.requireModel,
            signal: input.signal,
          }
        : undefined;

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
        defaultApproval: input.agentConfig?.approval ?? "human",
      };
    }

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

    agent = new Agent({
      initialState: {
        model: currentModel,
        thinkingLevel: "low",
        systemPrompt: input.agent.prompt,
        tools: coreTools(
          {
            root: input.toolRoot ?? input.root,
            commands: input.commands,
            ask: askContext,
            task: taskContext,
            issues: issueContext,
            prs: prContext,
          },
          input.agent.tools,
        ),
        ...(input.initialMessages && input.initialMessages.length > 0 ? { messages: input.initialMessages } : {}),
      },
      sessionId: recorder.id,
      convertToLlm,
      streamFn: (model, context, options) => {
        const source = input.models.stream(model, context as Context, {
          ...options,
          maxTokens:
            ceiling === undefined
              ? model.maxTokens > 0
                ? model.maxTokens
                : undefined
              : Math.min(ceiling, model.maxTokens > 0 ? model.maxTokens : ceiling),
          identity: {
            userAgent: { custom: "machine_code/0.0.0" },
            attribution: { name: "machine_code", url: "https://github.com/extropian/machine-code" },
          },
        });
        // Mirror text/thinking deltas into the event log so the run detail
        // screen can show live reasoning without a second provider stream.
        const wrapped = createAssistantMessageEventStream();
        const call = callIndex;
        let text = "";
        let thinking = "";
        let lastFlush = Date.now();
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
        void (async () => {
          try {
            for await (const event of source) {
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
            flush();
            wrapped.end(result);
          } catch {
            flush();
            wrapped.end();
          }
        })();
        return wrapped;
      },
      prepareRequest: ({ context }) => {
        const chars =
          contextChars(context.messages) +
          input.agent.prompt.length +
          input.agent.tools.length * TOOL_SCHEMA_CHARS;
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
        const usage = message.usage ?? zeroUsage;
        totalTokens += usage.totalTokens;
        if (policy.budgetTokens !== undefined && totalTokens > policy.budgetTokens) {
          budgetExhausted = true;
          recorder.event("budget_exhausted", { totalTokens, budget: policy.budgetTokens });
          return { action: "end" as const };
        }
        if (turns >= MAX_TURNS) {
          recorder.event("turn_cap", { turns });
          return { action: "end" as const };
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
              cost: typeof actual === "number" && Number.isFinite(actual) ? actual : null,
              durationMs: message.durationMs ?? null,
              ...(message.errorMessage ? { error: message.errorMessage } : {}),
              ...(turnText ? { text: turnText.length > 4000 ? turnText.slice(0, 4000) + "\n…[truncated]" : turnText } : {}),
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
                const { classifyError, applyClassification, loadAvailability, saveAvailability } = await import("./availability.js");
                const classified = classifyError(new Error(message.errorMessage));
                const state = loadAvailability(input.home);
                const provider = message.provider;
                const key = `${provider}/${message.model}`;
                applyClassification(state, provider, key, classified);
                saveAvailability(input.home, state);
                // mirror into the in-memory state used by this run
                if (input.availability) {
                  Object.assign(input.availability, state);
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
        const promptText = input.contextText ? `${input.contextText}\n\n${input.request}` : input.request;
        await agent.prompt(promptText);
      }
      await agent.waitForIdle();
    } catch (error) {
      input.signal?.removeEventListener("abort", onExternalAbort);
      clearInterval(heartbeatTimer); clearInterval(controlTimer); unregisterInstance(input.home);
      return { status: "failed", finalText: "", error: (error as Error).message };
    } finally {
      input.signal?.removeEventListener("abort", onExternalAbort);
    }

    const la2 = lastAssistant as AssistantMessage | undefined;
    const finalText = assistantText(la2);
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
    } else if (stop === "aborted") {
      status = "interrupted";
    } else if (stop === "error") {
      status = "failed";
      error = la2?.errorMessage ?? "provider error";
    }

    // Retry decision: at most one bounded fallback on a retryable error.
    const la = lastAssistant as AssistantMessage | undefined;
    if (status === "failed" && !retried && la?.errorMessage) {
      try {
        const { classifyError, loadAvailability } = await import("./availability.js");
        const classified = classifyError(new Error(la.errorMessage));
        if (classified.retryable) {
          retried = true;
          recorder.event("retry", { failedModel: `${la.provider}/${la.model}`, kind: classified.kind });
          continue; // retry with a fresh agent; the cooled target is now excluded
        }
      } catch {
        // fall through to return
      }
    }

    clearInterval(heartbeatTimer); clearInterval(controlTimer); unregisterInstance(input.home);
    return { status, finalText, error };
  }
}
