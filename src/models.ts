/**
 * machine_code — pi-ai adapter (the local `Models` interface).
 *
 * All pi-ai types flow through here; the rest of the app depends on this file,
 * not on pi-ai directly, so an upstream upgrade has one blast radius.
 * Provider ids, env keys, funding defaults, and OpenAI-compatible endpoints
 * come from data/providers/<id>.toml (machine override: ~/.machine_code/data/providers/).
 */
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { getEnvApiKey } from "@earendil-works/pi-ai/compat";
import type { Api, Model, MutableModels } from "@earendil-works/pi-ai";
import { openAiCompatibleProvider } from "./models/providers.js";
import { loadProviderDefinitions } from "./data.js";

export type { Api, Model, MutableModels };
export type ChatModel = Model<Api>;

export function createModelsCollection(): MutableModels {
  const models = builtinModels();
  const definitions = loadProviderDefinitions();
  for (const [id, def] of Object.entries(definitions)) {
    if (def.discovery === "openai-compatible" && def.baseUrl) {
      models.setProvider(
        openAiCompatibleProvider({
          id,
          name: def.name ?? id,
          baseUrl: def.baseUrl,
          envKeys: def.envKeys,
        }),
      );
    }
  }
  return models;
}

export interface ProviderStatus {
  id: string;
  name: string;
  /** Environment variables that can hold this provider's key. */
  envKeys: string[];
  /** A usable env key is present. */
  configured: boolean;
  /** Which env var satisfied it (name only — never the value). */
  source?: string;
  /** Paid rows eligible by default (machine config can override). */
  funded: boolean;
  modelCount: number;
}

export function providerStatuses(models: MutableModels): ProviderStatus[] {
  const definitions = loadProviderDefinitions();
  return models
    .getProviders()
    .map((provider) => {
      const def = definitions[provider.id];
      const envKeys = def?.envKeys ?? [];
      const source = envKeys.find((key) => !!process.env[key]);
      const configured = getEnvApiKey(provider.id) !== undefined || source !== undefined;
      let modelCount = 0;
      try {
        modelCount = provider.getModels().length;
      } catch {
        modelCount = 0;
      }
      return {
        id: provider.id,
        name: def?.name ?? provider.name,
        envKeys,
        configured,
        ...(configured && source ? { source } : {}),
        funded: def?.funded === true,
        modelCount,
      };
    })
    .sort((a, b) => (a.id < b.id ? -1 : 1));
}

/**
 * Chat models whose providers have complete auth configuration. Dynamic
 * providers are refreshed first (network); refresh failures degrade to the
 * provider's static baseline rather than failing the run.
 */
export async function availableChatModels(
  models: MutableModels,
): Promise<{ models: readonly ChatModel[]; warnings: string[] }> {
  const warnings: string[] = [];
  const result = await models.refresh({ allowNetwork: true });
  for (const [provider, error] of result.errors) {
    warnings.push(`${provider}: model refresh failed, using the static baseline (${error.message})`);
  }
  return { models: await models.getAvailable(), warnings };
}

export function findModel(
  models: MutableModels,
  providerID: string,
  id: string,
): ChatModel | undefined {
  return models.getModel(providerID, id);
}
