/**
 * machine_code — provider/model availability and error classification.
 *
 * Persisted in ~/.machine_code/availability.json under a lock. Insufficient
 * funds disables a provider until manual re-enable. Temporary failures write
 * no exclusion: probes record evidence only and selection stays eligible.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type ErrorKind =
  | "funds"
  | "rate-limit-model"
  | "rate-limit-provider"
  | "auth"
  | "quota"
  | "timeout"
  | "missing-model"
  | "context-too-long"
  | "unsupported-param"
  | "refusal"
  | "malformed"
  | "symbols-exceeded"
  | "unknown";

export interface ClassifiedError {
  kind: ErrorKind;
  message: string;
  retryable: boolean;
  /** Unused cooldown hint; always 0 now that cooldowns are removed. */
  cooldownMs: number;
  /** Legacy target; ignored now that cooldowns are removed. */
  target: "model" | "provider" | "none";
  /** Whether to disable the provider entirely until manual re-enable. */
  disableProvider: boolean;
  /** Whether to mark the provider needs-auth. */
  needsAuth: boolean;
  /**
   * The model itself is gone (410 Gone, EOL, 404, deprecated) as opposed to
   * temporarily unavailable. Callers may persist this as a catalogue veto so
   * the row disappears instead of burning a call every retry.
   * Auth/quota failures never set this: a broken credential is not a dead model.
   */
  permanent?: boolean;
}

export interface ProviderHealth {
  disabled?: boolean;
  needsAuth?: boolean;
  /** Last time this provider's model listing was successfully fetched (ms since epoch). */
  lastListingAt?: number;
  /** How the current listing was served: "live" (fresh /models fetch), "static"
   * (served from builtin rows), or "unknown" (never listed in this process). */
  listingMode?: "live" | "static" | "unknown";
  /** Refreshes since the last successful listing. */
  refreshCount?: number;
}

export interface ModelHealth {
  /** Last probe timestamp (ms since epoch). */
  lastProbeAt?: number;
  /** Last probe status; kept as a string to avoid a types cycle. */
  lastProbeResult?: string;
  /** Last classified error kind observed for this model. */
  lastErrorKind?: string;
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
    const providers: Record<string, ProviderHealth> = {};
    for (const [id, h] of Object.entries(parsed.providers ?? {})) {
      const known = h as ProviderHealth;
      providers[id] = { disabled: known.disabled, needsAuth: known.needsAuth, lastListingAt: known.lastListingAt, listingMode: known.listingMode, refreshCount: known.refreshCount };
    }
    const models: Record<string, ModelHealth> = {};
    for (const [key, h] of Object.entries(parsed.models ?? {})) {
      const known = h as ModelHealth;
      models[key] = { lastProbeAt: known.lastProbeAt, lastProbeResult: known.lastProbeResult, lastErrorKind: known.lastErrorKind };
    }
    return { providers, models };
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

export function disableProvider(state: AvailabilityState, providerId: string): void {
  state.providers[providerId] = { ...(state.providers[providerId] ?? {}), disabled: true };
}

export function enableProvider(state: AvailabilityState, providerId: string): void {
  const h = state.providers[providerId];
  if (h) {
    h.disabled = false;
    h.needsAuth = false;
  }
}

export function markNeedsAuth(state: AvailabilityState, providerId: string): void {
  state.providers[providerId] = { ...(state.providers[providerId] ?? {}), needsAuth: true };
}

/** Classify a provider error. */
export function classifyError(error: unknown, status?: number): ClassifiedError {
  const msg = (error instanceof Error ? error.message : String(error)).toLowerCase();
  // The status is often only in the message ("402: {...}") because provider
  // SDKs wrap it. Without this, a 402/billing error reads as "unknown" and
  // the run rotates through models that hit the same account limit.
  const embedded = /\b(4\d\d|5\d\d)\b/.exec(msg);
  const code = status ?? (embedded ? Number(embedded[1]) : 0);

  // Billing / funds / budget guardrails are account conditions, but not a
  // reason to stop: rotate to another provider for this run. `applyErrorState`
  // excludes every model on the affected provider so the retry cannot bounce
  // to a sibling that hits the same wall.
  if (
    code === 402 ||
    msg.includes("insufficient") ||
    msg.includes("funds") ||
    msg.includes("billing") ||
    msg.includes("payment required") ||
    msg.includes("quota exceeded") ||
    msg.includes("available credits") ||
    msg.includes("add credits") ||
    msg.includes("requires more credits") ||
    msg.includes("in_flight_budget") ||
    msg.includes("in-flight budget") ||
    msg.includes("in flight budget") ||
    msg.includes("budget limit") ||
    msg.includes("monthly limit") ||
    msg.includes("guardrail_budget")
  ) {
    return { kind: "funds", message: msg, retryable: true, cooldownMs: 0, target: "provider", disableProvider: false, needsAuth: false };
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
    // "Provider returned error" is OpenRouter's generic wrapper for an
    // upstream model failure. It is not a provider-wide limit. Only explicit
    // account/plan/workspace limits mark the whole provider.
    const isProvider =
      msg.includes("organization") ||
      msg.includes("account") ||
      msg.includes("quota") ||
      msg.includes("monthly") ||
      msg.includes("plan limit") ||
      msg.includes("workspace") ||
      msg.includes("provider rate limit") ||
      msg.includes("provider-wide") ||
      msg.includes("provider wide");
    return {
      kind: isProvider ? "rate-limit-provider" : "rate-limit-model",
      message: msg,
      retryable: true,
      cooldownMs: 0,
      target: isProvider ? "provider" : "model",
      disableProvider: false,
      needsAuth: false,
    };
  }
  // End-of-life / gone model. Permanent: the listing should drop the row.
  if (code === 410 || /\b410\b/.test(msg) || msg.includes("end of life") || msg.includes("no longer available")) {
    return {
      kind: "missing-model",
      message: msg,
      retryable: true,
      cooldownMs: 0,
      target: "model",
      disableProvider: false,
      needsAuth: false,
      permanent: true,
    };
  }
  // Upstream says the model is unavailable (OpenRouter 400 server_error). It is
  // a model-specific outage. Permanent is false; retry logic decides exclusion.
  if (msg.includes("model is unavailable") || msg.includes("model unavailable") || msg.includes("no available model")) {
    return {
      kind: "missing-model",
      message: msg,
      retryable: true,
      cooldownMs: 0,
      target: "model",
      disableProvider: false,
      needsAuth: false,
    };
  }
  // Missing/deprecated model. Permanent: the row should not come back on the
  // next refresh — record a veto instead of retrying it forever.
  if (code === 404 || msg.includes("model not found") || msg.includes("does not exist") || msg.includes("deprecated")) {
    return { kind: "missing-model", message: msg, retryable: false, cooldownMs: 0, target: "none", disableProvider: false, needsAuth: false, permanent: true };
  }
  // Provider stall: no headers/first token in time. Retry elsewhere.
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
    return { kind: "malformed", message: msg, retryable: true, cooldownMs: 0, target: "model", disableProvider: false, needsAuth: false };
  }
  // Symbol-map index exceeds budget — harness-internal, not recoverable by retry
  if (msg.includes("symbol map alone exceeds")) {
    return { kind: "symbols-exceeded", message: msg, retryable: false, cooldownMs: 0, target: "none", disableProvider: false, needsAuth: false };
  }
  return { kind: "unknown", message: msg, retryable: true, cooldownMs: 0, target: "model", disableProvider: false, needsAuth: false };
}

/**
 * Apply a classified error to availability state. Only auth and disable
 * effects persist; temporary failures write no exclusion.
 */
export function applyClassification(
  state: AvailabilityState,
  providerId: string,
  modelKey: string,
  classified: ClassifiedError,
): void {
  if (classified.disableProvider) disableProvider(state, providerId);
  if (classified.needsAuth) markNeedsAuth(state, providerId);
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
