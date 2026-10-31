/**
 * machine_code — pi-ai adapter (the local `Models` interface).
 *
 * All pi-ai types flow through here; the rest of the app depends on this file,
 * not on pi-ai directly, so an upstream upgrade has one blast radius.
 */
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { getEnvApiKey } from "@earendil-works/pi-ai/compat";
import type { Api, Model, MutableModels } from "@earendil-works/pi-ai";
import { EXTRA_PROVIDERS } from "./models/providers.js";

export type { Api, Model, MutableModels };
export type ChatModel = Model<Api>;

export function createModelsCollection(): MutableModels {
  const models = builtinModels();
  for (const provider of EXTRA_PROVIDERS) {
    models.setProvider(provider);
  }
  return models;
}

/**
 * Provider → environment variable that holds its key. Mirrors pi-ai's
 * env-api-keys table (not exported); used for display only — configuration
 * checks go through pi-ai's getEnvApiKey. OAuth/ambient-only providers are
 * absent here.
 */
const KNOWN_ENV_KEYS: Record<string, string> = {
  "ant-ling": "ANT_LING_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  azure: "AZURE_OPENAI_API_KEY",
  nvidia: "NVIDIA_API_KEY",
  deepseek: "DEEPSEEK_API_KEY",
  google: "GEMINI_API_KEY",
  "google-vertex": "GOOGLE_CLOUD_API_KEY",
  groq: "GROQ_API_KEY",
  cerebras: "CEREBRAS_API_KEY",
  xai: "XAI_API_KEY",
  typesafe: "TYPESAFE_API_KEY",
  radius: "RADIUS_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
  "vercel-ai-gateway": "AI_GATEWAY_API_KEY",
  zai: "ZAI_API_KEY",
  "zai-coding-cn": "ZAI_CODING_CN_API_KEY",
  mistral: "MISTRAL_API_KEY",
  minimax: "MINIMAX_API_KEY",
  "minimax-cn": "MINIMAX_CN_API_KEY",
  moonshotai: "MOONSHOT_API_KEY",
  "moonshotai-cn": "MOONSHOT_API_KEY",
  huggingface: "HF_TOKEN",
  fireworks: "FIREWORKS_API_KEY",
  together: "TOGETHER_API_KEY",
  baseten: "BASETEN_API_KEY",
  opencode: "OPENCODE_API_KEY",
  "opencode-go": "OPENCODE_API_KEY",
  "kimi-coding": "KIMI_API_KEY",
  meta: "META_API_KEY",
  "cloudflare-workers-ai": "CLOUDFLARE_API_KEY",
  "cloudflare-ai-gateway": "CLOUDFLARE_API_KEY",
  xiaomi: "XIAOMI_API_KEY",
  "xiaomi-token-plan-cn": "XIAOMI_TOKEN_PLAN_CN_API_KEY",
  "xiaomi-token-plan-ams": "XIAOMI_TOKEN_PLAN_AMS_API_KEY",
  "xiaomi-token-plan-sgp": "XIAOMI_TOKEN_PLAN_SGP_API_KEY",
  "github-copilot": "COPILOT_GITHUB_TOKEN",
  "qwen-token-plan": "QWEN_TOKEN_PLAN_API_KEY",
  "qwen-token-plan-cn": "QWEN_TOKEN_PLAN_CN_API_KEY",
  "qwen-token-plan-individual": "QWEN_TOKEN_PLAN_API_KEY",
};

export interface ProviderStatus {
  id: string;
  name: string;
  /** Environment variables that can hold this provider's key. */
  envKeys: string[];
  /** A usable env key is present. */
  configured: boolean;
  /** Which env var satisfied it (name only — never the value). */
  source?: string;
  modelCount: number;
}

export function providerStatuses(models: MutableModels): ProviderStatus[] {
  return models
    .getProviders()
    .map((provider) => {
      const known = KNOWN_ENV_KEYS[provider.id];
      const envKeys = known ? [known] : [];
      const configured = getEnvApiKey(provider.id) !== undefined;
      let modelCount = 0;
      try {
        modelCount = provider.getModels().length;
      } catch {
        modelCount = 0;
      }
      return {
        id: provider.id,
        name: provider.name,
        envKeys,
        configured,
        source: configured && known && process.env[known] ? known : undefined,
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
