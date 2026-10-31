/**
 * machine_code — extra provider shims.
 *
 * pi-ai v1.4.0 does not ship DeepInfra or SambaNova. Both are OpenAI-compatible
 * chat endpoints, so they go through pi-ai's `createProvider` with
 * `openAICompletionsApi()` — no custom request code. Model lists come from each
 * provider's OpenAI-compatible `GET /v1/models` when its key is configured;
 * without a key the provider is simply unconfigured (no models, no selection).
 *
 * Keys come from environment variables only.
 */
import {
  createProvider,
  envApiKeyAuth,
  type Model,
  type Provider,
} from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";

type ChatModelEntry = { id: string; [key: string]: unknown };

function chatModels(payload: unknown): ChatModelEntry[] {
  const data = (payload as { data?: unknown })?.data;
  return Array.isArray(data) ? (data as ChatModelEntry[]) : [];
}

/** Builds a dynamic model list from a provider's OpenAI-compatible /models endpoint. */
function buildProvider(baseUrl: string, providerId: string, name: string): Provider {
  let dynamicModels: Model<"openai-completions">[] = [];
  const currentModels = () => [...dynamicModels];
  return createProvider({
    id: providerId,
    name,
    baseUrl,
    auth: { apiKey: envApiKeyAuth(`${name} API key`, [providerId.toUpperCase() + "_API_KEY"]) },
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
        const models = parsed.map((m): Model<"openai-completions"> => {
          const id = typeof m.id === "string" ? m.id : "";
          return {
            id,
            provider: providerId as import("@earendil-works/pi-ai").ProviderId,
            baseUrl: context.baseUrl ?? baseUrl,
            name: typeof m.name === "string" ? m.name : id,
            api: "openai-completions",
            type: "chat",
            reasoning: false,
            contextWindow: 0,
            maxTokens: 0,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          };
        });
        await context.publish({
          update: () => {
            dynamicModels = models;
          },
        });
        return models;
      } catch {
        // leave the previous list in place on failure
        return [];
      }
    },
    api: { "openai-completions": openAICompletionsApi() },
  });
}

/** DeepInfra — OpenAI-compatible at https://api.deepinfra.com/v1/openai. */
export function deepinfraProvider(): Provider {
  return buildProvider("https://api.deepinfra.com/v1/openai", "deepinfra", "DeepInfra");
}

/** SambaNova — OpenAI-compatible at https://api.sambanova.ai/v1. */
export function sambanovaProvider(): Provider {
  return buildProvider("https://api.sambanova.ai/v1", "sambanova", "SambaNova");
}

export const EXTRA_PROVIDERS: readonly Provider[] = [
  deepinfraProvider(),
  sambanovaProvider(),
];
