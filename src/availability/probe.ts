/**
 * Model availability probes.
 *
 * A probe is evidence, not a guarantee. Metadata probes use free provider
 * endpoints and make no inference call. A `free-models` probe may send one
 * 1-token completion to a zero-price model; it costs no money but consumes
 * provider request quota. Paid completion probes are deliberately absent.
 */
import type { CatalogueRow } from "../catalogue/types.js";
import type { AvailabilityConfig } from "../config.js";
import { loadProviderDefinitions } from "../data.js";
import {
  clearModelCooldown,
  coolModel,
  isModelCooling,
  markNeedsAuth,
  resetModelTier,
  type AvailabilityState,
} from "../availability.js";

export type ProbeStatus = "ready" | "cooling" | "unavailable" | "auth" | "unknown" | "skipped";

export interface ProbeTarget {
  key: string;
  providerID: string;
  modelID: string;
  free: boolean;
}

export interface ProbeResult {
  key: string;
  providerID: string;
  modelID: string;
  status: ProbeStatus;
  source: "metadata" | "free-completion";
  message?: string;
  retryAfterMs?: number;
  latencyMs: number;
  checkedAt: string;
}

const OPENROUTER_BASE = "https://openrouter.ai/api/v1";
/** Built-in providers do not carry a base URL in their TOML definition. */
const KNOWN_METADATA_BASE: Record<string, string> = {
  opencode: "https://opencode.ai/inference",
  "opencode-go": "https://opencode.ai/inference/go",
};
/** All text models on the OpenCode gateway are available through this API. */
const OPENCODE_COMPLETION_BASE = "https://opencode.ai/inference/openai/v1";

function normalizeBase(value: string | undefined): string | undefined {
  return value ? value.replace(/\/+$/, "") : undefined;
}

function providerBase(providerID: string, baseUrl: string | undefined): string | undefined {
  if (providerID === "openrouter") return OPENROUTER_BASE;
  return normalizeBase(KNOWN_METADATA_BASE[providerID] ?? baseUrl);
}

function providerKey(providerID: string, envKeys: readonly string[]): string | undefined {
  if (providerID === "openrouter") return process.env.OPENROUTER_API_KEY;
  for (const key of envKeys) {
    const value = process.env[key];
    if (value) return value;
  }
  return undefined;
}

function header(headers: Headers, name: string): string | undefined {
  const value = headers.get(name);
  return value === null || value.trim() === "" ? undefined : value.trim();
}

function retryAfterMs(response: Response): number | undefined {
  const retry = header(response.headers, "retry-after");
  if (retry) {
    const seconds = Number(retry);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1_000, 30 * 24 * 60 * 60_000);
    const at = Date.parse(retry);
    if (Number.isFinite(at)) return Math.max(0, at - Date.now());
  }
  const reset = header(response.headers, "x-ratelimit-reset");
  if (reset) {
    const value = Number(reset);
    if (Number.isFinite(value) && value > 0) {
      const at = value > 10_000_000_000 ? value : value * 1_000;
      return Math.max(0, at - Date.now());
    }
  }
  return undefined;
}

function statusResult(
  target: ProbeTarget,
  response: Response,
  source: ProbeResult["source"],
  latencyMs: number,
  message?: string,
): ProbeResult {
  const base = {
    key: target.key,
    providerID: target.providerID,
    modelID: target.modelID,
    source,
    latencyMs,
    checkedAt: new Date().toISOString(),
    ...(message ? { message } : {}),
  };
  if (response.status === 401 || response.status === 403) return { ...base, status: "auth" };
  if (response.status === 429) {
    return { ...base, status: "cooling", ...(retryAfterMs(response) ? { retryAfterMs: retryAfterMs(response) } : {}) };
  }
  if (response.status >= 500) return { ...base, status: "unavailable", message: message ?? `HTTP ${response.status}` };
  return { ...base, status: "unavailable", message: message ?? `HTTP ${response.status}` };
}

function modelIDs(payload: unknown): string[] {
  const data = (payload as { data?: unknown })?.data;
  if (!Array.isArray(data)) return [];
  return data.flatMap((entry) => {
    const id = (entry as { id?: unknown })?.id;
    return typeof id === "string" ? [id] : [];
  });
}

function ollamaNames(payload: unknown): string[] {
  const models = (payload as { models?: unknown })?.models;
  if (!Array.isArray(models)) return [];
  return models.flatMap((entry) => {
    const value = (entry as { name?: unknown; model?: unknown });
    const name = typeof value.name === "string" ? value.name : value.model;
    return typeof name === "string" ? [name] : [];
  });
}

function listed(ids: readonly string[], modelID: string): boolean {
  return ids.some((id) => id === modelID || id.replace(/:latest$/, "") === modelID || modelID.replace(/:latest$/, "") === id);
}

async function metadataProbe(
  target: ProbeTarget,
  config: AvailabilityConfig,
): Promise<ProbeResult> {
  const started = Date.now();
  const definitions = loadProviderDefinitions();
  const def = definitions[target.providerID];
  if (!def) {
    return {
      ...target,
      status: "unknown",
      source: "metadata",
      message: "no provider definition",
      latencyMs: 0,
      checkedAt: new Date().toISOString(),
    };
  }
  const base = providerBase(target.providerID, def.baseUrl);
  if (!base) {
    return {
      ...target,
      status: "unknown",
      source: "metadata",
      message: "provider has no free metadata endpoint",
      latencyMs: 0,
      checkedAt: new Date().toISOString(),
    };
  }
  const key = providerKey(target.providerID, def.envKeys);
  if (!key && def.keyless !== true) {
    return {
      ...target,
      status: "unknown",
      source: "metadata",
      message: "provider key is not configured",
      latencyMs: 0,
      checkedAt: new Date().toISOString(),
    };
  }
  const ollama = def.discovery === "ollama";
  const url = ollama
    ? `${base.replace(/\/v1$/, "")}/api/tags`
    : target.providerID === "openrouter"
      ? `${base}/models/user`
      : target.providerID === "opencode" || target.providerID === "opencode-go"
        ? `${base}/v1/models`
        : `${base}/models`;
  let response: Response;
  try {
    response = await fetch(url, {
      headers: {
        accept: "application/json",
        ...(key ? { authorization: `Bearer ${key}` } : {}),
      },
      signal: AbortSignal.timeout(config.timeoutMs),
    });
  } catch (error) {
    return {
      ...target,
      status: "unknown",
      source: "metadata",
      message: error instanceof Error ? error.message : String(error),
      latencyMs: Date.now() - started,
      checkedAt: new Date().toISOString(),
    };
  }
  const latencyMs = Date.now() - started;
  if (!response.ok) return statusResult(target, response, "metadata", latencyMs);
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return {
      ...target,
      status: "unknown",
      source: "metadata",
      message: "invalid metadata response",
      latencyMs: Date.now() - started,
      checkedAt: new Date().toISOString(),
    };
  }
  const ids = ollama ? ollamaNames(payload) : modelIDs(payload);
  if (ids.length === 0) {
    return {
      ...target,
      status: "unknown",
      source: "metadata",
      message: "metadata response had no model list",
      latencyMs: Date.now() - started,
      checkedAt: new Date().toISOString(),
    };
  }
  return {
    ...target,
    status: listed(ids, target.modelID) ? "ready" : "unavailable",
    source: "metadata",
    ...(listed(ids, target.modelID) ? {} : { message: "model is not listed for this key" }),
    latencyMs: Date.now() - started,
    checkedAt: new Date().toISOString(),
  };
}

/** A 1-token completion for a zero-price row. Never call this for a paid row. */
async function freeCompletionProbe(
  target: ProbeTarget,
  config: AvailabilityConfig,
): Promise<ProbeResult> {
  const started = Date.now();
  if (!target.free) {
    return {
      ...target,
      status: "skipped",
      source: "free-completion",
      message: "paid completion probes are disabled",
      latencyMs: 0,
      checkedAt: new Date().toISOString(),
    };
  }
  const definitions = loadProviderDefinitions();
  const def = definitions[target.providerID];
  const base = providerBase(target.providerID, def?.baseUrl);
  if (!def || !base) {
    return {
      ...target,
      status: "unknown",
      source: "free-completion",
      message: "provider has no compatible completion endpoint",
      latencyMs: 0,
      checkedAt: new Date().toISOString(),
    };
  }
  const key = providerKey(target.providerID, def.envKeys);
  if (!key && def.keyless !== true) {
    return {
      ...target,
      status: "unknown",
      source: "free-completion",
      message: "provider key is not configured",
      latencyMs: 0,
      checkedAt: new Date().toISOString(),
    };
  }
  const completionBase =
    target.providerID === "opencode" || target.providerID === "opencode-go"
      ? OPENCODE_COMPLETION_BASE
      : base;
  let response: Response;
  try {
    response = await fetch(`${completionBase}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        ...(key ? { authorization: `Bearer ${key}` } : {}),
      },
      body: JSON.stringify({
        model: target.modelID,
        messages: [{ role: "user", content: "ping" }],
        max_tokens: 1,
        temperature: 0,
        stream: false,
      }),
      signal: AbortSignal.timeout(config.timeoutMs),
    });
  } catch (error) {
    return {
      ...target,
      status: "unknown",
      source: "free-completion",
      message: error instanceof Error ? error.message : String(error),
      latencyMs: Date.now() - started,
      checkedAt: new Date().toISOString(),
    };
  }
  const latencyMs = Date.now() - started;
  if (response.ok) {
    return {
      ...target,
      status: "ready",
      source: "free-completion",
      latencyMs,
      checkedAt: new Date().toISOString(),
    };
  }
  return statusResult(target, response, "free-completion", latencyMs);
}

export function canFreeProbe(state: AvailabilityState, config: AvailabilityConfig, now = Date.now()): boolean {
  if (config.probe !== "free-models" || config.freeCompletionMaxPerHour <= 0) return false;
  const recent = (state.freeProbeTimes ?? []).filter((at) => at > now - 60 * 60_000);
  return recent.length < config.freeCompletionMaxPerHour;
}

export function recordFreeProbe(state: AvailabilityState, now = Date.now()): void {
  state.freeProbeTimes = [...(state.freeProbeTimes ?? []).filter((at) => at > now - 60 * 60_000), now];
}

const inFlightProbes = new Map<string, Promise<ProbeResult>>();

/** Coalesce concurrent probes for the same model. */
export function probeTarget(
  target: ProbeTarget,
  config: AvailabilityConfig,
  state?: AvailabilityState,
): Promise<ProbeResult> {
  const existing = inFlightProbes.get(target.key);
  if (existing) return existing;
  const promise = probeTargetBody(target, config, state).finally(() => {
    inFlightProbes.delete(target.key);
  });
  inFlightProbes.set(target.key, promise);
  return promise;
}

async function probeTargetBody(
  target: ProbeTarget,
  config: AvailabilityConfig,
  state?: AvailabilityState,
): Promise<ProbeResult> {
  if (config.probe === "off") {
    return {
      ...target,
      status: "skipped",
      source: "metadata",
      message: "availability probes are off",
      latencyMs: 0,
      checkedAt: new Date().toISOString(),
    };
  }
  const metadata = await metadataProbe(target, config);
  if (config.probe !== "free-models" || !target.free) return metadata;
  if (metadata.status === "auth" || metadata.status === "unavailable") return metadata;
  if (state && !canFreeProbe(state, config)) {
    return {
      ...metadata,
      message: "free completion probe budget exhausted",
    };
  }
  if (state) recordFreeProbe(state);
  const completion = await freeCompletionProbe(target, config);
  return completion.status === "unknown" && metadata.status === "ready" ? metadata : completion;
}

const RATE_LIMIT_KINDS = new Set(["rate-limit-model", "rate-limit-provider", "free-limit", "quota", "timeout"]);

export function applyProbeResult(state: AvailabilityState, result: ProbeResult): void {
  const health = state.models[result.key] ?? {};
  state.models[result.key] = {
    ...health,
    lastProbeAt: Date.parse(result.checkedAt),
    lastProbeResult: result.status,
  };
  if (result.status === "ready") {
    // Metadata can prove the model exists, but it cannot prove that a
    // rate-limit or timeout cooldown has actually cleared.
    if (result.source === "metadata" && health.lastErrorKind && RATE_LIMIT_KINDS.has(health.lastErrorKind)) {
      return;
    }
    clearModelCooldown(state, result.key);
    resetModelTier(state, result.key);
    const cleared = state.models[result.key];
    if (cleared) delete cleared.lastErrorKind;
    return;
  }
  if (result.status === "auth") {
    markNeedsAuth(state, result.providerID);
    return;
  }
  if (result.status === "cooling" || result.status === "unavailable") {
    coolModel(state, result.key, result.retryAfterMs);
  }
}

export function targetFor(row: CatalogueRow): ProbeTarget {
  return {
    key: row.key,
    providerID: row.providerID,
    modelID: row.id,
    free: row.free === true || (row.pricing.input === 0 && row.pricing.output === 0),
  };
}

export function coolingTargets(
  rows: readonly CatalogueRow[],
  state: AvailabilityState,
  configuredProviders: ReadonlySet<string>,
): ProbeTarget[] {
  return rows
    .filter((row) => configuredProviders.has(row.providerID) && isModelCooling(state, row.key))
    .map(targetFor);
}

/** Probe every currently cooling, configured model and apply the evidence. */
export async function probeCoolingModels(args: {
  rows: readonly CatalogueRow[];
  state: AvailabilityState;
  config: AvailabilityConfig;
  configuredProviders: ReadonlySet<string>;
  /** Manual probes may ignore the per-model interval. */
  force?: boolean;
}): Promise<ProbeResult[]> {
  if (args.config.probe === "off") return [];
  const targets = coolingTargets(args.rows, args.state, args.configuredProviders);
  const results: ProbeResult[] = [];
  const now = Date.now();
  for (const target of targets) {
    const last = args.state.models[target.key]?.lastProbeAt;
    if (!args.force && last && now - last < args.config.intervalMs) continue;
    // Spread automatic probes slightly so a restart or timer tick does not
    // fan out every cooling model at the same instant. Manual probes skip it.
    if (!args.force && targets.length > 1) {
      const jitter = Math.floor(Math.random() * 250);
      if (jitter > 0) await new Promise((resolve) => setTimeout(resolve, jitter));
    }
    const result = await probeTarget(target, args.config, args.state);
    applyProbeResult(args.state, result);
    results.push(result);
  }
  return results;
}
