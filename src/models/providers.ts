/**
 * machine_code — generic OpenAI-compatible provider shim.
 *
 * Provider definitions (id, name, base URL, env keys) live in
 * data/providers/<id>.toml. This module only knows how to fetch their model list
 * and translate metadata; it contains no provider-specific constants.
 */
import {
  createProvider,
  envApiKeyAuth,
  type Model,
  type Provider,
} from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";

type ChatModelEntry = { id?: unknown; name?: unknown; metadata?: unknown; [key: string]: unknown };

function chatModels(payload: unknown): ChatModelEntry[] {
  const data = (payload as { data?: unknown })?.data;
  return Array.isArray(data) ? (data as ChatModelEntry[]) : [];
}

export interface OpenAiCompatibleOptions {
  id: string;
  name: string;
  baseUrl: string;
  envKeys: string[];
}

/** Builds a provider whose model list comes from GET <baseUrl>/models. */
export function openAiCompatibleProvider(options: OpenAiCompatibleOptions): Provider {
  const { id, name, baseUrl, envKeys } = options;
  let dynamicModels: Model<"openai-completions">[] = [];
  const currentModels = () => [...dynamicModels];
  return createProvider({
    id,
    name,
    baseUrl,
    auth: { apiKey: envApiKeyAuth(`${name} API key`, envKeys) },
    models: [],
    fetchModels: async (context) => {
      const url = `${context.baseUrl ?? baseUrl}/models`;
      try {
        const r = await fetch(url, {
          signal: context.signal,
          headers: { accept: "application/json" },
        });
        if (!r.ok) return [];
        const parsed = chatModels(await r.json());
        const models = parsed
          .filter((m) => {
            const meta = (m.metadata ?? {}) as Record<string, unknown>;
            const tags = Array.isArray(meta.tags) ? (meta.tags as string[]) : [];
            return tags.length === 0 || tags.includes("chat") || tags.includes("text");
          })
          .map((m): Model<"openai-completions"> => {
            const modelId = typeof m.id === "string" ? m.id : "";
            const meta = (m.metadata ?? {}) as Record<string, unknown>;
            const tags = Array.isArray(meta.tags) ? (meta.tags as string[]) : [];
            const pricing = (meta.pricing ?? {}) as Record<string, unknown>;
            const num = (v: unknown) => {
              const n = typeof v === "number" ? v : Number(v);
              return Number.isFinite(n) && n >= 0 ? n : 0;
            };
            const vision = tags.includes("vision") || tags.includes("image");
            return {
              id: modelId,
              provider: id as import("@earendil-works/pi-ai").ProviderId,
              baseUrl: context.baseUrl ?? baseUrl,
              name: typeof m.name === "string" ? m.name : modelId,
              api: "openai-completions",
              type: "chat",
              reasoning: tags.includes("reasoning"),
              contextWindow: num(meta.context_length),
              maxTokens: num(meta.max_tokens),
              input: vision ? ["text", "image"] : ["text"],
              cost: {
                input: num(pricing.input_tokens),
                output: num(pricing.output_tokens),
                cacheRead: 0,
                cacheWrite: 0,
              },
            };
          });
        await context.publish({
          update: () => {
            dynamicModels = models;
          },
        });
        return models;
      } catch {
        return currentModels().length > 0 ? currentModels() : [];
      }
    },
    api: { "openai-completions": openAICompletionsApi() },
  });
}
