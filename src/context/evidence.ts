/**
 * machine_code — re-served tool evidence.
 *
 * The prompt keeps the transcript head plus the last two steps; everything
 * older vanishes, so models re-ask for bodies they already fetched (observed:
 * 23 byte-identical repeats in one 38-turn run, and 27 re-shows of the same
 * 5 issues in 99 turns). This module re-presents the run's distinct inspect
 * answers and issue reads every turn — most recent first, verbatim
 * envelopes, bodies re-retrieved from disk on the fly — plus a fresh
 * core:diff. Nothing is stored except the call ledger (tool + prepared
 * params + turn); staleness is unrepresentable because no bytes are kept.
 * Over budget, oldest drops first with a named accounting line.
 *
 * Re-served answers are native toolCall/toolResult message pairs carrying the
 * exact original params — the same structure as live results, which is what
 * makes the model treat them as current data rather than quoted text.
 */
import type { AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface RetainedCall {
  /** Original toolCallId, for in-window exclusion. */
  id: string;
  /** Which tool to re-execute: inspect bodies or read-only issue reads. */
  tool: "inspect" | "command";
  /** Prepared params, ready to re-execute. */
  params: Record<string, unknown>;
  /** Turn the model asked it; null when rebuilt from a resumed transcript. */
  turn: number | null;
  /** True for the run's own files, seeded at turn 0. Seeds lead the evidence
   *  order and are never evicted from the ledger. */
  seeded?: boolean;
}

/**
 * Per-turn execution guard. The *prompt* is bounded by the evidence budget
 * (a share of the model's input), not by a call count; this only stops a
 * pathological turn from re-reading hundreds of files for nothing.
 */
export const MAX_EVIDENCE_EXECUTIONS = 80;
/** Ledger memory guard: entries kept in memory for later turns. Pruning is the
 * model's job; this exists so a very long run cannot grow without bound. */
export const MAX_LEDGER_ENTRIES = 400;
/** Per-envelope share: one read may take a quarter of the section, so a long
 * file arrives whole on a big model instead of being clipped at a fixed size. */
const ENVELOPE_SHARE = 0.25;
const ENVELOPE_FLOOR = 4_096;
const DIFF_CAP_CHARS = 8_192;

function textOf(result: { content: Array<{ type?: unknown; text?: unknown }> }): string {
  return result.content
    .filter((item) => item && item.type === "text" && typeof item.text === "string")
    .map((item) => item.text as string)
    .join("\n");
}

function withProvenance(envelope: string, handle: string): string {
  // No turn numbers, no relative age: anything that lets the model judge
  // freshness by age invites the stale-data distrust pattern. Everything
  // here was re-retrieved this turn, so the tag says exactly that. The handle
  // is how the model prunes this entry.
  const tag = `[${handle} re-served; body current from disk]`;
  const lines = envelope.split("\n");
  if (lines.length > 0 && lines[0]!.startsWith("<") && envelope.includes("</")) {
    return [lines[0], tag, ...lines.slice(1)].join("\n");
  }
  return `${tag}\n${envelope}`;
}

function capEnvelope(text: string, maxChars: number): string {
  const cap = Math.max(ENVELOPE_FLOOR, Math.floor(maxChars * ENVELOPE_SHARE));
  if (text.length <= cap) return text;
  return `${text.slice(0, cap)}…[trimmed for evidence budget; re-inspect to expand]`;
}

/** Stable short handle for a retained call, so the model can name what to drop. */
export function evidenceHandle(call: Pick<RetainedCall, "tool" | "params">): string {
  return `ev${createHash("sha1").update(`${call.tool}:${JSON.stringify(call.params)}`).digest("hex").slice(0, 4)}`;
}

/** Full-file bodies and slices are specifics; outlines, symbol searches, and
 *  issue reads are broad knowledge that stays even when it is old. */
function isSpecificCall(call: RetainedCall): boolean {
  if (call.tool !== "inspect") return false;
  const params = call.params as { query?: unknown; symbol?: unknown; detail?: unknown };
  if (params.symbol !== undefined || params.detail !== undefined) return false;
  const query = typeof params.query === "string" ? params.query : "";
  return query.includes("/") || query.includes(":");
}

function callLabel(call: RetainedCall): string {
  const params = call.params as { query?: unknown; name?: unknown };
  const raw = typeof params.query === "string" ? params.query : typeof params.name === "string" ? params.name : JSON.stringify(call.params);
  return raw.length > 64 ? `${raw.slice(0, 61)}…` : raw;
}

export interface EvidenceInput {
  /** Distinct retained calls, most recent first. */
  retained: RetainedCall[];
  /** Unwrapped inspect tool for silent re-execution. */
  inspect: AgentTool | undefined;
  /** Unwrapped command tool for silent re-execution of read-only commands. */
  command?: AgentTool;
  /** Fresh worktree diff provider. */
  diff: () => Promise<string>;
  /** ToolCallIds whose results are already in the kept transcript window. */
  keptIds: Set<string>;
  /** Total chars allowed for the section body. */
  maxChars: number;
  /** Handles the model pruned; never re-served again this run. */
  dropped?: ReadonlySet<string>;
}

export interface BuiltEvidence {
  /** Framing + accounting user text; the pairs below it carry the bodies. */
  text: string | null;
  /**
   * Native toolCall/toolResult pairs, oldest first, batched by original
   * turn exactly like live multi-call turns. Synthetic ids
   * (`evidence-<turn>-<n>`); params are the exact original prepared args.
   */
  messages: AgentMessage[];
}

interface TakenCall {
  call: RetainedCall;
  text: string;
}

function toMessages(taken: TakenCall[]): AgentMessage[] {
  // Chronological replay: oldest first, batched by the turn that made
  // them — the same shape as the live turns that produced them.
  const chronological = [...taken].reverse();
  const groups = new Map<string, TakenCall[]>();
  for (const entry of chronological) {
    const key = entry.call.turn === null ? "r" : String(entry.call.turn);
    const group = groups.get(key);
    if (group) group.push(entry);
    else groups.set(key, [entry]);
  }
  const messages: AgentMessage[] = [];
  let n = 0;
  for (const [turnKey, entries] of groups) {
    const ids = entries.map(() => `evidence-${turnKey}-${n++}`);
    messages.push({
      role: "assistant",
      content: entries.map((entry, i) => ({
        type: "toolCall",
        id: ids[i],
        name: entry.call.tool,
        arguments: entry.call.params,
      })),
      stopReason: "toolUse",
      timestamp: Date.now(),
    } as unknown as AgentMessage);
    for (let i = 0; i < entries.length; i++) {
      messages.push({
        role: "toolResult",
        toolCallId: ids[i],
        toolName: entries[i]!.call.tool,
        content: [{ type: "text", text: entries[i]!.text }],
        isError: false,
        timestamp: Date.now(),
      } as unknown as AgentMessage);
    }
  }
  return messages;
}

/** Issue files live outside git history (gitignored), so no git diff ever
 * shows them — yet the agent curates them every turn. Render this run's
 * changed issue files (or their absence note) so the diff the agent sees
 * covers its actual work. Best-effort: never throws. */
export function changedIssuesText(repoRoot: string, runDir: string): string | null {
  try {
    const logFile = join(runDir, "issues-changed.json");
    if (!existsSync(logFile)) return null;
    const parsed: unknown = JSON.parse(readFileSync(logFile, "utf8"));
    if (!Array.isArray(parsed)) return null;
    const rels = [...new Set(parsed.filter((e): e is string => typeof e === "string"))];
    const blocks: string[] = [];
    for (const rel of rels) {
      const abs = join(repoRoot, rel);
      if (!existsSync(abs)) {
        blocks.push(`### ${rel}\n(no longer at this path)`);
        continue;
      }
      const body = readFileSync(abs, "utf8");
      blocks.push(`### ${rel}\n${body.length > 4096 ? `${body.slice(0, 4096)}…[trimmed]` : body}`);
    }
    if (blocks.length === 0) return null;
    return `issues changed this run (not in git):\n${blocks.join("\n\n")}`;
  } catch {
    return null;
  }
}

export async function buildEvidence(input: EvidenceInput): Promise<BuiltEvidence> {
  const taken: TakenCall[] = [];
  /** Calls that did not fit this turn: named so the model can prune or accept. */
  const withheld: Array<{ handle: string; label: string }> = [];
  let executions = 0;

  const used = (): number => taken.reduce((sum, entry) => sum + entry.text.length + 2, 0);

  // Broad knowledge first (outlines, symbol searches, reads of issues), then
  // specifics newest-first (file bodies, slices). A long survey therefore keeps
  // its whole outline set and only sheds the oldest bodies.
  const broad = input.retained.filter((call) => !isSpecificCall(call));
  const specific = input.retained.filter((call) => isSpecificCall(call));
  const ordered = [...broad, ...specific];

  for (const call of ordered) {
    if (input.keptIds.has(call.id)) continue;
    const handle = evidenceHandle(call);
    if (input.dropped?.has(handle)) continue;
    // Stop executing once the section is full: the budget is the cap, not a
    // call count. Everything past it is withheld and can be pruned or kept.
    if (used() >= input.maxChars) {
      withheld.push({ handle, label: callLabel(call) });
      continue;
    }
    if (executions >= MAX_EVIDENCE_EXECUTIONS) {
      withheld.push({ handle, label: callLabel(call) });
      continue;
    }
    const tool = call.tool === "command" ? input.command : input.inspect;
    if (!tool) continue;
    executions += 1;
    let result: { content: Array<{ type?: unknown; text?: unknown }>; isError?: boolean };
    try {
      result = (await tool.execute(
        `evidence-${executions}`,
        call.params as never,
        new AbortController().signal,
      )) as unknown as typeof result;
    } catch {
      continue;
    }
    if (!result || result.isError) continue;
    const text = textOf(result).trim();
    if (!text) continue;
    const capped = capEnvelope(withProvenance(text, handle), input.maxChars);
    if (used() + capped.length + 2 > input.maxChars && taken.length > 0) {
      withheld.push({ handle, label: callLabel(call) });
      continue;
    }
    taken.push({ call, text: capped });
  }

  const diff = (await input.diff().catch(() => "")).trim();
  let diffText: string | null = null;
  if (diff) {
    const capped = diff.length > DIFF_CAP_CHARS ? diff.slice(0, DIFF_CAP_CHARS) + "…[trimmed for evidence budget]" : diff;
    const labeled = "command core:diff (fresh this turn):\n" + capped;
    if (used() + labeled.length + 2 <= input.maxChars || taken.length === 0) diffText = labeled;
  }

  const messages = toMessages(taken);
  if (messages.length === 0 && !diffText) return { text: null, messages: [] };
  const total = input.retained.length;
  const shown = taken.length + (diffText ? 1 : 0);
  const accounting = withheld.length === 0
    ? `[${total} retained, all re-served below as tool results.]`
    : `[${total} retained, ${shown} re-served; ${withheld.length} withheld for the evidence budget.]`;
  const pruneLine = withheld.length === 0
    ? []
    : [
        "withheld (prune any you no longer need — `context {action:\"forget\", evidence:[handle,…]}`):",
        ...withheld.slice(0, 12).map((entry) => `  ${entry.handle} ${entry.label}`),
        ...(withheld.length > 12 ? [`  …${withheld.length - 12} more`] : []),
      ];
  const text = [
    "<evidence>",
    "[Earlier answers, re-served fresh this turn. Anything in the last two steps is not repeated here.]",
    ...(diffText ? [diffText] : []),
    accounting,
    ...pruneLine,
    "</evidence>",
  ].join("\n\n");
  return { text, messages };
}
