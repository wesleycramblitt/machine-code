/**
 * machine_code — models keys (detail + list).
 *
 * Detail: scroll, `t` probes the selected model, `p`/`o` surface its key.
 * List: move/fold/open, filter toggles (providers, free, coding), grouping
 * and sort cycles, `/` search. Returns true when the key was consumed.
 */
import { CTRL_D, CTRL_U, HALF_PAGE } from "../format.js";
import { loadCatalogue } from "../../catalogue/load.js";
import { loadMachineConfig } from "../../config.js";
import { loadAvailability, saveAvailability } from "../../availability.js";
import { applyProbeResult, probeTarget, targetFor } from "../../availability/probe.js";
import { createModelsCollection } from "../../models.js";
import { layout } from "../../paths.js";
import type { ModelSort } from "../../catalogue/query.js";
import type { TuiState } from "../state.js";
import type { KeyServices } from "./keys.js";

export function handleModelKeys(s: TuiState, ctx: KeyServices, data: string): boolean {
  if (data === "\x1b[A" || data === "k") { s.modelScroll = Math.max(0, s.modelScroll - 1); ctx.draw(); return true; }
  if (data === "\x1b[B" || data === "j") { s.modelScroll++; ctx.draw(); return true; }
  if (data === CTRL_U) { s.modelScroll = Math.max(0, s.modelScroll - HALF_PAGE); ctx.draw(); return true; }
  if (data === CTRL_D) { s.modelScroll += HALF_PAGE; ctx.draw(); return true; }
  if (data === "t") {
    const l = layout(ctx.repoRoot);
    const row = loadCatalogue(l.catalogueFile)?.models.find((entry) => entry.key === s.selectedModelKey);
    if (row) {
      s.probingModels.add(row.key);
      void (async () => {
        try {
          const machine = loadMachineConfig(l);
          const state = loadAvailability(l.home);
          const result = await probeTarget(targetFor(row), machine.availability, state);
          applyProbeResult(state, result);
          saveAvailability(l.home, state);
          ctx.notify(`${row.key}: ${result.status}${result.message ? ` (${result.message})` : ""}`);
        } finally {
          s.probingModels.delete(row.key);
          ctx.draw();
        }
      })();
    }
    ctx.draw();
    return true;
  }
  if (data === "p") { ctx.notify(s.selectedModelKey ?? ""); ctx.draw(); return true; }
  if (data === "o") { ctx.notify(s.selectedModelKey ?? ""); ctx.draw(); return true; }
  ctx.draw();
  return true;
}

export function handleModelsListKeys(s: TuiState, ctx: KeyServices, data: string): boolean {
  if (data === "\x1b[A" || data === "k") { s.modelSel = Math.max(0, s.modelSel - 1); ctx.draw(); return true; }
  if (data === "\x1b[B" || data === "j") {
    s.modelSel = Math.min(Math.max(0, s.modelDisplay.length - 1), s.modelSel + 1);
    ctx.draw();
    return true;
  }
  if (data === CTRL_U) { s.modelSel = Math.max(0, s.modelSel - HALF_PAGE); ctx.draw(); return true; }
  if (data === CTRL_D) {
    s.modelSel = Math.min(Math.max(0, s.modelDisplay.length - 1), s.modelSel + HALF_PAGE);
    ctx.draw();
    return true;
  }
  if (data === " ") {
    const stop = s.modelDisplay[s.modelSel];
    if (stop) {
      const key = stop.key;
      if (s.modelCollapsed.has(key)) s.modelCollapsed.delete(key);
      else {
        s.modelCollapsed.add(key);
        // Collapsing from a row would strand the cursor; land on the header.
        if (stop.kind === "row") {
          const headerIndex = s.modelDisplay.findIndex((candidate) => candidate.kind === "header" && candidate.key === key);
          if (headerIndex >= 0) s.modelSel = headerIndex;
        }
      }
    }
    ctx.draw();
    return true;
  }
  if (data === "\r" || data === "\n") {
    const stop = s.modelDisplay[s.modelSel];
    if (stop?.kind === "header") {
      if (s.modelCollapsed.has(stop.key)) s.modelCollapsed.delete(stop.key);
      else s.modelCollapsed.add(stop.key);
    } else if (stop) { s.selectedModelKey = stop.row.key; s.modelScroll = 0; s.screen = "model"; }
    ctx.draw();
    return true;
  }
  if (data === "a") { s.modelsAll = !s.modelsAll; s.modelSel = 0; ctx.draw(); return true; }
  if (data === "f") {
    s.modelsFree = !s.modelsFree;
    // Free offers usually live on providers without paid credentials. Show
    // the whole catalogue while filtering by price, then the user can
    // press a to narrow back to configured providers.
    if (s.modelsFree) s.modelsAll = true;
    s.modelSel = 0;
    ctx.draw();
    return true;
  }
  if (data === "c") { s.modelsCoding = !s.modelsCoding; s.modelSel = 0; ctx.draw(); return true; }
  if (data === "g") {
    const values: Array<"provider" | "family" | "none"> = ["provider", "family", "none"];
    s.modelGroup = values[(values.indexOf(s.modelGroup) + 1) % values.length]!;
    s.modelSel = 0;
    s.modelCollapsed.clear();
    ctx.draw();
    return true;
  }
  if (data === "s") {
    const values: ModelSort[] = ["capability", "fit", "reasoning", "code", "agentic", "general", "context", "price-in", "price-out", "name"];
    s.modelSort = values[(values.indexOf(s.modelSort) + 1) % values.length]!;
    s.modelSel = 0;
    ctx.draw();
    return true;
  }
  if (data === "/") { s.searchMode = true; s.searchText = ctx.searchSeed(); ctx.draw(); return true; }
  ctx.draw();
  return true;
}
