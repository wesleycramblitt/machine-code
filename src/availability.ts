/**
 * machine_code — provider/model availability and error classification.
 *
 * Persisted in ~/.machine_code/availability.json under a lock. Insufficient
 * funds disables a provider until manual re-enable. Temporary failures cool
 * models/providers on 1m→5m→30m→2h→12h→1d→7d→30d, honoring Retry-After up
 * to 30 days; success resets the tier.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type ErrorKind =
  | "funds"
  | "rate-limit-model"
  | "rate-limit-provider"
  | "free-limit"
  | "auth"
  | "quota"
  | "timeout"
  | "missing-model"
  | "context-too-long"
  | "unsupported-param"
  | "refusal"
  | "malformed"
  | "unknown";

export interface ClassifiedError {
  kind: ErrorKind;
  message: string;
  retryable: boolean;
  /** Suggested cooldown in ms; 0 means no cooldown (or manual action). */
  cooldownMs: number;
  /** Whether the model should be cooled (vs the provider). */
  target: "model" | "provider" | "none";
  /** Whether to disable the provider entirely until manual re-enable. */
  disableProvider: boolean;
  /** Whether to mark the provider needs-auth. */
  needsAuth: boolean;
}

const COOLDOWN_TIERS = [60_000, 5 * 60_000, 30 * 60_000, 2 * 60 * 60_000, 12 * 60 * 60_000, 24 * 60 * 60_000, 7 * 24 * 60 * 60_000, 30 * 24 * 60 * 60_000];
const MAX_COOLDOWN = 30 * 24 * 60 * 60_000;
/** Free-tier account limits are not a 1-minute model rate limit. */
const FREE_LIMIT_COOLDOWN = 30 * 60_000;

export interface ProviderHealth {
  disabled?: boolean;
  needsAuth?: boolean;
  /** Cooldown expiry (ms since epoch). */
  cooldownUntil?: number;
  /** Current tier index (0-based). */
  tier?: number;
}

export interface ModelHealth {
  cooldownUntil?: number;
  tier?: number;
}

export interface AvailabilityState {
  providers: Record<string, ProviderHealth>;
  models: Record<string, ModelHealth>;
}

export function availabilityFile(home: string): string {
  return join(home, "availability.json");
}

export function loadAvailability(home: string): AvailabilityState {
  const file = availabilityFile(home);
  if (!existsSync(file)) return { providers: {}, models: {} };
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as AvailabilityState;
    return {
      providers: parsed.providers ?? {},
      models: parsed.models ?? {},
    };
  } catch {
    return { providers: {}, models: {} };
  }
}

export function saveAvailability(home: string, state: AvailabilityState): void {
  writeFileSync(availabilityFile(home), JSON.stringify(state, null, 2) + "\n", "utf8");
}

export function isProviderDisabled(state: AvailabilityState, providerId: string): boolean {
  return state.providers[providerId]?.disabled === true;
}

export function providerNeedsAuth(state: AvailabilityState, providerId: string): boolean {
  return state.providers[providerId]?.needsAuth === true;
}

export function isProviderCooling(state: AvailabilityState, providerId: string): boolean {
  const until = state.providers[providerId]?.cooldownUntil;
  return typeof until === "number" && until > Date.now();
}

export function isModelCooling(state: AvailabilityState, key: string): boolean {
  const until = state.models[key]?.cooldownUntil;
  return typeof until === "number" && until > Date.now();
}

export function disableProvider(state: AvailabilityState, providerId: string): void {
  state.providers[providerId] = { ...(state.providers[providerId] ?? {}), disabled: true };
}

export function enableProvider(state: AvailabilityState, providerId: string): void {
  const h = state.providers[providerId];
  if (h) {
    h.disabled = false;
    h.needsAuth = false;
    h.cooldownUntil = 0;
    h.tier = 0;
  }
}

export function markNeedsAuth(state: AvailabilityState, providerId: string): void {
  state.providers[providerId] = { ...(state.providers[providerId] ?? {}), needsAuth: true };
}

export function coolModel(state: AvailabilityState, key: string, retryAfterMs?: number): number {
  const h = state.models[key] ?? {};
  const tier = h.tier ?? 0;
  let ms = retryAfterMs && retryAfterMs > 0 ? Math.min(retryAfterMs, MAX_COOLDOWN) : COOLDOWN_TIERS[Math.min(tier, COOLDOWN_TIERS.length - 1)]!;
  const until = Date.now() + ms;
  state.models[key] = { cooldownUntil: until, tier: Math.min(tier + 1, COOLDOWN_TIERS.length - 1) };
  return until;
}

export function coolProvider(state: AvailabilityState, providerId: string, retryAfterMs?: number): number {
  const h = state.providers[providerId] ?? {};
  const tier = h.tier ?? 0;
  let ms = retryAfterMs && retryAfterMs > 0 ? Math.min(retryAfterMs, MAX_COOLDOWN) : COOLDOWN_TIERS[Math.min(tier, COOLDOWN_TIERS.length - 1)]!;
  const until = Date.now() + ms;
  state.providers[providerId] = { ...h, cooldownUntil: until, tier: Math.min(tier + 1, COOLDOWN_TIERS.length - 1) };
  return until;
}

export function clearModelCooldown(state: AvailabilityState, key: string): void {
  const h = state.models[key];
  if (h) {
    h.cooldownUntil = 0;
    h.tier = 0;
  }
}

export function clearProviderCooldown(state: AvailabilityState, providerId: string): void {
  const h = state.providers[providerId];
  if (h) {
    h.cooldownUntil = 0;
    h.tier = 0;
  }
}

/** Reset a model's tier on success. */
export function resetModelTier(state: AvailabilityState, key: string): void {
  const h = state.models[key];
  if (h) h.tier = 0;
}

/** Classify a provider error. */
export function classifyError(error: unknown, status?: number): ClassifiedError {
  const msg = (error instanceof Error ? error.message : String(error)).toLowerCase();
  const code = status ?? 0;

  // Free-tier account limit: every free offer on that provider is affected,
  // not just the model that happened to answer first. This must precede the
  // generic 429 branch (OpenCode returns a 429 FreeUsageLimitError).
  if (
    msg.includes("free usage limit") ||
    msg.includes("freeusagelimiterror") ||
    msg.includes("free tier limit") ||
    (msg.includes("free models") && msg.includes("subscribe"))
  ) {
    return {
      kind: "free-limit",
      message: msg,
      retryable: true,
      cooldownMs: FREE_LIMIT_COOLDOWN,
      target: "none",
      disableProvider: false,
      needsAuth: false,
    };
  }

  // Billing / funds
  if (code === 402 || msg.includes("insufficient") || msg.includes("funds") || msg.includes("billing") || msg.includes("payment required") || msg.includes("quota exceeded")) {
    // distinguish account quota (429 with quota) from funds
    if (msg.includes("funds") || msg.includes("billing") || code === 402) {
      return { kind: "funds", message: msg, retryable: false, cooldownMs: 0, target: "none", disableProvider: true, needsAuth: false };
    }
  }
  // Auth
  if (code === 401 || code === 403 || msg.includes("unauthorized") || msg.includes("invalid api key") || msg.includes("invalid credential") || msg.includes("api_key_expired") || msg.includes("authentication")) {
    return { kind: "auth", message: msg, retryable: false, cooldownMs: 0, target: "none", disableProvider: false, needsAuth: true };
  }
  // Rate limit (model or provider)
  if (
    code === 429 ||
    /\b429\b/.test(msg) ||
    msg.includes("rate limit") ||
    msg.includes("rate_limit") ||
    msg.includes("too many requests") ||
    msg.includes("resource exhausted") ||
    msg.includes("requests per") ||
    msg.includes("tokens per")
  ) {
    const isProvider =
      msg.includes("provider") ||
      msg.includes("organization") ||
      msg.includes("account") ||
      msg.includes("quota") ||
      msg.includes("monthly") ||
      msg.includes("plan limit");
    return {
      kind: isProvider ? "rate-limit-provider" : "rate-limit-model",
      message: msg,
      retryable: true,
      cooldownMs: 0, // caller applies tier schedule
      target: isProvider ? "provider" : "model",
      disableProvider: false,
      needsAuth: false,
    };
  }
  // End-of-life / gone model: cool it for a week and let the one bounded
  // retry pick another model.
  if (code === 410 || /\b410\b/.test(msg) || msg.includes("end of life") || msg.includes("no longer available")) {
    return {
      kind: "missing-model",
      message: msg,
      retryable: true,
      cooldownMs: 7 * 24 * 60 * 60_000,
      target: "model",
      disableProvider: false,
      needsAuth: false,
    };
  }
  // Upstream says the model is unavailable (OpenRouter 400 server_error). It is
  // a model-specific outage, not a one-minute rate limit: cool it long enough
  // that the next run does not waste a call on it.
  if (msg.includes("model is unavailable") || msg.includes("model unavailable") || msg.includes("no available model")) {
    return {
      kind: "missing-model",
      message: msg,
      retryable: true,
      cooldownMs: 60 * 60_000,
      target: "model",
      disableProvider: false,
      needsAuth: false,
    };
  }
  // Missing/deprecated model
  if (code === 404 || msg.includes("model not found") || msg.includes("does not exist") || msg.includes("deprecated")) {
    return { kind: "missing-model", message: msg, retryable: false, cooldownMs: 0, target: "none", disableProvider: false, needsAuth: false };
  }
  // Provider stall: no headers/first token in time. Retry elsewhere and let the
  // model's cooldown tier escalate on repeated stalls.
  if (msg.includes("timed out") || msg.includes("timeout") || msg.includes("no stream event")) {
    return { kind: "timeout", message: msg, retryable: true, cooldownMs: 0, target: "model", disableProvider: false, needsAuth: false };
  }
  // Context too long
  if (msg.includes("context length") || msg.includes("context window") || msg.includes("too long") || msg.includes("maximum context")) {
    return { kind: "context-too-long", message: msg, retryable: false, cooldownMs: 0, target: "none", disableProvider: false, needsAuth: false };
  }
  // Unsupported parameter
  if (msg.includes("unsupported") || msg.includes("invalid parameter") || msg.includes("unknown parameter")) {
    return { kind: "unsupported-param", message: msg, retryable: false, cooldownMs: 0, target: "none", disableProvider: false, needsAuth: false };
  }
  // Refusal
  if (msg.includes("refusal") || msg.includes("content policy") || msg.includes("safety")) {
    return { kind: "refusal", message: msg, retryable: false, cooldownMs: 0, target: "none", disableProvider: false, needsAuth: false };
  }
  // Quota (account-level, time-bound)
  if (msg.includes("quota") || msg.includes("limit exceeded")) {
    return { kind: "quota", message: msg, retryable: true, cooldownMs: 0, target: "provider", disableProvider: false, needsAuth: false };
  }
  // Malformed response
  if (msg.includes("malformed") || msg.includes("invalid json") || msg.includes("parse error")) {
    return { kind: "malformed", message: msg, retryable: true, cooldownMs: COOLDOWN_TIERS[0]!, target: "model", disableProvider: false, needsAuth: false };
  }
  return { kind: "unknown", message: msg, retryable: true, cooldownMs: COOLDOWN_TIERS[0]!, target: "model", disableProvider: false, needsAuth: false };
}

/**
 * Apply a classified error to availability state. Rate-limit/quota errors
 * carry cooldownMs 0 to mean "use the tier schedule", so retryable errors are
 * cooled even without a Retry-After hint.
 */
export function applyClassification(
  state: AvailabilityState,
  providerId: string,
  modelKey: string,
  classified: ClassifiedError,
  options?: { freeKeys?: readonly string[] },
): void {
  if (classified.disableProvider) disableProvider(state, providerId);
  if (classified.needsAuth) markNeedsAuth(state, providerId);
  if (!(classified.cooldownMs > 0 || classified.retryable)) return;
  if (classified.kind === "free-limit") {
    const keys = options?.freeKeys?.length ? options.freeKeys : [modelKey];
    for (const key of new Set(keys)) coolModel(state, key, classified.cooldownMs || undefined);
    return;
  }
  if (classified.target === "model") {
    coolModel(state, modelKey, classified.cooldownMs || undefined);
  } else if (classified.target === "provider") {
    coolProvider(state, providerId, classified.cooldownMs || undefined);
  }
}

/** Parse Retry-After header value (seconds or HTTP date) into ms. */
export function parseRetryAfter(value: string | null): number {
  if (!value) return 0;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  return 0;
}
