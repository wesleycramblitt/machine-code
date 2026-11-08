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
import type { PacketFile } from "../../../plan/packets.js";
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

export type ComposerRun = ForkedRunSettings & {
  /** Isolation worktree. Shown only for build; other agents ignore it. */
  worktree: boolean;
};

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
  packet: {
    text: string;
    sel: number;
    list: PacketFile[];
  } | null;
}

export interface ComposerProps extends Viewport {
  run: ComposerRun;
  repoRoot: string;
  home: string;
  insert: boolean;
  cursor: number;
  colon: boolean;
  contextTab: number;
  contextItem: number;
  contextFilter: string;
  contextFiltering: boolean;
  excluded: ReadonlySet<string>;
  included: ReadonlySet<string>;
  skillModes: ReadonlyMap<string, SkillMode>;
  /** Render memo: modes shown per skill this frame (mutated in place). */
  skillShown: Map<string, SkillMode>;
  preview: ComposerPreview;
  pickers: ComposerPickers;
  /** Role predicate: only some roles isolate in a worktree. */
  agentIsolates: (agent: string) => boolean;
  /** Mode-locked skills that cannot be excluded (verified-testing). */
  lockedSkills: () => string[];
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
  modelPickSel: number;
  packetPickSel: number;
}

export const NEW_RUN_CONTEXT_TABS = ["Packets", "Issues", "Knowledge", "Skills", "Scripts", "Tools", "Codebase", "References", "Agent Prompt", "Files"] as const;
