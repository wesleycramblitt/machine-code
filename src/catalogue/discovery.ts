/**
 * machine_code — live OpenAI-compatible model listings.
 *
 * Some providers rotate models faster than pi-ai's static baselines (Groq
 * retires old models; NVIDIA EOLs them). For providers marked `live_listings`
 * the catalogue verifies membership against a live GET <baseUrl>/models and
 * prunes rows that vanished upstream. Unknown live ids are only ever
 * reported, never guessed into rows: without pi-ai metadata there is no
 * context window or pricing to build from.
 *
 * A failed or keyless fetch resolves to null ("unknown"): callers keep
 * existing rows rather than deleting the catalogue on a network blip.
 */
export interface LiveListingSource {
  baseUrl?: string;
  envKeys: string[];
}

export type LiveListing =
  | { ok: true; ids: Set<string> }
  | { ok: false; reason: "unconfigured"; error: string }
  | { ok: false; reason: "failed"; error: string };

function apiKey(envKeys: string[]): string | undefined {
  for (const key of envKeys) {
    const value = process.env[key];
    if (value && value.length > 0) return value;
  }
  return undefined;
}

/** Fetch the live model ids for an OpenAI-compatible provider. Never throws. */
export async function fetchLiveListing(
  def: LiveListingSource,
  providerId: string,
  timeoutMs = 20_000,
): Promise<LiveListing> {
  const base = def.baseUrl?.replace(/\/+$/, "");
  if (!base) return { ok: false, reason: "unconfigured", error: `${providerId}: no base_url for live listing` };
  const key = apiKey(def.envKeys);
  if (!key) return { ok: false, reason: "unconfigured", error: `${providerId}: no api key configured` };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const response = await fetch(`${base}/models`, {
      signal: ctrl.signal,
      headers: { accept: "application/json", authorization: `Bearer ${key}` },
    });
    if (!response.ok) return { ok: false, reason: "failed", error: `${providerId}: GET /models -> ${response.status}` };
    const body = (await response.json()) as { data?: unknown };
    if (!Array.isArray(body?.data)) return { ok: false, reason: "failed", error: `${providerId}: unexpected /models shape` };
    const ids = new Set<string>();
    for (const entry of body.data) {
      if (entry && typeof (entry as { id?: unknown }).id === "string" && (entry as { id: string }).id) {
        ids.add((entry as { id: string }).id);
      }
    }
    return { ok: true, ids };
  } catch (error) {
    return { ok: false, reason: "failed", error: `${providerId}: live listing failed (${error instanceof Error ? error.message : String(error)})` };
  } finally {
    clearTimeout(timer);
  }
}
