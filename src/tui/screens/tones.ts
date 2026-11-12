/**
 * machine_code — shared issue tone tables.
 *
 * The runs list and the issue detail page color kind badges and status
 * slugs from these one source so the two pages cannot drift. Rendering
 * helpers stay in format.ts; these tables are issue semantics.
 */
import { AMBER, B, D, PURPLE_BG, PURPLE_FG, RED, RED_BG, RED_FG, ROSE, SKY, SLATE, YELLOW_BG, YELLOW_FG, R } from "../format.js";
import type { DisplayStatus, IssueKind } from "../../plan/issues.js";

const DONE_STYLE = { tone: D, glyph: "✓" };

/** Directory-status colors for non-terminal states; done/researched use gray. */
export const ISSUE_STATUS_STYLE: Record<DisplayStatus, { tone: string; glyph: string }> = {
  "needs-research": { tone: AMBER, glyph: "?" },
  researched: DONE_STYLE,
  todo: { tone: SLATE, glyph: "◆" },
  "in-progress": { tone: SKY, glyph: "●" },
  "needs-human-review": { tone: AMBER, glyph: "◷" },
  "failed-gates": { tone: RED, glyph: "✗" },
  "failed-human-review": { tone: RED, glyph: "✗" },
  blocked: { tone: ROSE, glyph: "⏸" },
  done: DONE_STYLE,
};

/** Kind background colors: purple for ideas, yellow for features, red for bugs. */
export const KIND_BG: Record<string, string> = {
  idea: PURPLE_BG,
  feature: YELLOW_BG,
  bug: RED_BG,
};

/** Kind text colors for todo/needs-research slugs: the same light colors as the kind headers' backgrounds. Keys match IssueKind. */
export const KIND_FG: Record<IssueKind, string> = {
  ideas: PURPLE_FG,
  features: YELLOW_FG,
  bugs: RED_FG,
};

/** Dark foreground for kind badges on their brand background (black bold). */
export const KIND_BADGE_FG = "\x1b[38;2;20;20;20m";

const SINGULAR_KIND: Record<IssueKind, string> = {
  ideas: "idea",
  features: "feature",
  bugs: "bug",
};

/** The runs-page kind background for an issue's kind. */
export function kindBg(kind: IssueKind): string {
  return KIND_BG[SINGULAR_KIND[kind]] ?? "";
}

/**
 * The runs-page tone for an issue's slug/status: `todo` / `needs-research`
 * use the kind's brand foreground; every other status uses its status tone.
 */
export function issueTone(status: DisplayStatus, kind: IssueKind): string {
  const style = ISSUE_STATUS_STYLE[status];
  if (status === "todo" || status === "needs-research") return KIND_FG[kind] ?? style.tone;
  return style.tone;
}

/** A kind badge: brand background, dark bold label, e.g. " Bug ". */
export function kindBadge(kind: IssueKind, label: string): string {
  return `${kindBg(kind)}${B}${KIND_BADGE_FG} ${label} ${R}`;
}
