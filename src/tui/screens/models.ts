/**
 * machine_code — models screens (list + detail).
 *
 * Pure renders of the catalogue browser and the per-model detail view.
 * The list groups rows by provider/family with foldable headers; the detail
 * shows capability axes, offer, availability, and sibling providers. Row
 * filtering happens upstream in the TUI root; these take the visible rows.
 */
import { B, BL, C, D, G, GR, M, R, RED, W, Y, ago, agentTone, background, command, fit, fmtContext, joinCommands, pad, progress, selected, trunc, visible } from "../format.js";
import { groupModels, siblingOffers, type ModelSort } from "../../catalogue/query.js";
import { loadCuration } from "../../catalogue/refresh.js";
import { loadAvailability } from "../../availability.js";
import { axisWeights } from "../../select.js";
import { CAPABILITY_AXES, loadPolicy } from "../../config.js";
import type { CatalogueRow } from "../../catalogue/types.js";
import { layout } from "../../paths.js";
import { windowedBody, type Viewport } from "./types.js";

export type ModelGroup = "provider" | "family" | "none";

export type ModelDisplayRow =
  | { kind: "header"; key: string }
  | { kind: "row"; key: string; row: CatalogueRow };

/** Role axis weights for the current composer agent (fit ranking). */
export function policyWeightsFor(agent: string): Partial<Record<"reasoning" | "code" | "agentic" | "general", number>> | undefined {
  try {
    const l = layout();
    const policy = loadPolicy(l);
    const ap = policy.agents[agent];
    return ap ? axisWeights(agent, ap) : undefined;
  } catch {
    return undefined;
  }
}

export function modelWeightedFit(
  row: CatalogueRow,
  weights: Partial<Record<"reasoning" | "code" | "agentic" | "general", number>> | undefined,
): number {
  if (!weights) return row.scores.capability;
  const base = { reasoning: weights.reasoning ?? 0.25, code: weights.code ?? 0.25, agentic: weights.agentic ?? 0.25, general: weights.general ?? 0.25 };
  const sum = base.reasoning + base.code + base.agentic + base.general;
  if (sum <= 0) return row.scores.capability;
  return (
    row.scores.reasoning * (base.reasoning / sum) +
    row.scores.code * (base.code / sum) +
    row.scores.agentic * (base.agentic / sum) +
    row.scores.general * (base.general / sum)
  );
}

export interface ModelsListProps extends Viewport {
  home: string;
  repoRoot: string;
  rows: CatalogueRow[];
  group: ModelGroup;
  collapsed: ReadonlySet<string>;
  selected: number;
  scroll: number;
  filterText: string;
  showAllProviders: boolean;
  freeOnly: boolean;
  codingOnly: boolean;
  sort: ModelSort;
  probing: ReadonlySet<string>;
}

export interface ModelsListFrame {
  body: string[];
  actions: string;
  secondary: string;
  scroll: number;
  display: ModelDisplayRow[];
  selected: number;
}

export function renderModelsList(props: ModelsListProps): ModelsListFrame {
  const { cols, narrow, bodyH, theme, rows, group, collapsed, probing, filterText } = props;
  let sel = props.selected;
  const lines: string[] = [];
  const groups = groupModels(rows, group);
  // Cursor stops on headers and rows alike: collapsing every group can
  // never strand the cursor, and space on a header reopens it.
  const stops: ModelDisplayRow[] = [];
  for (const g of groups) {
    stops.push({ kind: "header", key: g.key });
    if (!collapsed.has(g.key)) {
      for (const row of g.rows) stops.push({ kind: "row", key: g.key, row });
    }
  }
  if (sel >= stops.length) sel = Math.max(0, stops.length - 1);
  const modelsAvail = loadAvailability(props.home);
  const now = Date.now();
  let selectedLine = 0;
  for (let s = 0; s < stops.length; s++) {
    const stop = stops[s]!;
    const isSelected = s === sel;
    if (isSelected) selectedLine = lines.length;
    if (stop.kind === "header") {
      const g = groups.find((candidate) => candidate.key === stop.key)!;
      const isCollapsed = collapsed.has(g.key);
      const marker = isCollapsed ? "▸" : "▾";
      const headerText = fit(` ${B}${theme.sectionFg}${marker} ${g.key}${R} ${D}(${g.rows.length})${R}`, cols);
      // A focused header gets the same BG selection as model rows; the
      // section background is reserved for the idle state so selection
      // stays obvious instead of drowning in the panel color.
      lines.push(
        isSelected ? selected(headerText, true) : background(headerText, theme.sectionBg),
      );
      continue;
    }
    const row = stop.row!;
    {
      const free = row.free || (row.pricing.input === 0 && row.pricing.output === 0) ? ` ${G}free${R}` : "";
      const cooling = (() => {
        if (probing.has(row.key)) return ` ${C}…${R}`;
        const phase = modelsAvail.models[row.key];
        if (!phase?.cooldownUntil || phase.cooldownUntil <= now) return "";
        const minutes = Math.max(1, Math.ceil((phase.cooldownUntil - now) / 60_000));
        return ` ${Y}⏱${minutes >= 60 ? `${Math.ceil(minutes / 60)}h` : `${minutes}m`}${R}`;
      })();
      const axes = narrow ? "" : ` ${D}R${row.scores.reasoning.toFixed(1)} C${row.scores.code.toFixed(1)} A${row.scores.agentic.toFixed(1)} G${row.scores.general.toFixed(1)}${R}`;
      const left = `   ${row.coding === false ? `${GR}○${R}` : `${G}●${R}`} ${BL}${trunc(row.name, narrow ? 20 : 30)}${R}${free}${cooling}`;
      const right = `${D}${fmtContext(row.context)}${R} ${D}cap${R} ${row.scores.capability.toFixed(1)}${axes} ${Y}$${row.pricing.input}${R}/${Y}$${row.pricing.output}${R}`;
      lines.push(selected(` ${narrow ? trunc(left, Math.max(18, cols - 18)) + " " + right : pad(left, Math.max(26, cols - visible(right) - 2)) + right}`, isSelected));
    }
  }
  if (lines.length === 0) lines.push(` ${D}No matching models.${R}`);
  // Vetoed rows never enter the catalogue; list them dimmed with their
  // reason so a missing model is explainable in place (curation.toml).
  const vetoed = [...loadCuration(layout(props.repoRoot)).models.entries()].filter(([, entry]) => entry.veto === true);
  const vetoQuery = filterText.trim().toLowerCase();
  const shownVetoed = vetoed.filter(([key]) => vetoQuery.length === 0 || key.toLowerCase().includes(vetoQuery));
  if (shownVetoed.length > 0) {
    lines.push("", ` ${D}Vetoed (${shownVetoed.length}) — excluded by ~/.machine_code/curation.toml; remove the stanza to restore${R}`);
    for (const [key, entry] of shownVetoed) {
      const why = [entry.source ?? entry.note, entry.date].filter((part) => part && part.length > 0).join(" · ");
      lines.push(`  ${GR}✕ ${key}${R}${why ? ` ${D}${trunc(why, Math.max(10, cols - key.length - 8))}${R}` : ""}`);
    }
  }
  const w = windowedBody(lines, Math.min(selectedLine, Math.max(0, lines.length - 1)), props.scroll, bodyH);
  return {
    ...w,
    actions: joinCommands([
      command("Enter", "Details", undefined, G),
      command("space", "Fold", undefined, Y),
      command("/", "Search", undefined, BL),
      command("a", "Providers", props.showAllProviders ? "all" : "configured", C),
      command("f", "Free", props.freeOnly ? "only" : "all", props.freeOnly ? G : GR),
      command("c", "Coding", props.codingOnly ? "only" : "all", props.codingOnly ? G : GR),
      command("g", "Group", group, BL),
      command("s", "Sort", props.sort, C),
      command("j/k", "Move", undefined, GR),
      command("^D/^U", "Page", undefined, GR),
    ]),
    secondary: `${D}space folds groups · Enter opens details${R}`,
    display: stops,
    selected: sel,
  };
}

export interface ModelDetailProps extends Viewport {
  home: string;
  row: CatalogueRow | undefined;
  rows: CatalogueRow[];
  agent: string;
  weights: Partial<Record<"reasoning" | "code" | "agentic" | "general", number>> | undefined;
  probing: boolean;
  scroll: number;
}

export interface ModelDetailFrame {
  body: string[];
  actions: string;
  secondary: string;
  scroll: number;
}

/** Returns null when the row is gone so the router can fall back to the list. */
export function renderModelDetail(props: ModelDetailProps): ModelDetailFrame | null {
  const { cols, bodyH, theme: _theme, toast, row: model, rows, agent, weights, probing, scroll } = props;
  void _theme;
  if (!model) return null;
  const offers = siblingOffers(rows, model);
  const lines: string[] = [
    ` ${B}${W}${model.key}${R}`,
    ` ${D}${model.kind} · ${model.coding ? "coding" : "non-coding"} · ${model.modes.join(", ") || "plain chat"}${R}`,
    "",
    ` ${B}${C}Capability${R}`,
  ];
  for (const axis of CAPABILITY_AXES) {
    const score = model.scores[axis];
    lines.push(`   ${axis.padEnd(10)} ${progress(score * 10, Math.min(24, Math.max(8, Math.floor(cols / 4))))} ${score.toFixed(2)}`);
  }
  lines.push(`   ${"weighted".padEnd(10)} ${weights ? `${D}role ${R}${agentTone(agent)}${agent}${R}` : `${D}neutral${R}`} ${modelWeightedFit(model, weights).toFixed(2)}`);
  lines.push("", ` ${B}${C}Offer${R}`);
  lines.push(`   context ${C}${fmtContext(model.context)}${R} · max out ${C}${fmtContext(model.maxOutput)}${R} · in ${Y}$${model.pricing.input}${R}/M · out ${Y}$${model.pricing.output}${R}/M ${model.free ? `${G}free${R}` : `${RED}paid${R}`}`);
  if (model.benchmarks) {
    lines.push(`   benchmarks ${D}${Object.entries(model.benchmarks).filter(([, value]) => typeof value === "number").slice(0, 6).map(([key, value]) => `${key} ${value}`).join("  ")}${R}`);
  }
  const availabilityState = loadAvailability(props.home);
  const modelHealth = availabilityState.models[model.key];
  const providerHealth = availabilityState.providers[model.providerID];
  const coolingUntil = modelHealth?.cooldownUntil ?? 0;
  const lastProbe = modelHealth?.lastProbeResult;
  const probeTone =
    lastProbe === "ready" ? G : lastProbe === "cooling" ? Y : lastProbe === "unknown" || lastProbe === "skipped" ? D : RED;
  const healthText = probing
    ? `${C}probing${R}`
    : coolingUntil > Date.now()
      ? `${Y}cooling ${Math.max(1, Math.ceil((coolingUntil - Date.now()) / 60_000))}m${R}`
      : lastProbe
        ? `${probeTone}${lastProbe}${R}`
        : `${D}not probed${R}`;
  lines.push("", ` ${B}${C}Availability${R}`);
  lines.push(`   ${healthText}${modelHealth?.lastProbeAt ? ` ${D}· ${ago(new Date(modelHealth.lastProbeAt).toISOString())}${R}` : ""}`);
  const providerBits = [
    providerHealth?.disabled ? `${RED}funds${R}` : "",
    providerHealth?.needsAuth ? `${RED}auth${R}` : "",
    (providerHealth?.cooldownUntil ?? 0) > Date.now()
      ? `${Y}provider cooling ${Math.max(1, Math.ceil(((providerHealth?.cooldownUntil ?? 0) - Date.now()) / 60_000))}m${R}`
      : "",
  ].filter(Boolean);
  if (providerBits.length > 0) lines.push(`   provider ${model.providerID} · ${providerBits.join(" · ")}`);
  lines.push("", ` ${B}${C}Providers offering this model${R}`);
  for (const offer of offers.slice(0, Math.max(3, Math.floor(bodyH / 2)))) {
    lines.push(`   ${offer.providerID === model.providerID ? C + "▸" : " "} ${pad(offer.providerID, 18)} ${Y}$${offer.pricing.input}${R}/${Y}$${offer.pricing.output}${R}  ${D}ctx ${fmtContext(offer.context)}${R}`);
  }
  const w = windowedBody(lines, scroll, scroll, bodyH);
  return {
    ...w,
    actions: joinCommands([
      command("Esc", "Back", undefined, GR),
      command("j/k", "Scroll", undefined, M),
      command("^D/^U", "Page", undefined, M),
      command("t", "Probe", undefined, G),
      command("p", "Copy key", undefined, C),
      command("o", "Provider", undefined, BL),
    ]),
    secondary: `${D}${model.key}${toast ? ` · ${Y}${toast}${R}` : ""}${R}`,
  };
}
