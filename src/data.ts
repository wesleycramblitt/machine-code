/**
 * machine_code — shipped data files with machine overrides.
 *
 * Base data lives in <package>/data. A user can override any file by placing it
 * in ~/.machine_code/data/<name>. Generated state (catalogue, availability,
 * spend) stays outside this directory.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "smol-toml";

export function packageDataDir(): string {
  return fileURLToPath(new URL("../data/", import.meta.url));
}

export function machineDataDir(): string {
  const home = process.env.MACHINE_CODE_HOME ?? join(homedir(), ".machine_code");
  return join(home, "data");
}

/** Machine override wins over the shipped file when present. */
export function dataPath(name: string): string {
  const machine = join(machineDataDir(), name);
  if (existsSync(machine)) return machine;
  return join(packageDataDir(), name);
}

export function loadTomlData<T>(name: string): T {
  const file = dataPath(name);
  const raw = parse(readFileSync(file, "utf8")) as unknown;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`data/${name} must contain a TOML table`);
  }
  return raw as T;
}

export function loadTextData(name: string): string | null {
  const file = dataPath(name);
  return existsSync(file) ? readFileSync(file, "utf8") : null;
}

/* ------------------------------------------------------------- providers */

export interface ProviderBilling {
  kind: string;
  monthlyUsd?: number;
  includedUsd?: number;
  fallback?: string;
}

export interface ProviderDefinition {
  name?: string;
  envKeys: string[];
  discovery?: "pi-ai" | "openai-compatible";
  baseUrl?: string;
  /** Paid rows usable without a machine override. */
  funded?: boolean;
  /** Billing/access modes: usage, subscription, free. */
  modes?: string[];
  billing?: ProviderBilling;
  /** Default effective-cost multiplier (machine config overrides). */
  costMultiplier?: number;
}

interface RawProvider {
  name?: unknown;
  env_keys?: unknown;
  discovery?: unknown;
  base_url?: unknown;
  funded?: unknown;
  modes?: unknown;
  cost_multiplier?: unknown;
  billing?: unknown;
}

let providerCache: Record<string, ProviderDefinition> | null = null;

export function loadProviderDefinitions(): Record<string, ProviderDefinition> {
  if (providerCache) return providerCache;
  const raw = loadTomlData<{ providers?: Record<string, RawProvider> }>("providers.toml");
  const defs: Record<string, ProviderDefinition> = {};
  for (const [id, value] of Object.entries(raw.providers ?? {})) {
    const envKeys = Array.isArray(value.env_keys)
      ? value.env_keys.filter((v): v is string => typeof v === "string")
      : [];
    const billingRaw = (value.billing ?? {}) as Record<string, unknown>;
    const monthlyUsd = Number(billingRaw.monthly_usd);
    const includedUsd = Number(billingRaw.included_usd);
    defs[id] = {
      ...(typeof value.name === "string" ? { name: value.name } : {}),
      envKeys,
      ...(value.discovery === "openai-compatible" ? { discovery: "openai-compatible" as const } : {}),
      ...(typeof value.base_url === "string" ? { baseUrl: value.base_url } : {}),
      ...(typeof value.funded === "boolean" ? { funded: value.funded } : {}),
      ...(Array.isArray(value.modes)
        ? { modes: value.modes.filter((v): v is string => typeof v === "string") }
        : {}),
      ...(typeof value.cost_multiplier === "number" && value.cost_multiplier >= 0
        ? { costMultiplier: value.cost_multiplier }
        : {}),
      ...(typeof billingRaw.kind === "string"
        ? {
            billing: {
              kind: billingRaw.kind,
              ...(Number.isFinite(monthlyUsd) ? { monthlyUsd } : {}),
              ...(Number.isFinite(includedUsd) ? { includedUsd } : {}),
              ...(typeof billingRaw.fallback === "string" ? { fallback: billingRaw.fallback } : {}),
            },
          }
        : {}),
    };
  }
  providerCache = defs;
  return defs;
}

/** Providers with funding for paid rows (machine config overrides data). */
export function fundedProviderIds(provided: Record<string, { funded?: boolean }>): Set<string> {
  const defs = loadProviderDefinitions();
  const set = new Set<string>();
  for (const [id, def] of Object.entries(defs)) {
    const funded = provided[id]?.funded ?? def.funded ?? false;
    if (funded) set.add(id);
  }
  for (const [id, value] of Object.entries(provided)) {
    if (value.funded === true) set.add(id);
  }
  return set;
}
