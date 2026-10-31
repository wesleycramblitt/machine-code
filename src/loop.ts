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
import type { AssistantMessage, Context, Message, Usage } from "@earendil-works/pi-ai";
import { effectiveOutputCeiling, type MachineConfig, type AgentPolicy } from "./config.js";
import { estimateCallCost } from "./catalogue/scoring.js";
import { pick } from "./select.js";
import type { CatalogueRow } from "./catalogue/types.js";
import type { AgentDef } from "./agents.js";
import type { MutableModels } from "./models.js";
import { coreTools } from "./tools/index.js";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RunRecorder } from "./state/runs.js";

export const MAX_TURNS = 25;

export interface RunLoopInput {
  models: MutableModels;
  catalogue: readonly CatalogueRow[];
  configuredProviders: ReadonlySet<string>;
  agent: AgentDef;
  policy: AgentPolicy;
  machine: MachineConfig;
  request: string;
  root: string;
  home: string;
  availability?: import("./availability.js").AvailabilityState;
  recorder: RunRecorder;
  commands: ReadonlyMap<string, import("./commands/registry.js").CommandSpec>;
  requireProvider?: string;
  signal?: AbortSignal;
}

export interface RunLoopResult {
  status: "done" | "blocked" | "failed" | "interrupted";
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

  const selectFor = (chars: number) =>
    pick({
      agent: input.agent.name,
      policy,
      machine: input.machine,
      catalogue: input.catalogue,
      configuredProviders,
      availability: input.availability,
      contextChars: chars,
      requireProvider: input.requireProvider,
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
  const controlTimer = setInterval(() => {
    const controlFile = join(recorder.dir, "control");
    try {
      if (!existsSync(controlFile)) return;
      const req = JSON.parse(readFileSync(controlFile, "utf8")) as { seq?: number; action?: string };
      if (typeof req.seq !== "number" || req.seq <= lastControlSeq) return;
      lastControlSeq = req.seq;
      if (req.action === "interrupt" || req.action === "cancel") {
        recorder.event("control", { action: req.action, seq: req.seq });
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

    agent = new Agent({
      initialState: {
        model: currentModel,
        thinkingLevel: "low",
        systemPrompt: input.agent.prompt,
        tools: coreTools({ root: input.root, commands: input.commands }, input.agent.tools),
      },
      sessionId: recorder.id,
      convertToLlm,
      streamFn: (model, context, options) =>
        input.models.stream(model, context as Context, {
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
        }),
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
            recorder.event("model_call_end", {
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
            });
            const estimatedCost = estimateCallCost(currentRow!.pricing, usage.input, Math.max(usage.output, policy.expectedOutputTokens));
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
                const { classifyError, loadAvailability, saveAvailability, coolModel, coolProvider, disableProvider, markNeedsAuth } = await import("./availability.js");
                const classified = classifyError(new Error(message.errorMessage));
                const state = loadAvailability(input.home);
                const provider = message.provider;
                const key = `${provider}/${message.model}`;
                if (classified.disableProvider) disableProvider(state, provider);
                if (classified.needsAuth) markNeedsAuth(state, provider);
                if (classified.target === "model" && classified.cooldownMs > 0) coolModel(state, key, classified.cooldownMs);
                if (classified.target === "provider" && classified.cooldownMs > 0) coolProvider(state, provider, classified.cooldownMs);
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
        case "tool_execution_end": {
          recorder.event("tool_call", {
            tool: event.toolName,
            isError: event.isError,
            durationMs: event.durationMs ?? null,
          });
          break;
        }
        default:
          break;
      }
    });

    try {
      await agent.prompt(input.request);
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
    let status: RunLoopResult["status"] = "done";
    let error: string | undefined;
    if (input.signal?.aborted) {
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
          const state = loadAvailability(input.home);
          const key = `${la.provider}/${la.model}`;
          const cooled = state.models[key]?.cooldownUntil && state.models[key]!.cooldownUntil! > Date.now();
          if (cooled) {
            retried = true;
            recorder.event("retry", { failedModel: key, kind: classified.kind });
            continue; // retry with a fresh agent; cooled model is now excluded
          }
        }
      } catch {
        // fall through to return
      }
    }

    clearInterval(heartbeatTimer); clearInterval(controlTimer); unregisterInstance(input.home);
    return { status, finalText, error };
  }
}
