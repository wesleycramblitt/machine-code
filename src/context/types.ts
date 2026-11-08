/**
 * machine_code — context bundle types.
 *
 * Context is assembled per run from inherited (plans, parent runs),
 * explicit (packet, knowledge, skills selected in the composer), and
 * discovered (tool results) sources. The rendered text is what the model
 * sees; the manifest (context.json) records provenance so every block is
 * traceable.
 */
export type ContextKind =
  | "plan"
  /** Legacy manifests used "project" for the single plan file. */
  | "project"
  | "epic"
  | "feature"
  /** Legacy manifests used "task" for the current issue block. */
  | "task"
  | "knowledge"
  | "reference"
  | "issue"
  | "file"
  | "skill"
  | "tool"
  | "script"
  | "parent-run";

export type ContextOrigin = "inherited" | "explicit" | "discovered";

/** Budget section for per-section chars (context.json + composer preview). Keys mirror the composer exclusion sections 1:1, so accounting matches what the TUI shows; `files` counts only `kind:file`. Render-side sections (system) record 0 in assemble. */
export type ContextSection =
  | "issues"
  | "plans"
  | "knowledge"
  | "skills"
  | "scripts"
  | "tools"
  | "references"
  | "files"
  | "parents"
  | "system";

export type ContextSections = Record<ContextSection, number>;

export interface ContextSource {
  kind: ContextKind;
  origin: ContextOrigin;
  /** Stable reference: path, packet id, skill name. */
  ref: string;
  /** 0 = current task, deeper = inherited. */
  depth?: number;
  bytes: number;
  hash: string;
  truncated: boolean;
  warning?: string;
}

export interface ContextBundle {
  text: string;
  sources: ContextSource[];
  chars: number;
  /** Human-readable over-budget/truncation notes. Never silently drop curated sources. */
  warnings: string[];
  /** Kept body chars per section (system is render-side; assemble records 0). */
  sections: ContextSections;
}

/** Warning threshold when the caller has no selected model budget. Not a cap. */
export const DEFAULT_CONTEXT_BUDGET = 64_000;
