/**
 * machine_code — new-issue composer contract.
 *
 * Props in, frame out. Simpler than the new-run composer: no context
 * tabs, no model picker, no preview. Just the prompt box + settings
 * panel + actions footer.
 */
import type { Viewport } from "../types.js";

export interface IssueComposerProps extends Viewport {
  settings: {
    kind: "ideas" | "features" | "bugs";
    priority: "low" | "medium" | "high";
    acceptance: string;
    tags: string;
    depends: string;
    keywords: string;
    verification: "direct" | "verified";
    prompt: string;
  };
  repoRoot: string;
  insert: boolean;
  cursor: number;
  colon: boolean;
  confirm: boolean;
  /** Name of the field being edited inline, if any. */
  fieldEdit: string | null;
}

export interface IssueComposerFrame {
  body: string[];
  actions: string;
  secondary: string;
}