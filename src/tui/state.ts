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
import type { RunSection } from "./screens/run-detail/types.js";
import type { ForkedRunSettings } from "./fork.js";
import type { ModelPickerEntry } from "./format.js";

export type Page = "runs" | "models" | "spend" | "settings";
export type Screen = "list" | "run" | "newrun" | "answer" | "correct" | "model" | "delete" | "issue";
/** Runs list repo scope: every known repo, or the TUI cwd only. */
export type RunsRepoScope = "all" | "cwd";

export type NewRunState = ForkedRunSettings;

export interface RunDetail {
  layout: Layout;
  summary: RunSummary;
  events: import("../state/runs.js").RunEvent[];
  dir: string;
}

/** Composer seed when a run is started from a plan file or plan line. */
export interface NewRunSeed {
  /** Role to preselect (research for idea rows, engineer for features/bugs). */
  agent?: string;
  /** Repo-relative plan attached as explicit context. */
  plan?: string;
  /** Default prompt; editable in the composer. */
  prompt?: string;
  /** Skill names forced to include for this seed. */
  skills?: string[];
  /** Plan item slug (research/planning runs without a contract). */
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
  modelsFree: boolean;
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
  deleteRunTarget: RunSummary | undefined;
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
  /** Follow the newest timeline event; j/k or ^D/^U turns it off. */
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
  /** Cursor column (code units) inside the new-run prompt for insert mode. */
  newRunCursor: number;
  /** `:` starts the two-key `:!` start command. */
  newRunColon: boolean;
  newRunContextTab: number;
  newRunContextItem: number;
  newRunContextItemKeys: string[];
  newRunContextItemAvailable: boolean[];
  newRunContextSectionKey: string;
  /** `/` filters the active context tab's rows by substring. */
  newRunContextFilter: string;
  newRunContextFiltering: boolean;
  newRunContextExcluded: Set<string>;
  newRunContextIncluded: Set<string>;
  /** Explicit per-skill mode choices (include | on-demand | exclude). */
  newRunSkillModes: Map<string, SkillMode>;
  /** Modes as rendered this frame (single source for space-cycling). */
  newRunSkillShown: Map<string, SkillMode>;
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
    modelsFree: false,
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
    deleteRunTarget: undefined,
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
      tier: "free",
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
    newRunCursor: 0,
    newRunColon: false,
    newRunContextTab: 0,
    newRunContextItem: 0,
    newRunContextItemKeys: [],
    newRunContextItemAvailable: [],
    newRunContextSectionKey: "",
    newRunContextFilter: "",
    newRunContextFiltering: false,
    newRunContextExcluded: new Set<string>(),
    newRunContextIncluded: new Set<string>(),
    newRunSkillModes: new Map<string, SkillMode>(),
    newRunSkillShown: new Map<string, SkillMode>(),
    newRunPreviewCache: null,
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
