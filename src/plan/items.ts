/**
 * machine_code — plan items.
 *
 * A plan file is a category; its checklist lines are items. Items are typed
 * flexibly: the nearest heading decides when it names a feature/bug/idea
 * (`## Bugs`), otherwise the line text is inspected (`- [ ] fix the crash`).
 * A `→ packets/<slug>.md` link binds an item to its build contract, and the
 * checkbox (`[x]`) is the done status — there is no `## Done` category.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Layout } from "../paths.js";
import { discoverPlanFiles } from "../context/plans.js";
import { slugify } from "./slug.js";

export type PlanItemKind = "feature" | "bug" | "idea" | "other";

export const PLAN_ITEM_KINDS: readonly PlanItemKind[] = ["feature", "bug", "idea", "other"];

export const PLAN_ITEM_KIND_LABELS: Record<PlanItemKind, string> = {
  feature: "Features",
  bug: "Bugs",
  idea: "Ideas",
  other: "Other",
};

export type PlanItemStatus = "todo" | "in-progress" | "blocked" | "done";

export interface PlanItem {
  /** Repo-relative source plan file. */
  plan: string;
  /** Display name: the plan file's first heading, else its file name. */
  planTitle: string;
  kind: PlanItemKind;
  /** Packet slug when linked, else a slug derived from the line text. */
  slug: string;
  title: string;
  done: boolean;
  /** `[~]` marker: hidden from the default view, kept for history. */
  archived: boolean;
  /** Linked packet slug from `→ packets/<slug>.md`. */
  packet?: string;
  /** 0-based source line, for stable ordering. */
  line: number;
}

const ITEM_LINE = /^\s*[-*]\s*\[([ xX~])\]\s+(.+?)\s*$/;
const PACKET_LINK = /→\s*packets\/([a-z0-9-]+)\.md/;
const LEADING_SLUG = /^([a-z0-9][a-z0-9-]{1,60})\s+[—–-]\s+(.+)$/;
const HEADING = /^\s*#{1,6}\s+/;

function kindFromHeading(heading: string): PlanItemKind | null {
  const text = heading.toLowerCase();
  if (/\b(features?|enhancements?)\b/.test(text)) return "feature";
  if (/\b(bugs?|fixes?|defects?|regressions?)\b/.test(text)) return "bug";
  if (/\b(ideas?|proposals?|explorations?|thoughts?)\b/.test(text)) return "idea";
  return null;
}

function kindFromText(text: string): PlanItemKind {
  const lower = text.toLowerCase();
  if (/\b(bugs?|broken|crash(es|ed|ing)?|regression|fix(es|ed|ing)?|error)\b/.test(lower)) return "bug";
  if (/\b(ideas?|maybe|investigate|explore|consider|proposal|thought)\b/.test(lower)) return "idea";
  return "feature";
}

const GENERIC_TITLES = new Set(["overview", "introduction", "intro", "plan", "plans", "notes", "summary"]);

function fileTitle(path: string): string {
  const base = (path.split("/").pop() ?? path).replace(/\.md$/, "");
  return base
    .split(/[-_]/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

/** Short, stable slug from a sentence: drop `Feature #12:` noise, keep 5 words. */
function deriveSlug(text: string, fallback: number): string {
  const cleaned = text
    .replace(/^[A-Za-z]+\s*#\d+\s*[:—-]\s*/, "")
    .replace(/[#:]/g, " ");
  const words = cleaned
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .slice(0, 5)
    .join("-");
  return slugify(words) || `item-${fallback}`;
}

function planTitleOf(path: string, text: string): string {
  const heading = text.split("\n").find((line) => /^#\s+/.test(line));
  if (heading) {
    const title = heading.replace(/^#+\s+/, "").trim();
    // A file-level "Overview"/"Plan" says nothing; the file name is the
    // category the user actually recognizes (TUI, Models, …).
    if (title && !GENERIC_TITLES.has(title.toLowerCase())) return title;
  }
  return fileTitle(path);
}

/**
 * Every plan item across `plans/` and `.machine_code/plans/`, in file then
 * line order. Non-checklist prose is ignored, so existing plan documents can
 * grow items without being rewritten.
 */
export function planItems(layout: Layout, configured?: string): PlanItem[] {
  const root = layout.repoRoot;
  const out: PlanItem[] = [];
  for (const plan of discoverPlanFiles(layout, configured)) {
    let text = "";
    try {
      text = readFileSync(join(root, plan), "utf8");
    } catch {
      continue;
    }
    const planTitle = planTitleOf(plan, text);
    let headingKind: PlanItemKind | null = null;
    let inFence = false;
    const lines = text.split("\n");
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index]!;
      // Examples inside fenced code blocks are documentation, not work items.
      if (/^\s*(```|~~~)/.test(line)) {
        inFence = !inFence;
        continue;
      }
      if (inFence) continue;
      if (HEADING.test(line)) {
        headingKind = kindFromHeading(line.replace(HEADING, ""));
        continue;
      }
      const match = ITEM_LINE.exec(line);
      if (!match) continue;
      let body = match[2]!.trim();
      let packet: string | undefined;
      const link = PACKET_LINK.exec(body);
      if (link?.[1]) {
        packet = link[1];
        body = body.replace(link[0], "").replace(/\s+—\s*$/, "").trim();
      }
      // `- [ ] slug — title` uses the leading token as the slug; anything else
      // derives one from the text.
      let explicitSlug: string | undefined;
      const leading = LEADING_SLUG.exec(body);
      if (leading?.[1] && leading[2]) {
        explicitSlug = leading[1];
        body = leading[2].trim();
      }
      const kind = headingKind ?? kindFromText(body);
      const slug = packet ?? explicitSlug ?? deriveSlug(body, index + 1);
      const mark = match[1]!.toLowerCase();
      out.push({
        plan,
        planTitle,
        kind,
        slug,
        title: body,
        done: mark === "x",
        archived: mark === "~",
        ...(packet ? { packet } : {}),
        line: index,
      });
    }
  }
  return out;
}

function lineRefersTo(line: string, slug: string): boolean {
  if (line.includes(`packets/${slug}.md`)) return true;
  const match = ITEM_LINE.exec(line);
  if (!match) return false;
  const body = match[2]!.trim();
  return body.startsWith(`${slug} —`) || body.startsWith(`${slug} -`) || body === slug;
}

/**
 * Mark a plan item done in place (`- [ ]` → `- [x]`). Done is a status, so
 * completion never moves the line to a separate category. Returns the plan
 * files that changed.
 */
export function markItemDone(layout: Layout, slug: string, configured?: string): string[] {
  const changed: string[] = [];
  for (const plan of discoverPlanFiles(layout, configured)) {
    const file = join(layout.repoRoot, plan);
    let lines: string[];
    try {
      lines = readFileSync(file, "utf8").split("\n");
    } catch {
      continue;
    }
    let touched = false;
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index]!;
      if (!ITEM_LINE.test(line) || !lineRefersTo(line, slug)) continue;
      const next = line.replace(/^(\s*[-*]\s*\[)[ xX~](\])/, "$1x$2");
      if (next !== line) {
        lines[index] = next;
        touched = true;
      }
    }
    if (touched) {
      writeFileSync(file, lines.join("\n"), "utf8");
      changed.push(plan);
    }
  }
  return changed;
}

/** Remove every plan-item line referencing a slug (delete path). */
export function removeItemFromPlans(layout: Layout, slug: string, configured?: string): string[] {
  const changed: string[] = [];
  for (const plan of discoverPlanFiles(layout, configured)) {
    const file = join(layout.repoRoot, plan);
    let lines: string[];
    try {
      lines = readFileSync(file, "utf8").split("\n");
    } catch {
      continue;
    }
    const next = lines.filter((line) => !(ITEM_LINE.test(line) && lineRefersTo(line, slug)));
    if (next.length !== lines.length) {
      writeFileSync(file, next.join("\n"), "utf8");
      changed.push(plan);
    }
  }
  return changed;
}

/**
 * Prose around an item in its plan file: the nearest heading above it through
 * the next heading of the same or higher level. This is the item's background
 * on the detail page, without reading the whole document into the UI.
 */
export function planItemBackground(layout: Layout, item: PlanItem): string[] {
  let lines: string[];
  try {
    lines = readFileSync(join(layout.repoRoot, item.plan), "utf8").split("\n");
  } catch {
    return [];
  }
  const level = (line: string): number => (/^\s*(#{1,6})\s+/.exec(line)?.[1]?.length ?? 0);
  let start = -1;
  let startLevel = 0;
  for (let index = Math.min(item.line, lines.length - 1); index >= 0; index--) {
    const depth = level(lines[index]!);
    if (depth > 0) {
      start = index;
      startLevel = depth;
      break;
    }
  }
  if (start < 0) return [];
  const out: string[] = [];
  for (let index = start; index < lines.length; index++) {
    if (index > start && level(lines[index]!) > 0 && level(lines[index]!) <= startLevel) break;
    out.push(lines[index]!);
  }
  return out.map((line) => line.trim()).filter((line) => line.length > 0);
}
