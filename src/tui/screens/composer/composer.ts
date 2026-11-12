/**
 * machine_code — new-run composer screen.
 *
 * Pure-ish render of the run composer: agent/preset/verify controls, the
 * issue link, context tabs (issues, skills, scripts, tools, codebase,
 * references, prompt, files), the prompt box, and the
 * model/issue picker overlays. Props carry snapshots of composer state;
 * the frame returns rendered content plus updated cursor derivations.
 * The skill-mode memo map is mutated in place (render-derived, read by
 * the space-cycle key).
 */
import { statSync } from "node:fs";
import { join } from "node:path";
import {
  B, BL, C, D, G, GR, M, R, RED, W, Y, PANEL_BG, START_BG, WHITE,
  agentTone, background, command, commandBadge, contextTone, fit,
  fmtContext, fmtMoney, fmtTokens, joinCommands, modelPriceText, modelReasonLabel,
  modelReasonRank, modelReasonText, selected, trunc, visible,
  wrapCommands, wrapText, wrapTokenList,
} from "../../format.js";
import { layout } from "../../../paths.js";
import { ENGINEER_WORK_STATUSES, findIssue, listIssues, singleLine, ISSUE_KINDS } from "../../../plan/issues.js";
import { resolveAgent } from "../../../agents/config.js";
import { roleSkillPresets } from "../../../agents.js";
import { defaultSkillsFor, resolveSkillMode, skillMetas, type SkillMode } from "../../../context/references.js";
import { contextBudget } from "../../../context/budget.js";
import { artifactPath, listArtifacts } from "../../../artifacts/registry.js";
import { listReferenceEntries } from "../../../references/store.js";
import { readCachedMap, renderMapIndex, symbolCount } from "../../../map/deterministic.js";
import { suggestHints, type FileHint } from "../../../map/suggest.js";

import { skillListItems, toolListItems, tokensForChars } from "../../tools.js";
import { loadAvailability } from "../../../availability.js";
import { clipLines } from "../types.js";
import type { ForkedRunSettings } from "../../fork.js";
import type { ComposerFrame, ComposerProps, ContextPanelItem } from "./types.js";

export function renderComposer(props: ComposerProps): ComposerFrame {
  const { cols, bodyH, theme, toast, run, repoRoot, home } = props;
  const { insert, cursor, colon } = props;
  const { contextFiltering } = props;
  const contextFilterRaw: string = props.contextFilter;
  const { excluded, included, skillModes, skillShown, preview, pickers } = props;
  let contextTab: number = props.contextTab;
  let contextItem = props.contextItem;
  const contextItemKey = props.contextItemKey;
  let contextSectionKey = "";
  let contextItemKeys: string[] = [];
  let contextItemAvailable: boolean[] = [];
  let modelPickSel = pickers.model?.sel ?? 0;
  let itemPickSel = pickers.issue?.sel ?? 0;
  const modelPickActive = pickers.model !== null;
  const itemPickActive = pickers.issue !== null;
  const modelEntries = pickers.model?.entries ?? [];
  const modelSort = pickers.model?.sort ?? "fit";
  const modelText = pickers.model?.text ?? "";
  const issueList = pickers.issue?.list ?? [];
  const issueText = pickers.issue?.text ?? "";
  let body: string[] = [];
  let actions = "";
  let secondary = "";
  let secondaryStyled = false;
  let bottomAlign: { above: string[]; block: string[]; filler?: string } | null = null;
  let footerMapTokens: string[] = [];
  let footerBandTone = "";
  let footerCtx = "";

  footerMapTokens = props.mapTokens(repoRoot);
  footerBandTone = theme.bodyBg;
    const ctx = preview.context;
  const ap = preview.policy?.agents[run.agent];
  const newRunIssue = run.item ? findIssue(layout(repoRoot), run.item) : undefined;
  const displayAgent = run.agent ? `${run.agent[0]!.toUpperCase()}${run.agent.slice(1)}` : run.agent;
  const resolvedAgent = resolveAgent(layout(repoRoot), run.agent, {
    machineOverrides: preview.machine?.agents[run.agent],
    runOverrides: {
      approval: run.approval,
      ambiguity: run.ambiguity,
    },
  });
  const issueOutcome = (() => {
    if (run.item) {
      if (!newRunIssue) return "issue file is missing";
      return `${newRunIssue.status} · review ${newRunIssue.review}`;
    }
    return "no issue · run is untracked";
  })();
  
  const itemsFor = (kinds: readonly string[]) =>
    ctx.sources
      .filter((source) => kinds.includes(source.kind))
      .map((source) => ({
        text: source.note ? `${source.ref} · ${source.note}` : source.ref,
        chars: source.chars,
        exists: source.exists,
        key: `${source.kind}:${source.ref}`,
      }));
  const referencedToolChars = new Map(
    ctx.sources.filter((source) => source.kind === "tool").map((source) => [source.ref, source.chars]),
  );
  const newRunLayout = layout(repoRoot);
  const artifacts = listArtifacts(newRunLayout);
  const toolItems = toolListItems(
    resolvedAgent.def.tools,
    artifacts
      .filter((artifact) => artifact.kind === "tool")
      .map((artifact) => ({ name: artifact.name, description: artifact.description })),
    referencedToolChars,
  );
  const cachedMap = readCachedMap(repoRoot);
  const runIssue = run.item ? findIssue(newRunLayout, run.item) : null;
  const suggestionPrompt = run.prompt.trim() || runIssue?.prompt || "";
  // Hints refresh from the prompt every frame: matched terms and the top
  // symbols per file, so the row already tells the model where to read.
  // Off means no suggested marks and no auto-seeding for this run.
  const fileHints: FileHint[] = cachedMap && props.hintsEnabled
    ? suggestHints({ map: cachedMap, request: suggestionPrompt, repoRoot, limit: 3 })
    : [];
  const suggestedFiles = new Map(fileHints.map((hint) => [hint.path, hint]));
  const issueItems: ContextPanelItem[] = itemsFor(["issue"]);
  // Every issue as an available row the user can search and opt into with
  // space, filtered by the selected agent. The issue file is the work item's
  // own contract/context.
  const knownIssues = new Set(issueItems.map((item) => item.key));
  for (const issue of listIssues(newRunLayout)) {
    // Filter by agent kind.
    if (run.agent === "research" && issue.kind !== "ideas") continue;
    if (run.agent !== "research" && issue.kind === "ideas") continue;
    if (run.agent === "research" && issue.kind !== "ideas") continue;
    // Engineer: todo, failed attempts, or a legacy blocked state.
    if (run.agent === "engineer" && !(ENGINEER_WORK_STATUSES as readonly string[]).includes(issue.status)) continue;
    const key = `issue:${issue.rel}`;
    if (knownIssues.has(key)) continue;
    let size = 0;
    try {
      size = statSync(join(newRunLayout.repoRoot, issue.rel)).size;
    } catch {
      // keep the row visible with an unknown size
    }
    issueItems.push({
      text: `${issue.slug} · ${issue.kind} [${issue.status}] · available`,
      chars: size,
      exists: true,
      key,
      available: true,
      counted: false,
    });
  }
  const fileItems: ContextPanelItem[] = itemsFor(["file"]);
  const knownFiles = new Set(fileItems.map((item) => item.key));
  // Paths that belong to other context sections; exclude from the file tab.
  const excludedFilePrefixes = [
    "issues/", ".machine_code/skills/", ".machine_code/tools/",
    ".machine_code/scripts/", ".machine_code/references/",
    "docs/", "node_modules/", ".git/",
  ];
  for (const file of cachedMap?.files ?? []) {
    if (excludedFilePrefixes.some((prefix) => file.path.startsWith(prefix))) continue;
    const key = `file:${file.path}`;
    if (knownFiles.has(key)) continue;
    const hint = suggestedFiles.get(file.path);
    const hintLabel = !hint
      ? "available"
      : hint.matched.length > 0
        ? `suggested: ${hint.matched.slice(0, 3).join(", ")}`
        : "suggested";
    fileItems.push({
      text: `${file.path} · ${hintLabel}`,
      chars: file.bytes,
      exists: true,
      key,
      available: true,
      counted: false,
    });
  }
  // Attached references first, then every store bundle as
  // an available row the user can search and opt into with space.
  const referenceItems: ContextPanelItem[] = itemsFor(["reference"]);
  const attachedCitations = new Set(ctx.artifacts.references);
  const attachedPaths = new Set(
    ctx.sources
      .filter((source) => source.kind === "reference")
      .map((source) => source.ref.split("#")[0]),
  );
  for (const entry of listReferenceEntries(newRunLayout)) {
    if (attachedCitations.has(entry.citation)) continue;
    const rel = entry.path.split("#")[0];
    if (attachedPaths.has(rel) || attachedPaths.has(entry.citation)) continue;
    referenceItems.push({
      text: `${entry.citation} · available`,
      chars: Math.min(entry.bytes, 8 * 1024),
      exists: entry.exists,
      key: `reference:${entry.citation}`,
      available: true,
      counted: false,
    });
  }
  const scriptItems: ContextPanelItem[] = itemsFor(["script"]);
  const knownScripts = new Set(scriptItems.map((item) => item.key));
  for (const artifact of artifacts.filter((item) => item.kind === "script")) {
    const key = `script:${artifact.name}`;
    if (knownScripts.has(key)) continue;
    let size = 0;
    const path = artifactPath(newRunLayout, artifact);
    if (path) {
      try {
        size = statSync(path).size;
      } catch {
        // keep the row visible with an unknown size
      }
    }
    scriptItems.push({
      text: `script:${artifact.name} · script · available`,
      chars: size,
      exists: true,
      key,
      available: true,
      counted: false,
    });
  }
  const docItems: ContextPanelItem[] = itemsFor(["docs"]);
  const knownDocs = new Set(docItems.map((item) => item.key));
  for (const file of cachedMap?.files ?? []) {
    if (!file.path.startsWith("docs/")) continue;
    const key = `docs:${file.path}`;
    if (knownDocs.has(key)) continue;
    docItems.push({
      text: `${file.path} · available`,
      chars: file.bytes,
      exists: true,
      key,
      available: true,
      counted: false,
    });
  }
  const skillSources = ctx.sources.filter((source) => source.kind === "skill");
  const aggregateSkill = skillSources.find((source) => /^\d+ skills$/.test(source.ref));
  const skillDefaults = defaultSkillsFor({
    agent: run.agent,
    verification: runIssue?.verification ?? "direct",
  });
  const skillPresets = roleSkillPresets(run.agent);
  const skillOverrides = Object.fromEntries(skillModes);
  const skillModeOf = (name: string): SkillMode => {
    if (excluded.has(`skill:${name}`)) return "exclude";
    return resolveSkillMode(name, {
      presets: skillPresets,
      declared: skillDefaults,
      overrides: skillOverrides,
    });
  };
  // Every installed skill is visible so it can be opted into. Only the
  // role's defaults and explicit includes carry description chars in the
  // prompt; the rest are available rows at zero cost.
  const allSkillMetas = skillMetas(newRunLayout);
  const includeOverrides = Object.entries(skillOverrides)
    .filter(([, mode]) => mode === "include")
    .map(([name]) => name);
  const visibleSkillNames = new Set([...skillDefaults, ...includeOverrides]);
  const visibleSkillMetas = allSkillMetas.filter((skill) => visibleSkillNames.has(skill.name));
  const skillItems: ContextPanelItem[] = skillListItems(
    visibleSkillMetas,
    aggregateSkill?.chars ?? 0,
  );
  const listedSkills = new Set(visibleSkillMetas.map((skill) => skill.name));
  for (const skill of allSkillMetas) {
    if (listedSkills.has(skill.name)) continue;
    skillItems.push({
      text: `${skill.name} · ${skill.description}`,
      chars: 0,
      exists: true,
      key: `skill:${skill.name}`,
    });
  }
  const bodyChars = new Map<string, number>();
  for (const source of skillSources) {
    if (source === aggregateSkill) continue;
    bodyChars.set(source.ref, (bodyChars.get(source.ref) ?? 0) + source.chars);
  }
  // Three modes per skill: include (description + body, marked ✓ body),
  // on-demand (description only, pulled with the skill tool), exclude (✕).
  // Space cycles include → on-demand → exclude. Tags sit right after the name
  // so row truncation cannot hide them. Active modes sort first.
  const tagLocked = (text: string, tags: string[]): string => {
    if (tags.length === 0) return text;
    const insert = ` · ${tags.join(" · ")}`;
    const sep = text.indexOf(" · ");
    return sep < 0 ? text + insert : text.slice(0, sep) + insert + text.slice(sep);
  };
  skillShown.clear();
  for (const item of skillItems) {
    const name = item.key.slice("skill:".length);
    const mode = skillModeOf(name);
    skillShown.set(name, mode);
    const tags: string[] = [];
    if (mode === "include") {
      item.chars += bodyChars.get(name) ?? 0;
      tags.push("body");
    } else if (mode === "on-demand") {
      tags.push("on-demand");
    }
    item.text = tagLocked(item.text, tags);
    bodyChars.delete(name);
  }
  for (const [name, chars] of bodyChars) {
    const mode = skillModeOf(name);
    skillShown.set(name, mode);
    if (mode === "exclude") continue;
    const tags: string[] = [mode === "include" ? "body" : "on-demand"];
    skillItems.push({
      text: tagLocked(name, tags),
      chars: mode === "include" ? chars : 0,
      exists: true,
      key: `skill:${name}`,
    });
  }
  // Defaults the agent wants but no SKILL.md provides: visible as missing
  // instead of silently absent.
  const knownSkillNames = new Set(skillItems.map((item) => item.key.slice("skill:".length)));
  for (const name of skillDefaults) {
    if (knownSkillNames.has(name)) continue;
    knownSkillNames.add(name);
    skillShown.set(name, skillModeOf(name));
    skillItems.push({ text: `${name} · default · missing`, chars: 0, exists: false, key: `skill:${name}` });
  }
  // Row order stays fixed per section (build order) regardless of include/
  // exclude/mode state: the render marks (✓ / ✕ / · / mode tags) convey state,
  // so re-sorting would only make rows and the cursor jump on toggle.
  const floorText = run.floors === "role" ? `role${ap ? ` ${ap.minFit}` : ""}` : run.floors;
  const fitText = run.minFit === undefined ? `role${ap ? ` ${ap.minFit}` : ""}` : String(run.minFit);
  const estimateCost = preview.estimate
    ? fmtMoney(
        ((preview.estimate as { inputTokens: number }).inputTokens * (preview.model?.pricing.input ?? 0) +
          (preview.estimate as { outputTokens: number }).outputTokens * (preview.model?.pricing.output ?? 0)) /
          1_000_000,
      )
    : "?";
  const fitScore = preview.fit;
  const fitTone = fitScore === undefined ? D : fitScore >= 7.5 ? G : fitScore >= 6 ? Y : RED;
  const costTone = preview.model?.free && run.tier === "local" ? G : RED;
  const modelIdentity = preview.error
    ? command("m", "Model", preview.error, RED)
    : command("m", "Model", preview.model?.key ?? "?", C);
  const fitPart = fitScore === undefined ? "" : `${D}fit${R} ${fitTone}${fitScore.toFixed(2)}${R}`;
  const costPart = `${D}cost${R} ${costTone}${estimateCost}${R}`;
  const detailParts = preview.model
    ? [
        `${D}${preview.model.kind}${R}`,
        `${D}ctx${R} ${C}${fmtContext(preview.model.context)}${R}`,
        ...(preview.model.pricing.input > 0
          ? [`${D}in${R} ${Y}$${preview.model.pricing.input}/M${R}`]
          : []),
        ...(preview.model.pricing.output > 0
          ? [`${D}out${R} ${Y}$${preview.model.pricing.output}/M${R}`]
          : []),
      ]
    : [];
  const modelInfo = preview.error
    ? ` ${modelIdentity}`
    : [
        ` ${[modelIdentity, fitPart, costPart, ...detailParts].filter(Boolean).join("  ")}`,
        ` ${[modelIdentity, fitPart, costPart].filter(Boolean).join("  ")}`,
        ` ${modelIdentity}`,
      ].find((line) => visible(line) <= cols) ?? ` ${modelIdentity}`;
  const floorsText = (() => {
    if (!ap) return "floors unavailable";
    if (run.floors === "off") return "off";
    return run.floors;
  })();
  const tierTone = run.tier === "paid" ? G : BL;
  const tierLabel = run.tier === "paid" ? "Paid" : "Local";
  const minimumsText = trunc(
    `${D}${command("f", "fit", fitText, C)}  ${command("F", "floors", floorsText, M)}  ${command("t", "tier", tierLabel, tierTone)}${R}`,
    Math.max(10, cols - 1),
  );
  const minimumsInfo = ` ${" ".repeat(Math.max(0, cols - visible(minimumsText) - 1))}${minimumsText}`;
  const mapEnabled = preview.machine?.map.enabled !== false;
  const mapChars = mapEnabled ? (cachedMap ? renderMapIndex(cachedMap).length : 1024) : 0;
  const codebaseItems = [
    {
      text: mapEnabled
        ? cachedMap
          ? `repo map · ${cachedMap.files.length} files · ${symbolCount(cachedMap)} symbols`
          : "repo map · builds on first turn"
        : "repo map · disabled",
      chars: mapChars,
      exists: mapEnabled && Boolean(cachedMap),
      key: "map:index",
    },
    ];
  // The resolved agent prompt is context too: every line the run will
  // send, listed read-only. Fixed rows are always in context and cannot
  // be switched off, mirroring the core-tool rows.
  const promptItems: ContextPanelItem[] = resolvedAgent.prompt
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line, index) => ({
      text: line,
      chars: line.length,
      exists: true,
      key: `prompt:${index}`,
      fixed: true,
      counted: false,
    }));
  const sections = [
    { label: "Issues", tone: contextTone("issue"), sectionKey: "section:issues", items: issueItems },
    { label: "Skills", tone: contextTone("skill"), sectionKey: "section:skills", items: skillItems },
    { label: "Scripts", tone: contextTone("script"), sectionKey: "section:scripts", items: scriptItems },
    { label: "Tools", tone: contextTone("tool"), sectionKey: "section:tools", items: toolItems },
    { label: "Codebase", tone: BL, sectionKey: "section:codebase", items: codebaseItems },
    { label: "References", tone: contextTone("reference"), sectionKey: "section:references", items: referenceItems },
    { label: "Docs", tone: contextTone("docs"), sectionKey: "section:docs", items: docItems },
    { label: "Agent Prompt", tone: W, sectionKey: "section:prompt", items: promptItems },
    { label: "Files", tone: C, sectionKey: "section:files", items: fileItems },
  ];
  if (contextTab >= sections.length) contextTab = 0;
  const isIncludedAvailable = (item: unknown): boolean => {
    const row = item as ContextPanelItem;
    return (
      row.available === true &&
      (row.key.startsWith("file:") || row.key.startsWith("reference:") || row.key.startsWith("issue:")) &&
      included.has(row.key)
    );
  };
  const isCounted = (item: unknown): boolean => {
    const row = item as ContextPanelItem;
    return row.counted !== false || isIncludedAvailable(row);
  };
  const isShownAvailable = (item: unknown): boolean => {
    const row = item as ContextPanelItem;
    return row.available === true && !isIncludedAvailable(row);
  };
  const excludedTokens = sections.reduce((sum, section) => {
    const sectionOff = excluded.has(section.sectionKey);
    return sum + section.items
      .filter((item) => {
        if (!isCounted(item)) return false;
        if ((item as { fixed?: boolean }).fixed) return false;
        return sectionOff || excluded.has(item.key);
      })
      .reduce((itemSum, item) => itemSum + tokensForChars(item.chars), 0);
  }, 0);
  const totalTokens = sections.reduce(
    (sum, section) =>
      sum +
      section.items
        .filter((item) => isCounted(item))
        .reduce((itemSum, item) => itemSum + tokensForChars(item.chars), 0),
    0,
  );
  const contextTokens = Math.max(0, totalTokens - excludedTokens) + tokensForChars(ctx.promptChars);
  const previewPolicy = preview.policy?.agents[run.agent];
  const modelChars = preview.model && previewPolicy
    ? contextBudget(preview.model.context, previewPolicy.expectedOutputTokens).inputChars
    : undefined;
  const usedChars = contextTokens * 4;
  const contextWarning = modelChars === undefined
    ? ""
    : usedChars >= modelChars
      ? ` ${RED}over model input budget${R}`
      : usedChars >= modelChars * 0.8
        ? ` ${Y}${Math.round((usedChars / modelChars) * 100)}% of model input budget${R}`
        : "";
  footerCtx = `${C}ctx${R} ${W}${(contextTokens / 1000).toFixed(1)}K${R}${contextWarning}`;
  // The context panel and prompt box share the same width.
  const panelWidth = Math.max(20, cols - 2);
  const panelLine = (line: string, isSelected = false, indent = false): string => {
    const body = line.startsWith(" ") ? line.slice(1) : line;
    const padded = fit(indent ? ` ${body}` : body, panelWidth);
    return ` ${isSelected ? selected(padded, true) : background(padded, PANEL_BG)}`;
  };
  const tabBar = wrapTokenList(
    sections.map((section, index) => {
      const label = excluded.has(section.sectionKey) ? `${section.label}✕` : section.label;
      return index === contextTab
        ? `${theme.sectionActiveBg}${theme.sectionActiveFg}${B} ${label} ${R}`
        : `${theme.sectionFg}${label}${R}`;
    }),
    panelWidth,
    "  ",
  ).map((line) => panelLine(line, false, true));
  const activeSection = sections[contextTab]!;
  contextSectionKey = activeSection.sectionKey;
  // `/` narrows the active tab by substring; rows keep their build order.
  const contextFilter = contextFilterRaw.trim().toLowerCase();
  const shownItems = contextFilter
    ? activeSection.items.filter((item) => item.text.toLowerCase().includes(contextFilter))
    : activeSection.items;
  contextItemKeys = shownItems.map((item) => item.key);
  contextItemAvailable = shownItems.map(
    (item) => (item as { available?: boolean }).available === true,
  );
  // Anchor the cursor by row key: toggling include/exclude or cycling a skill
  // mode changes marks, never order, so the remembered key still resolves to
  // the same row. Fall back to the clamped index when the key is gone (a `/`
  // filter or an exclusion that hides the row).
  let anchoredIndex = contextItem;
  if (contextItemKey !== null) {
    const keyIndex = shownItems.findIndex((item) => item.key === contextItemKey);
    if (keyIndex >= 0) anchoredIndex = keyIndex;
  }
  contextItem = Math.min(Math.max(0, anchoredIndex), Math.max(0, shownItems.length - 1));
  const sectionOff = excluded.has(activeSection.sectionKey);
  // Rows render in stable build order; state (kept vs available) is shown by
  // marks and counts only, never by regrouping.
  const keptItems = shownItems.filter((item) => {
    if ((item as { fixed?: boolean }).fixed) return true;
    if (isShownAvailable(item)) return false;
    return !sectionOff && !excluded.has(item.key);
  });
  const sectionTokens = keptItems
    .filter((item) => isCounted(item))
    .reduce((sum, item) => sum + tokensForChars(item.chars), 0);
  const keptLabel = shownItems.length > 0 ? ` · ${keptItems.length}/${shownItems.length} kept` : "";
  const availableLabel = shownItems.some((item) => isShownAvailable(item))
    ? ` · ${shownItems.filter((item) => isShownAvailable(item)).length} available`
    : "";
  const sectionHeader = panelLine(
    `${B}${activeSection.tone}${activeSection.label}${R} ${D}·${R} ${C}${fmtTokens(sectionTokens)}${R}` +
      `${D} tok${keptLabel}${availableLabel}${R}`,
    false,
    true,
  );
  const issueHint = activeSection.sectionKey === "section:issues"
    ? panelLine(` ${D}${issueOutcome}${R}`, false, true)
    : "";
  const itemRoom = Math.max(1, Math.floor(bodyH * 0.28));
  const itemStart = Math.max(
    0,
    Math.min(contextItem - Math.floor(itemRoom / 2), Math.max(0, shownItems.length - itemRoom)),
  );
  const visibleItems = shownItems.slice(itemStart, itemStart + itemRoom);
  const itemLines: string[] = [];
  if (itemStart > 0) itemLines.push(panelLine(`  ${D}… ${itemStart} above${R}`));
  for (let offset = 0; offset < visibleItems.length; offset++) {
    const item = visibleItems[offset]!;
    const index = itemStart + offset;
    const fixed = (item as { fixed?: boolean }).fixed === true;
    const available = isShownAvailable(item);
    const isExcluded = !fixed && !available && (sectionOff || excluded.has(item.key));
    // Fixed rows (agent prompt lines, core tools) are always sent and cannot
    // be toggled: the neutral dim dot reads as static text, not a checkbox.
    const mark = fixed
      ? `${D}·${R}`
      : isExcluded
        ? `${RED}✕${R}`
        : available
          ? `${D}·${R}`
          : item.exists
            ? `${G}✓${R}`
            : `${Y}?${R}`;
    // Prompt lines carry no token count: they are counted:false and their
    // chars feed the section header total, not a per-row column.
    const showCount = !fixed || item.key.startsWith("core-tool:");
    const count = showCount
      ? `${D}${fmtTokens(tokensForChars(item.chars))}${available ? " avail" : ""}${R}`
      : "";
    const line = `  ${mark} ${W}${trunc(item.text, Math.max(12, cols - 30))}${R}${count ? ` ${count}` : ""}`;
    itemLines.push(panelLine(line, index === contextItem));
  }
  const remainingItems = shownItems.length - (itemStart + visibleItems.length);
  if (remainingItems > 0) itemLines.push(panelLine(`  ${D}… ${remainingItems} more${R}`));
  if (contextFiltering || contextFilter) {
    itemLines.push(panelLine(`  ${D}filter: ${contextFilter || "(type)"}${contextFiltering ? "▌" : ""}${R}`));
  }
  const compact = (key: string, label: string, tone: string): string =>
    `${B}${tone}${key}${R} ${D}${label}${R}`;
  // Advertise space only on tabs where the handler actually acts. Skills
  // cycles include→on-demand→exclude; Issues/Files/References toggle include
  // (their rows carry `available` the handler recognizes). Tools and Agent
  // Prompt rows are fixed, and Codebase/Scripts rows use prefixes space
  // ignores, so none of those advertise a toggle.
  const sectionKey = activeSection.sectionKey;
  const togglesInclude = ["section:issues", "section:docs", "section:files", "section:references"].includes(sectionKey);
  const spaceCommand = sectionKey === "section:skills"
    ? `${B}${G}space${R} ${D}include→on-demand→exclude${R}`
    : togglesInclude
      ? `${B}${G}space${R} ${G}✓${R}${D}/${R}${RED}✕${R}`
      : "";
  const contextCommands = panelLine(
    joinCommands([
      compact("h/l", "tabs", Y),
      compact("j/k", "sel", M),
      compact("/", "filter", BL),
      compact("H", props.hintsEnabled ? "hints on" : "hints off", props.hintsEnabled ? C : GR),
      spaceCommand,
    ]),
    false,
    true,
  );
  const summary = [
    modelInfo,
    minimumsInfo,
    "",
    ...tabBar,
    panelLine(""),
    sectionHeader,
    ...(issueHint ? [issueHint] : []),
    ...(itemLines.length ? itemLines : [panelLine(`  ${D}none${R}`)]),
  ];
  if (ctx.warnings.length > 0) summary.push(` ${Y}${ctx.warnings[0]}${R}`);

  const boxWidth = panelWidth;
  const inner = Math.max(12, boxWidth - 2);
  const promptText = run.prompt || (insert ? "" : run.item ? "Press :! to run the issue" : "Press p to type the task");
  // Include the cursor before wrapping so a freshly typed trailing space is
  // not trimmed away until the next keystroke.
  const promptLines = wrapText(insert ? `${promptText}▌` : promptText, Math.max(8, inner - 3));
  const promptActions = insert
    ? joinCommands([
        command("Esc", "Done", undefined, Y),
        command("Enter", "Newline", undefined, G),
        command("Backspace", "Delete", undefined, M),
      ])
    : joinCommands([
        command("p", "Prompt", undefined, M),
        run.prompt.trim() || run.item ? commandBadge("Start", ":!", START_BG, WHITE) : "",
      ]);
  const agentControls = insert
    ? ""
    : joinCommands([
        command("a", "Agent", displayAgent, agentTone(run.agent)),
        command("g", "Ambiguity", run.ambiguity, M),
      ]);
  const runControls = insert
    ? promptActions
    : joinCommands([
        promptActions,
      ]);
  const promptHint =
    !agentControls && !runControls
      ? ""
      : ` ${agentControls}${" ".repeat(Math.max(1, boxWidth - visible(agentControls) - visible(runControls) - 1))}${runControls}`;
  const availableForPrompt = Math.max(3, bodyH - summary.length - (promptHint ? 7 : 6));
  const promptHeight = Math.max(3, Math.min(16, availableForPrompt, Math.floor(bodyH * 0.5)));
  const shownPrompt = promptLines.slice(-promptHeight);
  const promptBox = [
    ` ${D}┌${"─".repeat(inner)}┐${R}`,
    ...shownPrompt.map((line) => ` ${D}│${R} ${W}${fit(line, inner - 2)}${R} ${D}│${R}`),
    ...Array.from({ length: Math.max(0, promptHeight - shownPrompt.length) }, () => ` ${D}│${R} ${" ".repeat(inner - 2)} ${D}│${R}`),
    ` ${D}└${"─".repeat(inner)}┘${R}`,
  ];

  if (modelPickActive) {
    const list = modelEntries;
    const availability = loadAvailability(props.home);
    const total = list.length + 1;
    if (modelPickSel >= total) modelPickSel = Math.max(0, total - 1);
    const autoLine = ` ${run.model === undefined ? `${C}▸` : " "} ${G}Auto${R} ${D}let the selector choose${R}`;
    const entries: string[] = [selected(autoLine, modelPickSel === 0)];
    for (let i = 0; i < list.length; i++) {
      const entry = list[i]!;
      const row = entry.row;
      const chosen = row.key === run.model;
      const free = row.free && run.tier === "local" ? ` ${G}FREE${R}` : "";
      const status = entry.eligible
        ? `${G}✓${R}`
        : entry.reason === "model-cooling" || entry.reason === "provider-cooling"
          ? `${Y}⏸${R}`
          : `${RED}✕${R}`;
      const reason = entry.eligible ? "" : ` ${D}${modelReasonText(entry, availability)}${R}`;
      const line = ` ${chosen ? `${C}▸` : " "} ${status} ${C}${row.key}${R} ${D}fit ${entry.fit.toFixed(2)}${R}${modelPriceText(row)}${free}${reason}`;
      entries.push(selected(line, modelPickSel === i + 1));
    }
    const eligibleCount = list.filter((entry) => entry.eligible).length;
    const reasonCounts = new Map<string, number>();
    for (const entry of list) {
      if (entry.eligible) continue;
      const reason = entry.reason ?? "ineligible";
      reasonCounts.set(reason, (reasonCounts.get(reason) ?? 0) + 1);
    }
    const reasonSummary = [...reasonCounts.entries()]
      .sort(
        (a, b) =>
          modelReasonRank(a[0]) - modelReasonRank(b[0]) ||
          b[1] - a[1] ||
          a[0].localeCompare(b[0]),
      )
      .slice(0, 4)
      .map(([reason, count]) => `${modelReasonLabel(reason)} ${count}`)
      .join(" · ");
    const summaryText =
      `${eligibleCount} eligible · ${list.length - eligibleCount} ineligible` +
      (reasonSummary ? ` · ${reasonSummary}` : "");
    const selectedEntry = modelPickSel > 0 ? list[modelPickSel - 1] : undefined;
    const selectedHint = selectedEntry && !selectedEntry.eligible
      ? ` ${RED}${selectedEntry.row.key}: ${modelReasonText(selectedEntry, availability)}${R}`
      : "";
    const visible = Math.max(1, bodyH - 6);
    const start = Math.max(0, Math.min(modelPickSel - Math.floor(visible / 2), Math.max(0, total - visible)));
    const picker: string[] = [
      ` ${command("Esc", "Back", undefined, GR)}  ${B}${W}Select model${R} ${D}(type to filter; Tab sorts ${modelSort === "price" ? "price" : "fit"}; Enter selects)${R}`,
      ` ${D}${summaryText}${R}`,
      "",
      ...entries.slice(start, start + visible),
      ...(list.length === 0 ? [` ${D}No configured models match this filter.${R}`] : []),
      ...(selectedHint ? [selectedHint] : []),
      "",
      ` ${D}filter: ${modelText || "(all)"}${R}`,
    ];
    body = clipLines(picker.slice(0, bodyH), bodyH);
    actions = joinCommands([
      command("Enter", "Select", undefined, G),
      command("j/k", "Move", undefined, M),
      command("Tab", `Sort: ${modelSort}`, undefined, Y),
      command("Esc", "Close", undefined, GR),
    ]);
    secondary =
      `${D}${list.length} model(s) · ✓ eligible · ⏸ cooling · ✕ ineligible` +
      `${modelText ? ` · “${modelText}”` : ""}${R}` +
      `${toast ? ` · ${Y}${toast}${R}` : ""}`;
  } else if (itemPickActive) {
    const list = issueList;
    if (itemPickSel >= list.length) itemPickSel = Math.max(0, list.length - 1);
    const picker: string[] = [` ${command("Esc", "Back", undefined, GR)}  ${B}${W}Link an issue${R} ${D}(type to filter; Enter selects)${R}`, ""];
    for (let i = 0; i < list.length; i++) {
      const item = list[i]!;
      const isSelected = run.item === item.slug;
      const line = ` ${isSelected ? C + "▸" : " "} ${C}${item.slug}${R} ${D}[${item.status}]${R} ${W}${trunc(singleLine(item.prompt) || "(no prompt)", Math.max(12, cols - item.slug.length - 24))}${R}`;
      picker.push(selected(line, i === itemPickSel));
    }
    picker.push("", ` ${D}filter: ${issueText || "(all)"}${R}`);
    body = clipLines(picker.slice(0, bodyH), bodyH);
    actions = joinCommands([
      command("Enter", "Select", undefined, G),
      command("j/k", "Move", undefined, M),
      command("Esc", "Close", undefined, GR),
    ]);
    secondary = `${D}${list.length} issue(s)${issueText ? ` · “${issueText}”` : ""}${R}`;
  } else {
    // Context and inherited sources stay above; the composer is pinned to
    // the bottom of the body so it sits directly above the key-command row.
    bottomAlign = {
      above: summary,
      block: [
        contextCommands,
        ...promptBox,
        ...(promptHint ? [promptHint] : []),
        "",
      ],
      filler: panelLine(""),
    };
    // Agent, verify, worktree, and ambiguity controls sit left-aligned
    // beside the prompt; Prompt/Start stay right-aligned. Tier moved to
    // the top fit line. The bottom footer has no command row.
    actions = " ";
    secondaryStyled = true;
    if (props.confirm) secondary = `${Y}discard unsaved prompt? y to discard and exit, esc to stay${R}`;
    else secondary = toast ? `${D}· ${Y}${toast}${R}` : "";
  }

  return {
    body,
    actions,
    secondary,
    secondaryStyled,
    bottomAlign,
    footerMapTokens,
    footerBandTone,
    footerCtx,
    contextTab,
    contextSectionKey,
    contextItemKeys,
    contextItemAvailable,
    contextItem,
    contextItemKey: shownItems.length > 0 ? shownItems[contextItem]!.key : null,
    modelPickSel,
    itemPickSel,
  };
}
