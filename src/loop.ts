/**
 * machine_code — the local `Loop` interface: a thin wrapper over pi-agent-core.
 *
 * Selection happens per provider call in prepareRequest: estimate context
 * size, run pick(), log the selection, and hand the loop the chosen model.
 * No stickiness — every call is selected and logged independently.
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
  recorder: RunRecorder;
  commands: ReadonlyMap<string, import("./commands/registry.js").CommandSpec>;
  requireProvider?: string;
  /** External abort (Ctrl-C): aborts the in-flight provider request. */
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

/** Rough per-tool schema overhead for the context estimate. */
const TOOL_SCHEMA_CHARS = 1_500;

function contextChars(messages: readonly AgentMessage[]): number {
  let total = 0;
  for (const m of messages) total += JSON.stringify(m).length;
  return total;
}

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
      contextChars: chars,
      requireProvider: input.requireProvider,
    });

  // First selection happens up front: the Agent's initial state needs a model,
  // and a pick failure here means nothing is eligible at all.
  const initialChars = input.agent.prompt.length + input.request.length + 2_000;
  const first = selectFor(initialChars);
  if ("error" in first) {
    recorder.event("model_select", { error: first.error, rejected: first.rejected });
    return { status: "failed", finalText: "", error: first.error };
  }
  let currentRow: CatalogueRow = first.selected;
  const firstModel = input.models.getModel(currentRow.providerID, currentRow.id);
  if (!firstModel) {
    const error = `catalogue row ${currentRow.key} is not in the provider's runtime catalog; run: machine_code catalogue refresh`;
    recorder.event("model_select", { call: 0, error });
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

  const zeroUsage: Usage = {
    input: 0, output: 0, cacheRead: 0, cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  let totalTokens = 0;
  let turns = 0;
  let lastAssistant: AssistantMessage | undefined;
  let budgetExhausted = false;

  const agent = new Agent({
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
      // Per-call selection: re-estimate from the live context and re-pick.
      // The loop's message list may exclude the system prompt and tool
      // schemas, so add them as a constant overhead.
      const chars =
        contextChars(context.messages) +
        input.agent.prompt.length +
        input.agent.tools.length * TOOL_SCHEMA_CHARS;
      const result = selectFor(chars);
      if ("error" in result) {
        // Mid-run selection failure: keep the current model and let the
        // provider error surface (run-local, classified in M2).
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

  agent.subscribe((event) => {
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
          recorder.recordCall(
            {
              input: usage.input,
              output: usage.output,
              cacheRead: usage.cacheRead,
              cacheWrite: usage.cacheWrite,
              totalTokens: usage.totalTokens,
            },
            typeof actual === "number" && Number.isFinite(actual) ? actual : null,
            estimateCallCost(currentRow.pricing, usage.input, Math.max(usage.output, policy.expectedOutputTokens)),
          );
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

  const onExternalAbort = () => agent.abort();
  input.signal?.addEventListener("abort", onExternalAbort, { once: true });
  try {
    await agent.prompt(input.request);
    await agent.waitForIdle();
  } catch (error) {
    return { status: "failed", finalText: "", error: (error as Error).message };
  } finally {
    input.signal?.removeEventListener("abort", onExternalAbort);
  }

  const finalText = assistantText(lastAssistant);
  if (input.signal?.aborted) return { status: "interrupted", finalText };
  if (budgetExhausted) {
    return { status: "blocked", finalText, error: `token budget exhausted (${policy.budgetTokens})` };
  }
  const stop = lastAssistant?.stopReason;
  if (stop === "aborted") return { status: "interrupted", finalText };
  if (stop === "error") {
    return { status: "failed", finalText, error: lastAssistant?.errorMessage ?? "provider error" };
  }
  return { status: "done", finalText };
}
