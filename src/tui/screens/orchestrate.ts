/**
 * machine_code — orchestration page.
 *
 * Per-repo orchestration control screen: status, editable settings (worker
 * count, model tier, per-role min-fit floors), the resolved model preview,
 * and live counters over orchestrator-started runs. Pure render — state and
 * settings come from the caller; the key handler persists edits through the
 * orchestrator store (src/orchestration/store.ts).
 */
import {
  B, W, D, R, Y, G, GR, M,
  background, command, commandBadge, fit, joinCommands, pad,
  START_BG, WHITE, type UiTheme,
} from "../format.js";
import type { OrchestratorSettings } from "../../orchestration/store.js";
import type { Viewport } from "./types.js";

export interface OrchestrateProps extends Viewport {
  repoRoot: string;
  /** Whether the orchestrator is running for this repo (store `active`). */
  active: boolean;
  settings: OrchestratorSettings;
  /** Selected settings row (0..3). */
  sel: number;
  counters: { running: number; awaiting: number; failed: number };
  /** Resolved model name per role; null when the picker found nothing eligible. */
  preview: { engineer: string | null; research: string | null };
}

export function renderOrchestrate(props: OrchestrateProps): { body: string[]; actions: string; secondary: string } {
  const { cols, narrow, bodyH, theme, toast, repoRoot, active, settings, sel, counters, preview } = props;
  const tierLabel = settings.tier === "paid" ? "cloud" : settings.tier;

  const settingRow = (index: number, label: string, value: string): string => {
    const picked = index === sel;
    const cursor = picked ? `${Y}▸${R}` : " ";
    const markers = picked ? `${D}◂ ${R}` : "  ";
    const tail = picked ? ` ${D}▸${R}` : "";
    return ` ${cursor} ${W}${pad(label, narrow ? 17 : 19)}${R}${markers}${G}${value}${R}${tail}`;
  };
  const modelLine = (role: string, name: string | null): string =>
    `   ${D}${pad(role, 9)}${R} ${name ? `${W}${name}${R}` : `${D}no eligible model${R}`}`;

  const lines: string[] = [
    background(fit(` ${B}${W}Orchestration${R}  ${D}${repoRoot}${R}`, cols), theme.sectionBg),
    "",
    ` Status: ${active ? `${G}${B}Running${R}` : `${D}Inactive${R}`}`,
    "",
    ` ${B}Settings${R} ${D}(←/→ change, j/k select)${R}`,
    settingRow(0, "processes", String(settings.processes)),
    settingRow(1, "tier", tierLabel),
    settingRow(2, "engineer minFit", settings.engineerMinFit.toFixed(2)),
    settingRow(3, "research minFit", settings.researchMinFit.toFixed(2)),
    "",
    ` ${B}Models${R}`,
    modelLine("engineer", preview.engineer),
    modelLine("research", preview.research),
    "",
    ` Running: ${W}${counters.running}${R}  Awaiting: ${W}${counters.awaiting}${R}  Failed: ${W}${counters.failed}${R}`,
  ];

  return {
    body: lines.slice(0, bodyH),
    actions: joinCommands([
      command("j/k", "Select", undefined, M),
      command("←/→", "Change", undefined, M),
      active
        ? commandBadge("Stop", ":!", START_BG, WHITE)
        : commandBadge("Start", ":!", START_BG, WHITE),
      command("Esc", "Back", undefined, GR),
    ]),
    secondary: `${D}${repoRoot}${toast ? ` · ${Y}${toast}${R}` : ""}${R}`,
  };
}
