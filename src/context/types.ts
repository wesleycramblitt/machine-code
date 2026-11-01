/**
 * machine_code — context bundle types.
 *
 * Context is assembled per run from inherited (issue hierarchy, project),
 * explicit (packet, knowledge, skills referenced by the issue), and discovered
 * (tool results) sources. The rendered text is what the model sees; the
 * manifest (context.json) records provenance so every block is traceable.
 */
export type ContextKind =
  | "project"
  | "epic"
  | "feature"
  | "task"
  | "packet"
  | "knowledge"
  | "file"
  | "skill"
  | "tool"
  | "script"
  | "parent-run";

export type ContextOrigin = "inherited" | "explicit" | "discovered";

export interface ContextSource {
  kind: ContextKind;
  origin: ContextOrigin;
  /** Stable reference: issue ref, path, packet id, skill name. */
  ref: string;
  /** 0 = current task, 1 = parent feature, 2 = epic. */
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
}

export const DEFAULT_CONTEXT_BUDGET = 24_000;
