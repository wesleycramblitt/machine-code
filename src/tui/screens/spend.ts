/**
 * machine_code — spend screen.
 *
 * Pure render of the cost ledger: header totals plus per-provider / model /
 * day / agent buckets with bars. Takes the window size, theme, and grouping;
 * returns the frame plus the updated scroll offset.
 */
import { join } from "node:path";
import { B, W, D, R, Y, C, G, M, GR, agentTone, background, command, fit, fmtMoney, fmtTokens, joinCommands, pad } from "../format.js";
import { readSpendSummary, spendBar, spendDays } from "../../spend.js";
import { windowedBody, type Viewport } from "./types.js";

export type SpendGroup = "provider" | "model" | "day" | "agent" | "project";

export interface SpendProps extends Viewport {
  home: string;
  hoursWindow: number;
  groupBy: SpendGroup;
  scroll: number;
}

/** Human-readable label for an hours window (0 = all time). */
function rangeLabel(hours: number): string {
  if (hours === 0) return "all time";
  if (hours === 1) return "last hour";
  if (hours < 24) return `last ${hours} hours`;
  if (hours < 24 * 30) return `last ${Math.round(hours / 24)} days`;
  return `last ${Math.round(hours / 24 / 30)} months`;
}

export function renderSpend(props: SpendProps): { body: string[]; actions: string; secondary: string; scroll: number } {
  const { cols, narrow, bodyH, theme, toast, home, hoursWindow, groupBy } = props;
  const query = { hours: hoursWindow === 0 ? undefined : hoursWindow };
  const summary = readSpendSummary(home, query);
  const headerLines = [
    ` ${B}${W}Spend${R} ${D}${rangeLabel(hoursWindow)}${R}`,
    ` ${Y}${summary.totalActual.toFixed(4)}${R} actual  ${D}${summary.totalEstimated.toFixed(4)} estimate${R}  ${C}${fmtTokens(summary.totalTokens)}${R} tok`,
  ];
  const lines: string[] = [
    ...headerLines.map((line) => background(fit(line, cols), theme.sectionBg)),
    "",
  ];
  if (groupBy === "day") {
    const days = hoursWindow === 0 ? 30 : Math.min(Math.max(1, Math.round(hoursWindow / 24)), 90);
    const series = spendDays(summary, days);
    const max = Math.max(0, ...series.map((entry) => entry.bucket.actual));
    for (const entry of series.slice(-Math.max(4, bodyH - 5))) {
      lines.push(`  ${entry.day} ${spendBar(entry.bucket.actual, max, Math.max(8, Math.min(24, cols - 28)))} ${fmtMoney(entry.bucket.actual)}  ${D}${fmtTokens(entry.bucket.tokens)} tok${R}`);
    }
  } else {
    const buckets =
      groupBy === "provider" ? summary.byProvider :
      groupBy === "model" ? summary.byModel :
      groupBy === "project" ? summary.byProject :
      summary.byAgent;
    const entries = Object.entries(buckets).sort((a, b) => b[1].actual - a[1].actual).slice(0, 40);
    const max = Math.max(0, ...entries.map(([, bucket]) => bucket.actual));
    for (const [key, bucket] of entries) {
      const label = groupBy === "project" ? key.replace(/^.*\/([^/]+)$/, "$1") : key;
      const perMillion = bucket.tokens > 0 ? bucket.actual / (bucket.tokens / 1_000_000) : 0;
      const keyTone = groupBy === "agent" ? agentTone(key) : W;
      lines.push(`  ${keyTone}${pad(label, narrow ? 20 : 38)}${R} ${spendBar(bucket.actual, max, narrow ? 4 : 10)} ${fmtMoney(bucket.actual)}  ${D}${String(bucket.calls).padStart(4)} calls · ${fmtTokens(bucket.tokens)} tok${perMillion > 0 ? ` · ${fmtMoney(perMillion)}/Mtok` : ""}${R}`);
    }
  }
  const w = windowedBody(lines, props.scroll, props.scroll, bodyH);
  return {
    ...w,
    actions: joinCommands([
      command("g", "Group", groupBy, C),
      command("d", "Range", rangeLabel(hoursWindow), Y),
      command("j/k", "Scroll", undefined, M),
      command("^D/^U", "Page", undefined, M),
      command("r", "Refresh", undefined, GR),
    ]),
    secondary: `${D}ledger ${join(home, "spend.jsonl")}${toast ? ` · ${Y}${toast}${R}` : ""}${R}`,
  };
}
