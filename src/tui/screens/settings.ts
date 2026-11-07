/**
 * machine_code — settings screen.
 *
 * Pure render of the settings table: section headings plus one row per
 * setting with its source file. Takes prebuilt rows and the cursor/scroll
 * state; returns the frame plus the updated scroll offset.
 */
import { basename } from "node:path";
import { B, C, D, M, R, W, Y, background, command, fit, pad, selected, trunc } from "../format.js";
import { settingsFileFor, type SettingRow } from "../settings.js";
import type { Layout } from "../../paths.js";
import { windowedBody, type Viewport } from "./types.js";

export interface SettingsProps extends Viewport {
  layout: Layout;
  rows: SettingRow[];
  selectedIndex: number;
  scroll: number;
}

export function renderSettings(props: SettingsProps): { body: string[]; actions: string; secondary: string; scroll: number } {
  const { cols, narrow, bodyH, theme, toast, layout, rows, selectedIndex } = props;
  const lines: string[] = [];
  let section = "";
  let index = 0;
  let selectedLine = 0;
  const visibleRows: SettingRow[] = [];
  for (const row of rows) {
    if (row.section !== section) {
      section = row.section;
      lines.push(background(fit(` ${B}${theme.sectionFg}${section.toUpperCase()}${R}`, cols), theme.sectionBg));
    }
    const isSelected = index === selectedIndex;
    if (isSelected) selectedLine = lines.length;
    const path = settingsFileFor(layout, row);
    const line = `   ${isSelected ? C + "▸" : " "} ${pad(row.label, narrow ? 20 : 28)} ${W}${trunc(row.value, Math.max(10, cols - (narrow ? 32 : 54)))}${R} ${D}${path ? basename(path) : ""}${R}`;
    lines.push(selected(line, isSelected));
    if (row.detail && !narrow) lines.push(`       ${D}${trunc(row.detail, cols - 8)}${R}`);
    visibleRows.push(row);
    index++;
  }
  const w = windowedBody(lines, Math.min(selectedLine, Math.max(0, lines.length - 1)), props.scroll, bodyH);
  const row = visibleRows[Math.min(selectedIndex, visibleRows.length - 1)];
  return {
    ...w,
    actions: command("j/k", "Select", undefined, M),
    secondary: row ? `${D}${row.label} · ${settingsFileFor(layout, row) ?? "(no file)"}${toast ? ` · ${Y}${toast}${R}` : ""}${R}` : "",
  };
}
