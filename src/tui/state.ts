/**
 * machine_code — TUI state.
 *
 * Every piece of mutable TUI state lives in one struct, created by
 * `createTuiState`. Render screens take what they need as props and return
 * cursor updates in their frames; key handlers mutate the struct and redraw.
 * Nothing here touches the terminal — this is pure data.
 */
import type { Layout } from "../paths.js";
import type { ProviderStatus } from "../models.js";
import type { RunSummary } from "../state/runs.js";
import type { ChangeSummary } from "../report/run.js";
import type { CatalogueDocument, CatalogueRow } from "../catalogue/types.js";
import type { AvailabilityState } from "../availability.js";
import type { MachineConfig, Policy } from "../config.js";
import type { ContextPreview } from "../context/preview.js";
import type { SkillMode } from "../context/references.js";
import type { ModelSort } from "../catalogue/query.js";
import type { RunGroup } from "./runs.js";
import type { DeleteTarget } from "./screens/delete.js";
import type { RunSection } from "./screens/run-detail/types.js";
import type { ForkedRunSettings } from "./fork.js";
import type { ModelPickerEntry } from "./format.js";

export type Page = "runs" | "models" | "spend" | "settings";
export type Screen = "list" | "run" | "newrun" | "newissue" | "answer" | "correct" | "model" | "delete" | "issue";
/** Runs list repo scope: every known repo, or the TUI cwd only. */
export type RunsRepoScope = "all" | "cwd";

export type NewRunState = ForkedRunSettings;

export const ISSUE_KIND_CYCLE = ["ideas", "features", "bugs"] as const;
export const ISSUE_PRIORITY_CYCLE = ["low", "medium", "high"] as const;
export const ISSUE_VERIFICATION_CYCLE = ["direct", "verified"] as const;

export interface NewIssueSettings {
  kind: "ideas" | "features" | "bugs";
  priority: "low" | "medium" | "high";
  /** Comma-separated acceptance gates — only for features/bugs. */
  acceptance: string;
  /** Comma-separated tags. */
  tags: string;
  /** Comma-separated depends slugs. */
  depends: string;
  /** Comma-separated keywords. */
  keywords: string;
  verification: "direct" | "verified";
  /** Prompt text (issue body). */
  prompt: string;
}

export interface RunDetail {
  layout: Layout;
  summary: RunSummary;
  events: import("../state/runs.js").RunEvent[];
  dir: string;
}

/** Composer seed when a run is started from an issue row. */
export interface NewRunSeed {
  /** Role to preselect (research for idea rows, engineer for features/bugs). */
  agent?: string;
  /** Default prompt; editable in the composer. */
  prompt?: string;
  /** Skill names forced to include for this seed. */
  skills?: string[];
  /** Issue slug. */
  item?: string;
}


export interface TuiState {
  page: Page;
  screen: Screen;
  runsRepoScope: RunsRepoScope;
  runsText: string;
  runsGroup: RunGroup;
  runsSel: number;
  runsScroll: number;
  runsAttention: boolean;
  collapsed: Set<string>;
  modelText: string;
  modelGroup: "provider" | "family" | "none";
  modelSort: ModelSort;
  modelsAll: boolean;
  
  modelsCoding: boolean;
  modelSel: number;
  modelScroll: number;
  probingModels: Set<string>;
  /** Collapsed model groups (provider/family key). Headers are cursor stops. */
  modelCollapsed: Set<string>;
  /** Cursor stops in render order: group headers plus visible model rows. */
  modelDisplay: Array<{ kind: "header"; key: string } | { kind: "row"; key: string; row: CatalogueRow }>;
  /** Index of the last row Enter opened, so the list can restore it exactly. */
  lastOpenedModelKey: string | null;
  selectedModelKey: string | null;
  /** Catalogue + provider cache: the 1MB models.json stays parsed across frames. */
  catalogueCache: { mtime: number; doc: CatalogueDocument | null } | null;
  statusesCache: { at: number; statuses: ProviderStatus[] } | null;
  spendDaysWindow: number;
  spendBy: "provider" | "model" | "day" | "agent";
  spendScroll: number;
  settingsSel: number;
  settingsScroll: number;
  selectedRunId: string | null;
  selectedIssueSlug: string | null;
  selectedIssueRepo: string | null;
  issueScroll: number;
  /** Run or issue awaiting final confirmation on the delete screen. */
  deleteTarget: DeleteTarget | undefined;
  deleteReturn: Screen;
  deletingRuns: Set<string>;
  runSection: RunSection;
  runScroll: number;
  processSel: number;
  processFollow: boolean;
  eventSel: number;
  eventScroll: number;
  /** Line offset inside a selected timeline block (expanded inputs/outputs). */
  eventBodyScroll: number;
  /** Follow the newest timeline event; j/k turns it off. */
  timelineFollow: boolean;
  /** Show routine internals in the timeline. */
  timelineVerbose: boolean;
  thinkingScroll: number;
  thinkingFollow: boolean;
  childSel: number;
  expanded: Set<string>;
  changesCache: { runId: string; at: number; data: ChangeSummary } | null;
  newrun: NewRunState;
  newRunRepo: string;
  /** Parent run id when the composer was opened with fork[f]. */
  newRunParentId: string | null;
  itemPick: "newrun" | null;
  itemPickSel: number;
  itemPickText: string;
  modelPick: "newrun" | null;
  modelPickSel: number;
  modelPickText: string;
  /** Picker sort: role fit (default) or estimated per-call price. */
  modelPickSort: "fit" | "price";
  modelPickEntries: ModelPickerEntry[];
  /** New-run prompt is modal: navigation keys are disabled while true. */
  newRunInsert: boolean;
  /** Esc is armed to leave with an unsaved prompt; modal confirm before `screen = "list"`. */
  newRunConfirm: boolean;
  /** Cursor column (code units) inside the new-run prompt for insert mode. */
  newRunCursor: number;
  /** `:` starts the two-key `:!` start command. */
  newRunColon: boolean;
  newRunContextTab: number;
  newRunContextItem: number;
  /** Key of the row the cursor is anchored to; the render resolves it to an index each frame so toggles cannot move the cursor to a different row. */
  newRunContextItemKey: string | null;
  newRunContextItemKeys: string[];
  newRunContextItemAvailable: boolean[];
  newRunContextSectionKey: string;
  /** `/` filters the active context tab's rows by substring. */
  newRunContextFilter: string;
  newRunContextFiltering: boolean;
  newRunContextExcluded: Set<string>;
  newRunContextIncluded: Set<string>;
  /** File-hint suggestions on/off for this run (default on). */
  newRunHints: boolean;
  /** Explicit per-skill mode choices (include | on-demand | exclude). */
  newRunSkillModes: Map<string, SkillMode>;
  /** Modes as rendered this frame (single source for space-cycling). */
  newRunSkillShown: Map<string, SkillMode>;
  /** Skills the selected agent requires at minimum "on-demand" (cannot be excluded). */
  newRunRequiredSkills: string[];
  /**
   * Static inputs to the new-run preview (policy, catalogue, provider status,
   * context files) are expensive to reload on every keystroke, so they are
   * cached and only the prompt length is applied per frame.
   */
  newRunPreviewCache: {
    key: string;
    at: number;
    context: ContextPreview;
    policy?: Policy;
    machine?: MachineConfig;
    catalogue: CatalogueDocument | null;
    configured: Set<string>;
    availability: AvailabilityState;
  } | null;
  /** New-issue composer settings. */
  newIssue: NewIssueSettings;
  /** Repo root for the new issue. */
  newIssueRepo: string;
  /** Prompt insert mode. */
  newIssueInsert: boolean;
  /** Esc confirm before leaving unsaved prompt. */
  newIssueConfirm: boolean;
  /** Cursor column in prompt (reserved for future use). */
  newIssueCursor: number;
  /** `:` starts the `:!` create command. */
  newIssueColon: boolean;
  /** Name of the field being edited inline (null = not editing). */
  newIssueFieldEdit: string | null;
  /** Original value of the field being edited, for cancel. */
  newIssueFieldUndo: string | undefined;
  answerText: string;
  answerQuestionId: string;
  answerOptions: string[];
  answerScroll: number;
  answerPage: number;
  answerOverflow: boolean;
  correctText: string;
  searchMode: boolean;
  searchText: string;
  toast: string;
  toastAt: number;
  pendingRunAt: number;
  /** Fast repaints while waiting for a fresh run record. */
  pendingFastTimer: ReturnType<typeof setInterval> | null;
}

export function createTuiState(repoRoot: string): TuiState {
  return {
    page: "runs",
    screen: "list",
    runsRepoScope: "cwd",
    runsText: "",
    runsGroup: "all",
    runsSel: 0,
    runsScroll: 0,
    runsAttention: false,
    collapsed: new Set<string>(),
    modelText: "",
    modelGroup: "provider",
    modelSort: "capability",
    modelsAll: false,
    
    modelsCoding: true,
    modelSel: 0,
    modelScroll: 0,
    probingModels: new Set<string>(),
    modelCollapsed: new Set<string>(),
    modelDisplay: [],
    lastOpenedModelKey: null,
    selectedModelKey: null,
    catalogueCache: null,
    statusesCache: null,
    spendDaysWindow: 30,
    spendBy: "provider",
    spendScroll: 0,
    settingsSel: 0,
    settingsScroll: 0,
    selectedRunId: null,
    selectedIssueSlug: null,
    selectedIssueRepo: null,
    issueScroll: 0,
    deleteTarget: undefined,
    deleteReturn: "list",
    deletingRuns: new Set<string>(),
    runSection: "overview",
    runScroll: 0,
    processSel: 0,
    processFollow: false,
    eventSel: 0,
    eventScroll: 0,
    eventBodyScroll: 0,
    timelineFollow: true,
    timelineVerbose: false,
    thinkingScroll: 0,
    thinkingFollow: true,
    childSel: 0,
    expanded: new Set<string>(),
    changesCache: null,
    newrun: {
      agent: "research",
      approval: "human",
      ambiguity: "precise",
      tier: "paid",
      minFit: undefined,
      floors: "role",
      prompt: "",
    },
    newRunRepo: repoRoot,
    newRunParentId: null,
    itemPick: null,
    itemPickSel: 0,
    itemPickText: "",
    modelPick: null,
    modelPickSel: 0,
    modelPickText: "",
    modelPickSort: "fit",
    modelPickEntries: [],
    newRunInsert: false,
    newRunConfirm: false,
    newRunCursor: 0,
    newRunColon: false,
    newRunContextTab: 0,
    newRunContextItem: 0,
    newRunContextItemKey: null,
    newRunContextItemKeys: [],
    newRunContextItemAvailable: [],
    newRunContextSectionKey: "",
    newRunContextFilter: "",
    newRunContextFiltering: false,
    newRunContextExcluded: new Set<string>(),
    newRunContextIncluded: new Set<string>(),
    newRunHints: true,
    newRunSkillModes: new Map<string, SkillMode>(),
    newRunSkillShown: new Map<string, SkillMode>(),
    newRunRequiredSkills: [],
    newRunPreviewCache: null,
    newIssue: {
      kind: "features",
      priority: "medium",
      acceptance: "",
      tags: "",
      depends: "",
      keywords: "",
      verification: "direct",
      prompt: "",
    },
    newIssueRepo: repoRoot,
    newIssueInsert: false,
    newIssueConfirm: false,
    newIssueCursor: 0,
    newIssueColon: false,
    newIssueFieldEdit: null,
    newIssueFieldUndo: undefined,
    answerText: "",
    answerQuestionId: "",
    answerOptions: [],
    answerScroll: 0,
    answerPage: 10,
    answerOverflow: false,
    correctText: "",
    searchMode: false,
    searchText: "",
    toast: "",
    toastAt: 0,
    pendingRunAt: 0,
    pendingFastTimer: null,
  };
}
