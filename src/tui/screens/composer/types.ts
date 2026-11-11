/**
 * machine_code — new-run composer contract.
 *
 * Props in, frame out. The TUI root owns composer state (run settings,
 * picker cursors, context-tab filters, the model preview cache) and passes
 * snapshots down; the screen returns rendered content plus updated cursor
 * state. Render-owned derivations (skill modes shown, context item keys)
 * flow back through the frame or the passed-in memo map.
 */
import type { CatalogueRow } from "../../../catalogue/types.js";

import type { MachineConfig, Policy } from "../../../config.js";
import type { ContextPreview } from "../../../context/preview.js";
import type { SkillMode } from "../../../context/references.js";
import type { Issue } from "../../../plan/issues.js";
import type { ModelPickerEntry } from "../../format.js";
import type { ForkedRunSettings } from "../../fork.js";
import type { Viewport } from "../types.js";

export interface ContextPanelItem {
  text: string;
  chars: number;
  exists: boolean;
  key: string;
  fixed?: boolean;
  available?: boolean;
  counted?: boolean;
}

export type ComposerRun = ForkedRunSettings;

/** Structural preview from the composer's model/context computation. */
export interface ComposerPreview {
  context: ContextPreview;
  model?: CatalogueRow;
  fit?: number;
  estimate?: { inputTokens: number; outputTokens: number };
  error?: string;
  policy?: Policy;
  machine?: MachineConfig;
}

export interface ComposerPickers {
  model: {
    entries: ModelPickerEntry[];
    sel: number;
    text: string;
    sort: "fit" | "price";
  } | null;
  issue: {
    text: string;
    sel: number;
    list: Issue[];
  } | null;
}

export interface ComposerProps extends Viewport {
  run: ComposerRun;
  repoRoot: string;
  home: string;
  insert: boolean;
  cursor: number;
  colon: boolean;
  /** Esc-confirm armed: ask to discard the unsaved prompt before leaving. */
  confirm: boolean;
  contextTab: number;
  contextItem: number;
  /** Key of the row the cursor is anchored to; the render resolves it to an index each frame so toggles cannot move the cursor to a different row. */
  contextItemKey: string | null;
  contextFilter: string;
  contextFiltering: boolean;
  excluded: ReadonlySet<string>;
  included: ReadonlySet<string>;
  /** File-hint suggestions on/off; when off, no row is marked suggested. */
  hintsEnabled: boolean;
  skillModes: ReadonlyMap<string, SkillMode>;
  /** Render memo: modes shown per skill this frame (mutated in place). */
  skillShown: Map<string, SkillMode>;
  preview: ComposerPreview;
  pickers: ComposerPickers;
  /** Role predicate: only some roles isolate in a worktree. */
  agentIsolates: (agent: string) => boolean;
  mapTokens: (root: string) => string[];
}

export interface ComposerFrame {
  body: string[];
  actions: string;
  secondary: string;
  secondaryStyled: boolean;
  bottomAlign: { above: string[]; block: string[]; filler?: string } | null;
  footerMapTokens: string[];
  footerBandTone: string;
  footerCtx: string;
  /** Updated context-tab cursor state owned by the render. */
  contextSectionKey: string;
  contextTab: number;
  contextItemKeys: string[];
  contextItemAvailable: boolean[];
  contextItem: number;
  /** Key of the row the cursor resolved to this frame (null when the list is empty). */
  contextItemKey: string | null;
  modelPickSel: number;
  itemPickSel: number;
}

export const NEW_RUN_CONTEXT_TABS = ["Issues", "Skills", "Scripts", "Tools", "Codebase", "References", "Agent Prompt", "Files"] as const;