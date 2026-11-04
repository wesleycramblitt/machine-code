/**
 * machine_code — required issue-body context.
 *
 * The Planner writes context when it creates an issue. The harness checks the
 * shape before the issue exists so a later review is not needed to repair it.
 * Context is prose plus the kind-specific sections that make a child task
 * buildable: Goal/Scope for parents and Deliverable/Acceptance for Tasks.
 */
import { parseAcceptance, type IssueKind } from "./provider.js";
import { inferPreloadFiles } from "../context/preload.js";

export const MIN_CONTEXT_CHARS = 20;

interface Section {
  heading: string;
  text: string;
}

/** Markdown sections, with the body before the first heading ignored. */
export function bodySections(body: string): Section[] {
  const out: Section[] = [];
  let current: Section | undefined;
  for (const line of body.split("\n")) {
    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    if (heading) {
      if (current) out.push(current);
      current = { heading: (heading[1] ?? "").trim(), text: "" };
      continue;
    }
    if (current) current.text += `${line}\n`;
  }
  if (current) out.push(current);
  return out;
}

function sectionText(sections: readonly Section[], pattern: RegExp): string | undefined {
  const found = sections.find((section) => pattern.test(section.heading));
  if (!found) return undefined;
  return found.text.replace(/<!--[\s\S]*?-->/g, "").trim();
}

function missing(section: string): string {
  return `missing ## ${section}`;
}

export interface IssueContextInput {
  kind: IssueKind;
  body: string;
}

/**
 * Reject an issue body that does not carry the context its children or Build
 * need. The checks are structural: they do not call a model.
 */
export function issueContextErrors(input: IssueContextInput): string[] {
  const sections = bodySections(input.body);
  const errors: string[] = [];
  const context = sectionText(sections, /^context$/i);
  if (!context || context.length < MIN_CONTEXT_CHARS) {
    errors.push(
      `missing ## Context (at least ${MIN_CONTEXT_CHARS} chars): why this exists, parent scope, relevant files/symbols, and constraints`,
    );
  }
  if (input.kind === "epic" || input.kind === "feature") {
    if (!sectionText(sections, /^goal$/i)) errors.push(missing("Goal"));
    if (!sectionText(sections, /^scope$/i)) errors.push(missing("Scope"));
  }
  if (input.kind === "feature") {
    if (!sectionText(sections, /^success(?:\s+(?:measures|criteria))?$/i)) {
      errors.push(missing("Success measures"));
    }
  }
  if (input.kind === "task") {
    if (!sectionText(sections, /^deliverable$/i)) errors.push(missing("Deliverable"));
    if (parseAcceptance(input.body).length === 0) errors.push("missing acceptance criteria");
  }
  return errors;
}

/**
 * Attach an `mc:context` file list inferred from the issue body. The Planner
 * should not have to write JSON by hand when the body already names the files
 * or the semantic map can identify them. Existing markers are left alone.
 */
export function withInferredContext(body: string, repoRoot: string): string {
  if (/<!--\s*mc:context\b/.test(body)) return body;
  const files = inferPreloadFiles(repoRoot, body, 6);
  if (files.length === 0) return body;
  const marker = `<!-- mc:context\n${JSON.stringify({ files }, null, 2)}\n-->`;
  return `${body.replace(/\s+$/, "")}\n\n${marker}\n`;
}
