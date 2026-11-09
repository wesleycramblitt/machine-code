import { AGENT_NAMES } from "../agents.js";
import type { AgentConfig } from "../agents/config.js";
import type { CatalogueDocument, CatalogueRow } from "../catalogue/types.js";
import { isFreeRow } from "../select.js";
import type { RunEvent, RunSummary } from "../state/runs.js";

export interface ForkedRunSettings {
  /** Issue kind: "features" or "bugs" */
  kind?: "features" | "bugs";
  /** Priority for new issue when created */
  priority?: "low" | "medium" | "high";
  /** Tags for new issue */
  tags?: string[];
  agent: string;
  /** Explicit catalogue key; absent means auto-select. */
  model?: string;
  approval: "human" | "agent";
  ambiguity: "strict" | "precise" | "adaptive" | "autonomous";
  tier: "free" | "paid";
  /** undefined = role policy; null = explicit zero. */
  minFit: number | null | undefined;
  floors: "role" | "strict" | "off";
  /** Issue slug attached in the composer; run with `--item <slug>`. */
  item?: string;
  prompt: string;
}

const APPROVALS = ["human", "agent"] as const;
const AMBIGUITIES = ["strict", "precise", "adaptive", "autonomous"] as const;

function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : fallback;
}

function eventConfig(events: readonly RunEvent[]): Record<string, unknown> {
  return (events.find((event) => event.type === "agent_config") ?? {}) as Record<string, unknown>;
}

function findRow(catalogue: CatalogueDocument | null | undefined, key: string): CatalogueRow | undefined {
  return catalogue?.models.find(
    (row) => row.key === key || row.id === key || row.key.endsWith(`/${key}`),
  );
}

function observedModelKey(
  events: readonly RunEvent[],
  catalogue: CatalogueDocument | null | undefined,
  configuredProviders: ReadonlySet<string> | undefined,
): string | undefined {
  for (const event of events) {
    if (event.type !== "model_select" || event.error) continue;
    if (typeof event.key !== "string" || event.key.length === 0) continue;
    const row = findRow(catalogue, event.key);
    if (!row) continue;
    if (configuredProviders && !configuredProviders.has(row.providerID)) continue;
    return row.key;
  }
  return undefined;
}

/**
 * Build new-run settings from a saved run. New records carry an explicit
 * selection snapshot; old records fall back to the summary and model events.
 */
export function forkSettingsFromRun(input: {
  summary: RunSummary;
  events: readonly RunEvent[];
  catalogue?: CatalogueDocument | null;
  defaults: AgentConfig;
  configuredProviders?: ReadonlySet<string>;
}): ForkedRunSettings {
  const { summary, events, catalogue, defaults, configuredProviders } = input;
  const cfg = eventConfig(events);
  const settings = summary.settings;
  // A saved snapshot is authoritative: an absent model means the parent used
  // auto-selection, so do not pin the model that happened to answer. Old runs
  // without a snapshot still fall back to their first successful model.
  const modelKey = settings
    ? settings.model
    : observedModelKey(events, catalogue, configuredProviders);
  const row = modelKey ? findRow(catalogue, modelKey) : undefined;
  const model =
    row && (!configuredProviders || configuredProviders.has(row.providerID))
      ? row.key
      : undefined;
  const tier = settings?.tier ?? (row ? (isFreeRow(row) ? "free" : "paid") : "free");
  const axes = settings?.minAxes;
  const hasAxes = Boolean(axes && Object.keys(axes).length > 0);
  const allZero = hasAxes && Object.values(axes!).every((value) => value === 0);
  const floors = allZero && settings?.minFit === 0 ? "off" : hasAxes ? "strict" : "role";

  return {
    agent: oneOf(summary.agent, AGENT_NAMES, "research"),
    ...(model ? { model } : {}),
    approval: oneOf(summary.approval ?? cfg.approval, APPROVALS, defaults.approval),
    ambiguity: oneOf(summary.ambiguity ?? cfg.ambiguity, AMBIGUITIES, defaults.ambiguity),
    tier,
    kind: (settings && (settings as any).kind) ? (settings as any).kind : "features",
    priority: (settings && (settings as any).priority) ? (settings as any).priority : "medium",
    tags: (settings && (settings as any).tags) ? (settings as any).tags : [],
    minFit: settings?.minFit,
    floors,
    ...((summary.itemId ?? summary.packetId) ? { item: summary.itemId ?? summary.packetId } : {}),
    prompt: summary.request,
  };
}