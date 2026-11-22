/**
 * machine_code — orchestration page keys.
 *
 * j/k (or arrows) move the settings cursor; left/right (or h/l) cycle the
 * selected setting and persist it straight to the repo's orchestrator store,
 * so edits survive restarts and reach the next run the orchestrator starts.
 * `:` arms the two-key `:!` command — Start when inactive, Stop when running.
 */
import { layout } from "../../paths.js";
import {
  ORCHESTRATOR_MIN_FITS,
  ORCHESTRATOR_PROCESSES,
  readOrchestratorState,
  updateOrchestratorState,
} from "../../orchestration/store.js";
import type { TuiState } from "../state.js";
import type { KeyServices } from "./keys.js";

/** Editable settings rows on the orchestration page, in render order. */
const ORCHESTRATE_ROWS = 5;

export function handleOrchestrateKeys(s: TuiState, ctx: KeyServices, data: string): boolean {
  if (s.orchestrateColon) {
    s.orchestrateColon = false;
    if (data === "!") {
      const repo = s.orchestrateRepo ?? ctx.repoRoot;
      if (readOrchestratorState(layout(repo)).active) {
        ctx.stopOrchestrator(repo);
        ctx.notify("orchestrator stopped");
      } else {
        ctx.startOrchestrator(repo);
        ctx.notify("orchestrator started");
      }
    }
    ctx.draw();
    return true;
  }
  if (data === ":") { s.orchestrateColon = true; ctx.draw(); return true; }
  // Esc returns to the runs list like every other detail screen.
  if (data === "\x1b") { s.screen = "list"; ctx.draw(); return true; }
  if (data === "j" || data === "\x1b[B") {
    s.orchestrateSel = Math.min(ORCHESTRATE_ROWS - 1, s.orchestrateSel + 1);
    ctx.draw();
    return true;
  }
  if (data === "k" || data === "\x1b[A") {
    s.orchestrateSel = Math.max(0, s.orchestrateSel - 1);
    ctx.draw();
    return true;
  }
  if (data === "\x1b[C" || data === "l" || data === "\x1b[D" || data === "h") {
    const repo = s.orchestrateRepo;
    if (!repo) { ctx.draw(); return true; }
    const forward = data === "\x1b[C" || data === "l";
    const dir = forward ? 1 : -1;
    const repoLayout = layout(repo);
    const settings = readOrchestratorState(repoLayout).settings;
    if (s.orchestrateSel === 0) {
      const index = ORCHESTRATOR_PROCESSES.indexOf(settings.processes);
      const next = ORCHESTRATOR_PROCESSES[(index + dir + ORCHESTRATOR_PROCESSES.length) % ORCHESTRATOR_PROCESSES.length]!;
      updateOrchestratorState(repoLayout, { settings: { processes: next } });
    } else if (s.orchestrateSel === 1) {
      const order = ["paid", "free", "local"] as const;
      const index = order.indexOf(settings.tier);
      const next = order[(index + dir + order.length) % order.length]!;
      updateOrchestratorState(repoLayout, {
        settings: { tier: next, ...(settings.tier2 === next ? { tier2: "none" as const } : {}) },
      });
    } else if (s.orchestrateSel === 2) {
      // Fallback tier: none disables it; it can never equal the primary tier.
      const order = (["none", "paid", "free", "local"] as const).filter((tier) => tier !== settings.tier);
      const index = Math.max(0, order.indexOf(settings.tier2));
      const next = order[(index + dir + order.length) % order.length]!;
      updateOrchestratorState(repoLayout, { settings: { tier2: next } });
    } else {
      // Min-fit floors cycle the shared 4–8.5 / 0.25 ladder.
      const engineer = s.orchestrateSel === 3;
      const value = engineer ? settings.engineerMinFit : settings.architectMinFit;
      const index = ORCHESTRATOR_MIN_FITS.findIndex((fit) => fit === value);
      const next = ORCHESTRATOR_MIN_FITS[(index + dir + ORCHESTRATOR_MIN_FITS.length) % ORCHESTRATOR_MIN_FITS.length]!;
      updateOrchestratorState(repoLayout, {
        settings: engineer ? { engineerMinFit: next } : { architectMinFit: next },
      });
    }
    ctx.draw();
    return true;
  }
  ctx.draw();
  return true;
}
