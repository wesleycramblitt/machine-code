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
  /** Local/keyless endpoint: auth always resolves and no API key is required. */
  keyless?: boolean;
  /** Ollama needs its native /api tags/show APIs for context and capabilities. */
  kind?: "openai-compatible" | "ollama";
}

function localAuth(name: string) {
  return {
    name: `${name} (local)`,
    resolve: async () => ({ auth: { apiKey: "local" }, source: "local" }),
  };
}

function ollamaRoot(baseUrl: string): string {
  return baseUrl.replace(/\/v1\/?$/, "");
}

async function fetchOllamaModels(
  baseUrl: string,
  signal?: AbortSignal,
): Promise<Model<"openai-completions">[]> {
  const root = ollamaRoot(baseUrl);
  const tagsResponse = await fetch(`${root}/api/tags`, { signal, headers: { accept: "application/json" } });
  if (!tagsResponse.ok) return [];
  const tags = (await tagsResponse.json()) as { models?: Array<{ name?: string; model?: string }> };
  const names = (tags.models ?? [])
    .map((entry) => entry.name ?? entry.model)
    .filter((name): name is string => typeof name === "string" && name.length > 0);
  const results = await Promise.all(names.map(async (name): Promise<Model<"openai-completions"> | null> => {
    try {
      const shown = await fetch(`${root}/api/show`, {
        method: "POST",
        signal,
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ model: name }),
      });
      if (!shown.ok) return null;
      const info = (await shown.json()) as {
        capabilities?: string[];
        model_info?: Record<string, unknown>;
        details?: { family?: string };
      };
      const capabilities = info.capabilities ?? [];
      if (!capabilities.includes("completion")) return null;
      const modelInfo = info.model_info ?? {};
      const context = Object.entries(modelInfo)
        .find(([key]) => key.endsWith(".context_length"))?.[1];
      const contextWindow = Number.isFinite(Number(context)) && Number(context) > 0
        ? Number(context)
        : 8192;
      return {
        id: name,
        provider: "ollama" as import("@earendil-works/pi-ai").ProviderId,
        baseUrl,
        name,
        api: "openai-completions",
        type: "chat",
        reasoning: capabilities.includes("thinking"),
        contextWindow,
        maxTokens: Math.min(contextWindow, 8192),
        input: capabilities.includes("vision") ? ["text", "image"] : ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      };
    } catch {
      return null;
    }
  }));
  return results.filter((model): model is Model<"openai-completions"> => model !== null);
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
    auth: { apiKey: options.keyless ? localAuth(name) : envApiKeyAuth(`${name} API key`, envKeys) },
    models: [],
    fetchModels: async (context) => {
      if (options.kind === "ollama") {
        try {
          const models = await fetchOllamaModels(context.baseUrl ?? baseUrl, context.signal);
          await context.publish({ update: () => { dynamicModels = models; } });
          return models;
        } catch {
          return currentModels();
        }
      }
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
