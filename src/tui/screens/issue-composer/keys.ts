/**
 * machine_code — issue composer keys.
 *
 * Prompt editing, field cycling/editing, and `:!` submit.
 * Modeled closely on the new-run composer key handler.
 */
import type { TuiState, NewIssueSettings } from "../../state.js";
import type { KeyServices } from "../keys.js";

const KIND_CYCLE = ["ideas", "features", "bugs"] as const;
const PRIORITY_CYCLE = ["low", "medium", "high"] as const;
/** Set a string field on NewIssueSettings by name. */
function setField(s: NewIssueSettings, field: string, value: string): void {
  switch (field) {
    case "acceptance": s.acceptance = value; break;
    case "tags": s.tags = value; break;
    case "depends": s.depends = value; break;
    case "keywords": s.keywords = value; break;
  }
}

/** Get a string field from NewIssueSettings by name. */
function getField(s: NewIssueSettings, field: string): string {
  switch (field) {
    case "acceptance": return s.acceptance;
    case "tags": return s.tags;
    case "depends": return s.depends;
    case "keywords": return s.keywords;
  }
  return "";
}

/** Default acceptance gates for a given kind and verification state. */
export function defaultAcceptance(kind: string, verification: string): string {
  if (kind === "ideas") return "research:verify";
  return verification === "verified" ? "script:build, script:test" : "script:build";
}

export function handleIssueComposerKeys(s: TuiState, ctx: KeyServices, data: string): boolean {
  // ── Field edit mode (editing a single comma-text field inline) ──
  if (s.newIssueFieldEdit) {
    if (data === "\x1b") {
      // Cancel: restore undo buffer
      if (s.newIssueFieldUndo !== undefined) {
        setField(s.newIssue, s.newIssueFieldEdit, s.newIssueFieldUndo);
        s.newIssueFieldUndo = undefined;
      }
      s.newIssueFieldEdit = null;
      ctx.draw();
      return true;
    }
    if (data === "\r" || data === "\n") {
      // Confirm field value
      s.newIssueFieldEdit = null;
      s.newIssueFieldUndo = undefined;
      ctx.draw();
      return true;
    }
    if (data === "\x7f" || data === "\b") {
      const cur = getField(s.newIssue, s.newIssueFieldEdit);
      setField(s.newIssue, s.newIssueFieldEdit, cur.slice(0, -1));
      ctx.draw();
      return true;
    }
    if (data.length === 1 && data >= " " && data < "\x7f") {
      const cur = getField(s.newIssue, s.newIssueFieldEdit);
      if (cur.length < 512) setField(s.newIssue, s.newIssueFieldEdit, cur + data);
      ctx.draw();
      return true;
    }
    ctx.draw();
    return true;
  }

  // ── Insert mode (prompt editing) ──
  if (s.newIssueInsert) {
    if (data === "\x1b") { s.newIssueInsert = false; ctx.draw(); return true; }
    if (data === "\r" || data === "\n") {
      s.newIssue.prompt += "\n";
    } else if (data === "\x7f" || data === "\b") {
      s.newIssue.prompt = s.newIssue.prompt.slice(0, -1);
    } else if (data.length === 1 && data >= " " && data < "\x7f") {
      s.newIssue.prompt += data;
      if (s.newIssue.prompt.length > 12_000) s.newIssue.prompt = s.newIssue.prompt.slice(0, 12_000);
    }
    ctx.draw();
    return true;
  }

  // ── Colon command ──
  if (s.newIssueColon) {
    s.newIssueColon = false;
    if (data === "!") {
      ctx.submitNewIssue();
    }
    ctx.draw();
    return true;
  }

  // ── Confirm discard ──
  if (s.newIssueConfirm) {
    if (data === "y" || data === "Y" || data === "\r" || data === "\n") {
      s.newIssueConfirm = false;
      s.screen = "list";
      ctx.draw();
      return true;
    }
    if (data === "\x1b" || data === "n" || data === "N") {
      s.newIssueConfirm = false;
      ctx.notify("discard cancelled");
    }
    ctx.draw();
    return true;
  }

  // ── Normal mode ──
  if (data === ":") { s.newIssueColon = true; ctx.draw(); return true; }
  if (data === "\x1b") {
    if (s.newIssue.prompt.trim() || s.newIssue.tags.trim() || s.newIssue.keywords.trim() || s.newIssue.depends.trim() || s.newIssue.acceptance.trim()) {
      s.newIssueConfirm = true;
      ctx.notify("discard unsaved issue? press y to discard and exit, esc to stay");
    } else {
      s.screen = "list";
    }
    ctx.draw();
    return true;
  }
  if (data === "e") { s.newIssueInsert = true; ctx.draw(); return true; }
  if (data === "k") {
    const idx = KIND_CYCLE.indexOf(s.newIssue.kind);
    s.newIssue.kind = KIND_CYCLE[(idx + 1) % KIND_CYCLE.length]!;
    s.newIssue.verification = "direct";
    s.newIssue.acceptance = defaultAcceptance(s.newIssue.kind, "direct");
    ctx.notify(`kind: ${s.newIssue.kind}`);
    ctx.draw();
    return true;
  }
  if (data === "p") {
    const idx = PRIORITY_CYCLE.indexOf(s.newIssue.priority);
    s.newIssue.priority = PRIORITY_CYCLE[(idx + 1) % PRIORITY_CYCLE.length]!;
    ctx.notify(`priority: ${s.newIssue.priority}`);
    ctx.draw();
    return true;
  }
  if (data === "a") {
    s.newIssueFieldEdit = "acceptance";
    s.newIssueFieldUndo = s.newIssue.acceptance;
    ctx.notify("edit acceptance gates (comma separated), Enter to confirm, Esc to cancel");
    ctx.draw();
    return true;
  }
  if (data === "t") {
    s.newIssueFieldEdit = "tags";
    s.newIssueFieldUndo = s.newIssue.tags;
    ctx.notify("edit tags (comma separated), Enter to confirm, Esc to cancel");
    ctx.draw();
    return true;
  }
  if (data === "d") {
    s.newIssueFieldEdit = "depends";
    s.newIssueFieldUndo = s.newIssue.depends;
    ctx.notify("edit depends (comma separated slugs), Enter to confirm, Esc to cancel");
    ctx.draw();
    return true;
  }
  if (data === "w") {
    s.newIssueFieldEdit = "keywords";
    s.newIssueFieldUndo = s.newIssue.keywords;
    ctx.notify("edit keywords (comma separated), Enter to confirm, Esc to cancel");
    ctx.draw();
    return true;
  }
  if (data === "v" && s.newIssue.kind !== "ideas") {
    const cycle = ["direct", "verified"] as const;
    const idx = cycle.indexOf(s.newIssue.verification);
    s.newIssue.verification = cycle[(idx + 1) % cycle.length]!;
    s.newIssue.acceptance = defaultAcceptance(s.newIssue.kind, s.newIssue.verification);
    ctx.notify(`verification: ${s.newIssue.verification}`);
    ctx.draw();
    return true;
  }
  if (data === "r") {
    s.newIssue.review = s.newIssue.review === "human" ? "none" : "human";
    ctx.notify(`review: ${s.newIssue.review}`);
    ctx.draw();
    return true;
  }

  ctx.draw();
  return true;
}