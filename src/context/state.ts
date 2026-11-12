/**
 * machine_code — run state: facts, working set, changes, and a durable ledger.
 *
 * state.jsonl is the authoritative record. The live prompt is rendered from
 * this state plus the current step; the raw transcript is never replayed.
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import { getArtifact, putArtifact, type Artifact } from "./artifacts.js";
import type { ProcessSupervisor } from "../processes/supervisor.js";

/** Keep the model-facing state block compact; full facts remain in state.jsonl. */
const MAX_STATE_CHARS = 10_000;

export type FactKind = "finding" | "decision" | "change";
export type RefKind = "read" | "search" | "edit" | "focus";

export interface Ref {
  path: string;
  range?: [number, number];
  symbol?: string;
  hash?: string;
  artifact?: string;
  bytes?: number;
}

export interface Fact {
  id: string;
  kind: FactKind;
  text: string;
  refs: Ref[];
  turn: number;
  status: "active" | "stale";
  key: string;
}

export interface OpenQuestion {
  id: string;
  text: string;
  turn: number;
  status: "open" | "answered";
}

export interface RunState {
  version: 1;
  runId: string;
  goal: string;
  phase: "orient" | "target" | "act" | "verify" | "done";
  facts: Fact[];
  workingSet: Ref[];
  open: OpenQuestion[];
  counters: { turn: number; steps: number; artifacts: number };
}

/** A file the model has read or changed in this run, for prompt working context. */
interface WorkingFileState {
  path: string;
  ranges: Array<[number, number]>;
  full: boolean;
  lastTurn: number;
  changed: boolean;
  preloaded: boolean;
}

/** Exact bytes acquired by a read, keyed by path plus symbol/section/range. */
export interface LedgerEntry {
  key: string;
  path: string;
  label: string;
  kind: "file" | "symbol" | "section" | "outline";
  content: string;
  hash: string;
  chars: number;
  turn: number;
  fileSig?: string;
}

type Entry =
  | { type: "init"; runId: string; goal: string }
  | { type: "fact"; fact: Fact }
  | { type: "stale"; id: string }
  | { type: "resolve"; id: string }
  | { type: "next"; text: string; turn?: number }
  | { type: "focus"; refs: Ref[] }
  | { type: "phase"; phase: RunState["phase"] }
  | { type: "open"; question: OpenQuestion }
  | { type: "turn"; turn: number };

interface EventSink {
  dir: string;
  id: string;
  event(type: string, data?: Record<string, unknown>): void;
}

export interface StateStoreOptions {
  runDir: string;
  runId: string;
  goal: string;
  /** Repository/worktree root for map dirty markers. */
  repoRoot?: string;
  recorder?: EventSink;
  /** Optional run supervisor for the synchronous git-status safety net. */
  processes?: ProcessSupervisor;
}

function sha1(text: string): string {
  return createHash("sha1").update(text).digest("hex");
}

function textOf(message: Record<string, unknown>): string {
  const content = message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const b = block as Record<string, unknown>;
    if (b.type === "text" && typeof b.text === "string") parts.push(b.text);
  }
  return parts.join("\n");
}

function toolCalls(message: Record<string, unknown>): Map<string, { name: string; args: Record<string, unknown> }> {
  const out = new Map<string, { name: string; args: Record<string, unknown> }>();
  if (!Array.isArray(message.content)) return out;
  for (const block of message.content) {
    if (!block || typeof block !== "object") continue;
    const b = block as Record<string, unknown>;
    if (b.type !== "toolCall" || typeof b.id !== "string") continue;
    out.set(b.id, {
      name: typeof b.name === "string" ? b.name : "tool",
      args: (b.arguments ?? {}) as Record<string, unknown>,
    });
  }
  return out;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function inline(text: string, max = 180): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length <= max ? clean : `${clean.slice(0, Math.max(0, max - 1))}…`;
}

/** First few useful lines of a read/search result, for the state block. */
function excerpt(text: string, max = 180): string {
  const lines = text
    .split("\n")
    .map((line) => line.replace(/^\s*\d+:\s?/, "").trim())
    .filter(Boolean);
  if (lines.length > 0 && (/^\[?[^:\]]+:\d+-\d+/.test(lines[0]!) || /^\[.*\]$/.test(lines[0]!))) lines.shift();
  return inline(lines.slice(0, 3).join(" "), max);
}

function lineCount(text: string): number {
  return text.length === 0 ? 0 : text.split("\n").length;
}

/** The line range an edit wrote, when the replacement is unique in the file. */
function editRange(repoRoot: string | undefined, path: string, newText: string): [number, number] | undefined {
  if (!repoRoot || newText.length === 0) return undefined;
  try {
    const abs = isAbsolute(path) ? path : join(repoRoot, path);
    const after = readFileSync(abs, "utf8");
    const first = after.indexOf(newText);
    if (first < 0) return undefined;
    if (after.indexOf(newText, first + 1) >= 0) return undefined;
    const start = after.slice(0, first).split("\n").length;
    const end = start + Math.max(0, newText.split("\n").length - 1);
    return [start, end];
  } catch {
    return undefined;
  }
}

function num(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : fallback;
}

function parseRef(value: string): Ref {
  const match = /^(.*?):(\d+)(?:-(\d+))?$/.exec(value);
  if (!match) return { path: value };
  const start = Number(match[2]);
  const end = match[3] ? Number(match[3]) : start;
  return { path: match[1]!, range: [start, Math.max(start, end)] };
}

function refLabel(ref: Ref): string {
  const range = ref.range ? `:${ref.range[0]}-${ref.range[1]}` : "";
  const symbol = ref.symbol ? ` (${ref.symbol})` : "";
  const artifact = ref.artifact ? ` · ${ref.artifact}` : "";
  return `${ref.path}${range}${symbol}${artifact}`;
}

function rangesOverlap(a: readonly [number, number], b: readonly [number, number]): boolean {
  return a[0] <= b[1] && b[0] <= a[1];
}

/** Merge overlapping or adjacent line ranges for the compact read coverage. */
function mergeRanges(ranges: ReadonlyArray<readonly [number, number]>): Array<[number, number]> {
  const sorted = [...ranges].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const out: Array<[number, number]> = [];
  for (const [start, end] of sorted) {
    const last = out[out.length - 1];
    if (last && start <= last[1] + 1) {
      last[1] = Math.max(last[1], end);
    } else {
      out.push([start, end]);
    }
  }
  return out;
}

/** Number selected line ranges, preserving gaps when the file is large. */
function renderNumberedLines(
  lines: readonly string[],
  ranges: ReadonlyArray<readonly [number, number]>,
  cap: number,
): string {
  const total = lines.length;
  const out: string[] = [];
  let used = 0;
  let last = 0;
  for (const [rawStart, rawEnd] of ranges) {
    const start = Math.max(1, Math.min(total, rawStart));
    const end = Math.max(start, Math.min(total, rawEnd));
    if (last > 0 && start > last + 1) {
      out.push(`... [lines ${last + 1}-${start - 1} omitted]`);
    }
    for (let index = start; index <= end; index += 1) {
      const line = `${index}: ${lines[index - 1] ?? ""}`;
      if (used + line.length + 1 > cap) {
        out.push("... [working context truncated; use read or context recall for the rest]");
        return out.join("\n");
      }
      out.push(line);
      used += line.length + 1;
    }
    last = end;
  }
  if (last > 0 && last < total) {
    out.push(`... [${total - last} more lines; use read or context recall]`);
  }
  return out.join("\n");
}

function writeTextAtomic(file: string, text: string): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(tmp, text, "utf8");
    renameSync(tmp, file);
  } catch (error) {
    try { rmSync(tmp, { force: true }); } catch { /* best effort */ }
    throw error;
  }
}

export class RunStateStore {
  readonly runDir: string;
  readonly runId: string;
  private readonly repoRoot?: string;
  private readonly recorder?: EventSink;
  private readonly processes?: ProcessSupervisor;
  private state: RunState;
  private sequence = 0;
  /** Files that are in play; rendered as current content, not transcript. */
  private workingFiles = new Map<string, WorkingFileState>();
  /**
   * Precise changed spans per file (new-file coordinates), recorded by the
   * edit tool. entry.ranges mixes in read windows, which is fine for legacy
   * rendering but too coarse for "show what changed": spans render instead.
   */
  private editSpans = new Map<string, Array<[number, number]>>();
  /**
   * Record a changed line span (1-based, inclusive, new-file coordinates).
   * Marks the working file changed and tracks the precise span separately
   * from read windows, so the render shows what changed — not everywhere
   * the model looked while finding it.
   */
  noteEditSpan(path: string, start: number, end: number): void {
    if (!path || start < 1) return;
    this.noteWorkingFile(path, [start, Math.max(start, end)], this.currentTurn(), true);
    const spans = this.editSpans.get(path) ?? [];
    spans.push([start, Math.max(start, end)]);
    this.editSpans.set(path, mergeRanges(spans).slice(-8));
  }
  /**
   * Files inlined whole and numbered in the assembled `## Context` block are
   * still served from disk on re-read — a re-read means the context did not
   * prevent it, and withholding bytes never fixes that. No denial gates.
   */
  /** Exact acquired bytes for the full run; a read cache and prompt evidence. */
  private ledger = new Map<string, LedgerEntry>();

  constructor(options: StateStoreOptions) {
    this.runDir = options.runDir;
    this.runId = options.runId;
    this.repoRoot = options.repoRoot;
    this.recorder = options.recorder;
    this.processes = options.processes;
    this.state = {
      version: 1,
      runId: options.runId,
      goal: options.goal,
      phase: "orient",
      facts: [],
      workingSet: [],
      open: [],
      counters: { turn: 0, steps: 0, artifacts: 0 },
    };
    this.load();
  }

  get path(): string {
    return join(this.runDir, "state.jsonl");
  }

  get markdownPath(): string {
    return join(this.runDir, "state.md");
  }

  load(): void {
    const file = this.path;
    if (!existsSync(file)) {
      this.append({ type: "init", runId: this.runId, goal: this.state.goal });
      this.saveMarkdown();
      return;
    }
    for (const line of readFileSync(file, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line) as Entry;
        this.apply(entry);
      } catch {
        // A malformed ledger line must not break the run.
      }
    }
    for (const fact of this.state.facts) {
      const match = /^f_(\d+)$/.exec(fact.id);
      if (match) this.sequence = Math.max(this.sequence, Number(match[1]) + 1);
    }
    this.saveMarkdown();
  }

  getState(): Readonly<RunState> {
    return this.state;
  }

  currentTurn(): number {
    return this.state.counters.turn + 1;
  }

  private id(): string {
    return `f_${this.sequence++}`;
  }

  private append(entry: Entry): void {
    mkdirSync(this.runDir, { recursive: true });
    appendFileSync(this.path, `${JSON.stringify(entry)}\n`, "utf8");
    this.apply(entry);
  }

  private apply(entry: Entry): void {
    switch (entry.type) {
      case "init":
        this.state.runId = entry.runId;
        this.state.goal = entry.goal;
        break;
      case "fact": {
        const fact = entry.fact;
        if (fact.kind === "change") {
          const changed = fact.refs[0];
          const changedPath = changed?.path;
          const changedRange = changed?.range;
          if (changedPath) this.dropLedgerPath(changedPath);
          const overlaps = (ref: Ref): boolean =>
            Boolean(changedPath) &&
            ref.path === changedPath &&
            (!changedRange || !ref.range || rangesOverlap(ref.range, changedRange));
          for (const existing of this.state.facts) {
            if (existing.status !== "active") continue;
            if (existing.key === fact.key) existing.status = "stale";
            if (existing.refs.some(overlaps)) {
              const newHash = changed?.hash;
              if (!newHash || existing.refs.some((ref) => overlaps(ref) && ref.hash !== newHash)) {
                existing.status = "stale";
              }
            }
          }
        }
        const same = this.state.facts.find((existing) => existing.status === "active" && existing.key === fact.key);
        if (same) {
          same.text = fact.text;
          same.refs = fact.refs;
          same.turn = fact.turn;
        } else {
          this.state.facts.push({ ...fact, status: "active" });
        }
        if (fact.kind === "finding" && fact.key.startsWith("read:") && fact.refs[0]) {
          const ref = fact.refs[0];
          this.noteWorkingFile(ref.path, ref.range, fact.turn, false, false, !ref.range && !ref.symbol);
        } else if (fact.kind === "change" && fact.refs[0]) {
          const ref = fact.refs[0];
          this.noteWorkingFile(ref.path, ref.range, fact.turn, true, false, !ref.range);
        }
        break;
      }
      case "stale": {
        const fact = this.state.facts.find((item) => item.id === entry.id);
        if (fact) fact.status = "stale";
        break;
      }
      case "resolve": {
        const fact = this.state.facts.find((item) => item.id === entry.id);
        if (fact) fact.status = "stale";
        const open = this.state.open.find((item) => item.id === entry.id);
        if (open) open.status = "answered";
        break;
      }
      case "focus":
        this.state.workingSet = entry.refs.slice();
        break;
      case "phase":
        this.state.phase = entry.phase;
        break;
      case "open":
        this.state.open.push({ ...entry.question });
        break;
      case "turn":
        this.state.counters.turn = Math.max(this.state.counters.turn, entry.turn);
        this.state.counters.steps += 1;
        break;
    }
  }

  note(kind: "finding" | "decision" | "open", text: string, refs: string[] = [], turn?: number): void {
    const clean = text.replace(/\s+/g, " ").trim();
    if (!clean) return;
    const at = turn ?? this.currentTurn();
    if (kind === "open") {
      this.append({
        type: "open",
        question: { id: `q_${sha1(clean).slice(0, 10)}`, text: clean.slice(0, 240), turn: at, status: "open" },
      });
      this.saveMarkdown();
      return;
    }
    const refsParsed = refs.map(parseRef);
    const key = `${kind}:${sha1(`${clean}\0${refsParsed.map((ref) => ref.path).join("\0")}`)}`;
    // Plans are decisions and need room for numbered steps. Findings stay small.
    const cap = kind === "decision" ? 2_000 : 240;
    this.append({
      type: "fact",
      fact: {
        id: this.id(),
        kind,
        text: clean.slice(0, cap),
        refs: refsParsed,
        turn: at,
        status: "active",
        key,
      },
    });
    this.recorder?.event("state_note", { turn: at, kind, bytes: clean.length });
    this.saveMarkdown();
  }

  focus(refs: string[], turn?: number): void {
    const parsed = refs.map(parseRef);
    this.append({ type: "focus", refs: parsed });
    this.recorder?.event("state_focus", { turn: turn ?? this.currentTurn(), refs: parsed.length });
    this.saveMarkdown();
  }

  forget(id: string): boolean {
    const fact = this.state.facts.find((item) => item.id === id);
    const open = this.state.open.find((item) => item.id === id);
    if (!fact && !open) return false;
    this.append({ type: "resolve", id });
    this.saveMarkdown();
    return true;
  }

  setPhase(phase: RunState["phase"]): void {
    this.append({ type: "phase", phase });
  }

  putArtifact(text: string): Artifact {
    const artifact = putArtifact(this.runDir, text);
    this.state.counters.artifacts += 1;
    return artifact;
  }

  getArtifact(id: string): string | null {
    return getArtifact(this.runDir, id);
  }

  private noteWorkingFile(
    path: string,
    range: [number, number] | undefined,
    turn: number,
    changed = false,
    preloaded = false,
    full = false,
  ): void {
    if (!path) return;
    const entry = this.workingFiles.get(path) ?? {
      path,
      ranges: [],
      full: false,
      lastTurn: turn,
      changed: false,
      preloaded: false,
    };
    if (full) {
      entry.full = true;
      entry.ranges = [];
    } else if (range) {
      entry.ranges = mergeRanges([...entry.ranges, range]);
    }
    entry.lastTurn = Math.max(entry.lastTurn, turn);
    if (changed) entry.changed = true;
    if (preloaded) entry.preloaded = true;
    this.workingFiles.set(path, entry);
  }

  /** Put task-relevant files in the working set before the first model call. */
  seedWorkingFiles(paths: readonly string[], turn = 0, maxBytes = 65536): void {
    if (!this.repoRoot) return;
    for (const path of paths) {
      try {
        const abs = isAbsolute(path) ? path : join(this.repoRoot, path);
        const content = readFileSync(abs, "utf8");
        if (Buffer.byteLength(content, "utf8") > maxBytes) continue;
        const artifact = this.putArtifact(content);
        const total = content.length === 0 ? 1 : content.split("\n").length;
        const ref: Ref = {
          path,
          range: [1, total],
          hash: artifact.hash.slice(0, 16),
          artifact: artifact.id,
          bytes: artifact.bytes,
        };
        this.addReadFact(ref, turn);
        this.noteWorkingFile(path, undefined, turn, false, true, true);
      } catch {
        // A missing or unreadable preload is not a run failure.
      }
    }
  }

  /**
   * True when the path is pinned in the working set (seeded or read). The
   * renderer re-reads pins from disk every turn, so a pin is current by
   * construction; a bare read would only re-dump bytes the model holds.
   */
  isWorkingFile(path: string): boolean {
    return this.workingFiles.has(path);
  }

  /**
   * Current file content for the model. This is the task working set, not a
   * transcript replay: changed files are re-read from disk, and unrelated
   * history stays in artifacts.
   */
  renderWorkingContext(options: { maxChars?: number; perFileChars?: number; maxFiles?: number } = {}): string {
    if (!this.repoRoot || this.workingFiles.size === 0) return "";
    const maxChars = options.maxChars ?? 8_000;
    const perFileChars = options.perFileChars ?? 6_000;
    const maxFiles = options.maxFiles ?? 6;
    const decisionText = this.state.facts
      .filter((fact) => fact.kind === "decision" && fact.status === "active")
      .map((fact) => fact.text)
      .join("\n");
    const focus = new Set(this.state.workingSet.map((ref) => ref.path));
    const score = (entry: WorkingFileState): number =>
      (entry.changed ? 1_000 : 0) +
      (entry.preloaded ? 300 : 0) +
      (focus.has(entry.path) ? 200 : 0) +
      (decisionText.includes(entry.path) || decisionText.includes(basename(entry.path)) ? 500 : 0) +
      Math.min(200, entry.lastTurn);
    // Only files the model is acting on: edited (their current bytes differ
    // from the transcript), explicitly focused, or fully read outside the
    // seeds. Seeded task files are already in the assembled context block
    // in full, so rendering them here too re-sends the same bytes every
    // turn; the preloaded flag stays for scoring, not rendering.
    const entries = [...this.workingFiles.values()]
      .filter((entry) => entry.changed || focus.has(entry.path) || (entry.full && !entry.preloaded))
      .sort((a, b) => score(b) - score(a) || b.lastTurn - a.lastTurn || a.path.localeCompare(b.path))
      .slice(0, maxFiles);

    const blocks: string[] = [];
    let used = 0;
    for (const entry of entries) {
      let raw: string;
      try {
        const abs = isAbsolute(entry.path) ? entry.path : join(this.repoRoot, entry.path);
        raw = readFileSync(abs, "utf8");
      } catch {
        continue;
      }
      const lines = raw.split("\n");
      const total = lines.length;
      let ranges: Array<[number, number]>;
      if (raw.length <= perFileChars) {
        ranges = [[1, total]];
      } else if (entry.changed && entry.ranges.length > 0) {
        // Changed files render their edit spans plus a margin, re-read from
        // disk: the model sees what it changed in current form. Read windows
        // that led to the edit stay in the transcript. No head/tail padding.
        const spans = this.editSpans.get(entry.path) ?? [];
        const base = spans.length > 0 ? spans : entry.ranges;
        if (base.length === 0) {
          // Changed by something outside the run (shared tree): location
          // unknown, fall back to the head of the file.
          ranges = [[1, Math.min(40, total)]];
        } else {
          ranges = mergeRanges(
            base.map(
              ([start, end]) => [Math.max(1, start - 10), Math.min(total, end + 10)] as [number, number],
            ),
          );
        }
      } else {
        ranges = entry.ranges.length > 0 ? mergeRanges(entry.ranges) : [];
        ranges.push([1, Math.min(40, total)]);
        // A fully read file is usually edited at the end. Keep the tail
        // visible so the model does not need a re-read just to append.
        if (entry.full) {
          ranges.push([Math.max(1, total - 39), total]);
        }
        ranges = mergeRanges(ranges);
      }
      const body = renderNumberedLines(lines, ranges, perFileChars);
      if (!body.trim()) continue;
      const state = entry.changed
        ? "current after change"
        : entry.preloaded
          ? "preloaded task file"
          : "read";
      const header = `### ${entry.path} (${state} · turn ${entry.lastTurn})`;
      const block = `${header}\n${body}`;
      const remaining = maxChars - used;
      if (remaining <= 0) break;
      const clipped =
        block.length <= remaining
          ? block
          : `${block.slice(0, Math.max(0, remaining - 24)).replace(/\s+$/, "")}\n…[working context truncated]`;
      blocks.push(clipped);
      used += clipped.length;
    }
    if (blocks.length === 0) return "";
    return [
      "<working-context>",
      "Current file content for this run. Prefer it to re-reading. Use context recall for omitted artifacts or ranges.",
      "",
      blocks.join("\n\n"),
      "</working-context>",
    ].join("\n");
  }

  /** Remember exact read bytes for cache hits and durable prompt evidence. */
  rememberRead(input: {
    key: string;
    path: string;
    label: string;
    kind: LedgerEntry["kind"];
    content: string;
    fileSig?: string;
    turn?: number;
  }): void {
    if (!input.key || !input.path || !input.content.trim()) return;
    const content = input.content.length <= 48_000
      ? input.content
      : `${input.content.slice(0, 48_000).replace(/\s+$/, "")}\n…[ledger truncated]`;
    const entry: LedgerEntry = {
      key: input.key,
      path: input.path,
      label: input.label || input.path,
      kind: input.kind,
      content,
      hash: sha1(content),
      chars: content.length,
      turn: input.turn ?? this.currentTurn(),
      ...(input.fileSig ? { fileSig: input.fileSig } : {}),
    };
    this.ledger.delete(input.key);
    this.ledger.set(input.key, entry);
    // Keep the ledger bounded; old entries remain available as artifacts.
    if (this.ledger.size > 200) {
      const oldest = this.ledger.keys().next().value;
      if (typeof oldest === "string") this.ledger.delete(oldest);
    }
  }

  /** Return unchanged cached bytes for a read target, or null. */
  cachedRead(key: string, fileSig?: string): string | null {
    const entry = this.ledger.get(key);
    if (!entry) return null;
    if (entry.fileSig && fileSig && entry.fileSig !== fileSig) return null;
    // Mark it as recently used so the renderer keeps it near the top.
    this.ledger.delete(key);
    this.ledger.set(key, { ...entry, turn: this.currentTurn() });
    return entry.content;
  }

  private currentFileSignature(path: string): string | undefined {
    if (!this.repoRoot) return undefined;
    try {
      const abs = isAbsolute(path) ? path : join(this.repoRoot, path);
      const stat = statSync(abs);
      return `${stat.mtimeMs}:${stat.size}`;
    } catch {
      return undefined;
    }
  }

  /** Render acquired bytes not already present in the curated context. */
  renderLedger(options: {
    maxChars?: number;
    perItemChars?: number;
    excludePaths?: ReadonlySet<string>;
  } = {}): string {
    if (this.ledger.size === 0) return "";
    const maxChars = options.maxChars ?? 24_000;
    if (maxChars <= 0) return "";
    const perItemChars = options.perItemChars ?? 12_000;
    const exclude = options.excludePaths ?? new Set<string>();
    const entries = [...this.ledger.values()]
      .filter((entry) => {
        if (exclude.has(entry.path)) return false;
        if (!entry.fileSig || !this.repoRoot) return true;
        const current = this.currentFileSignature(entry.path);
        return Boolean(current) && entry.fileSig === current;
      })
      .sort((a, b) => b.turn - a.turn);
    if (entries.length === 0) return "";
    const blocks: string[] = [];
    let used = 0;
    let omitted = 0;
    for (const entry of entries) {
      const header = `### ${entry.kind}: ${entry.path}${entry.label && entry.label !== entry.path ? ` — ${entry.label}` : ""} (turn ${entry.turn})`;
      const remaining = maxChars - used - header.length - 2;
      if (remaining <= 0) {
        omitted += 1;
        continue;
      }
      const cap = Math.min(entry.content.length, perItemChars, remaining);
      const body = entry.content.length <= cap
        ? entry.content
        : `${entry.content.slice(0, cap).replace(/\s+$/, "")}\n…[truncated]`;
      const block = `${header}\n${body}`;
      blocks.push(block);
      used += block.length + 2;
    }
    if (blocks.length === 0) return "";
    const note = omitted > 0
      ? `\n\n_${omitted} older ledger entr${omitted === 1 ? "y" : "ies"} not rendered; use context recall or re-read the target._`
      : "";
    return [
      "<ledger>",
      "Acquired context from earlier reads. Use it before re-reading.",
      "",
      blocks.join("\n\n") + note,
      "</ledger>",
    ].join("\n");
  }

  /** Manifest of acquired evidence for run inspection; no bytes. */
  ledgerManifest(): Array<{ key: string; path: string; label: string; kind: LedgerEntry["kind"]; chars: number; turn: number }> {
    return [...this.ledger.values()].map((entry) => ({
      key: entry.key,
      path: entry.path,
      label: entry.label,
      kind: entry.kind,
      chars: entry.chars,
      turn: entry.turn,
    }));
  }

  private dropLedgerPath(path: string): void {
    for (const [key, entry] of this.ledger) {
      if (entry.path === path) this.ledger.delete(key);
    }
  }

  addReadFact(ref: Ref, turn: number, excerptText = ""): void {
    const key = `read:${ref.path}:${ref.range?.join("-") ?? ""}:${ref.hash ?? ""}`;
    this.append({
      type: "fact",
      fact: {
        id: this.id(),
        kind: "finding",
        text: `read ${refLabel(ref)}${excerptText ? `: ${excerptText}` : ""}`,
        refs: [ref],
        turn,
        status: "active",
        key,
      },
    });
  }

  addSearchFact(query: string, refs: Ref[], turn: number, hits = ""): void {
    const key = `search:${sha1(query)}`;
    const normalized = refs.slice(0, 10).map((ref): Ref =>
      this.repoRoot && isAbsolute(ref.path)
        ? { ...ref, path: relative(this.repoRoot, ref.path) }
        : ref,
    );
    this.append({
      type: "fact",
      fact: {
        id: this.id(),
        kind: "finding",
        text: `search "${query}" -> ${refs.length} ref${refs.length === 1 ? "" : "s"}${hits ? `: ${hits}` : ""}`,
        refs: normalized,
        turn,
        status: "active",
        key,
      },
    });
  }

  addCommandFact(name: string, ok: boolean, turn: number, excerptText = ""): void {
    this.append({
      type: "fact",
      fact: {
        id: this.id(),
        kind: "finding",
        text: `command ${name}: ${ok ? "ok" : "error"}${excerptText ? `: ${excerptText}` : ""}`,
        refs: [],
        turn,
        status: "active",
        key: `command:${name}:${ok}`,
      },
    });
  }

  private ignoredStatusPath(path: string): boolean {
    if (path === ".machine_code" || path.startsWith(".machine_code/")) return true;
    if (!this.repoRoot) return false;
    const runPrefix = relative(this.repoRoot, this.runDir).split("\\").join("/");
    if (!runPrefix || runPrefix.startsWith("..")) return false;
    return path === runPrefix || path.startsWith(`${runPrefix}/`);
  }




  addChangeFact(
    path: string,
    ref: Ref,
    turn: number,
    summary: string,
    change?: { agent?: string; model?: string; tool?: string; detail?: string },
  ): void {
    const label = ref.range ? `${path}:${ref.range[0]}-${ref.range[1]}` : path;
    this.append({
      type: "fact",
      fact: {
        id: this.id(),
        kind: "change",
        text: `change ${label}: ${summary.replace(/\s+/g, " ").trim().slice(0, 160)}`,
        refs: [{ ...ref, path }],
        turn,
        status: "active",
        key: `change:${path}`,
      },
    });
  }

  /** Ingest the assistant message and its tool results once per completed turn. */
  ingestTurn(
    input: readonly unknown[],
    turn: number,
    actor?: { agent?: string; model?: string },
  ): { changed: boolean } {
    const messages = input as readonly Record<string, unknown>[];
    let assistantIndex = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i]?.role === "assistant") {
        assistantIndex = i;
        break;
      }
    }
    if (assistantIndex < 0) return { changed: false };
    const assistant = messages[assistantIndex]!;
    // Keep assistant prose for change intent, but do not store it as a state
    // finding. Models write orientation chatter ("I'll start by...") that
    // crowds out the tool evidence in the state block.
    const assistantText = textOf(assistant).replace(/\s+/g, " ").trim();

    const calls = toolCalls(assistant);
    const refs: Ref[] = [];
    const changedPaths = new Set<string>();
    let changed = false;
    let commandRan = false;
    let commandName = "";
    let verified = false;
    let artifacts = 0;
    let explicitFocus = false;

    for (const message of messages.slice(assistantIndex + 1)) {
      if (message.role !== "toolResult") continue;
      const toolName = str(message.toolName) ?? "tool";
      const call = calls.get(str(message.toolCallId) ?? "");
      const args = call?.args ?? {};
      if (toolName === "context") {
        if (args.action === "focus") explicitFocus = true;
        continue;
      }
      // Harness guard errors are not research evidence. Ingesting them would
      // turn warning text into working-set paths and artifacts.
      if (message.isError === true && toolName !== "command") continue;
      const resultText = textOf(message);
      const artifact = this.putArtifact(resultText);
      artifacts += 1;
      const path = str(args.path);
      const hash = artifact.hash.slice(0, 16);

      if (toolName === "read" && path) {
        const header = /^([^:\n]+):(\d+)-(\d+)(?: \(([^)]+)\))?/.exec(resultText.trimStart());
        const symbol = header?.[4] ?? str(args.symbol);
        const numbered = [...resultText.matchAll(/^(\d+): /gm)].map((match) => Number(match[1]));
        if (!header && numbered.length === 0) {
          // A harness note (repeat suppression, seeded pointer) carries no
          // bytes. Never invent a range from the request args for one: the
          // denial would masquerade as coverage of lines never served, and
          // its note text would pollute the working set as a "finding".
          continue;
        }
        let range: [number, number] | undefined;
        if (header) {
          range = [Number(header[2]), Number(header[3])];
        } else if (str(args.symbol)) {
          range = undefined;
        } else if (args.offset != null || args.limit != null) {
          const offset = num(args.offset, 1);
          range = [offset, offset + num(args.limit, 1) - 1];
        } else if (numbered.length > 0) {
          range = [numbered[0]!, numbered[numbered.length - 1]!];
        } else {
          // A read that returned an outline or a harness note has no bytes to
          // record. Never invent a range from the default page size.
          continue;
        }
        const ref: Ref = {
          path,
          ...(symbol ? { symbol } : {}),
          ...(range ? { range } : {}),
          hash,
          artifact: artifact.id,
          bytes: artifact.bytes,
        };
        refs.push(ref);
        this.addReadFact(ref, turn, excerpt(resultText));
      } else if (toolName === "search" || toolName === "map") {
        const action = str(args.action) ?? "overview";
        const mode =
          toolName === "map"
            ? action === "overview"
              ? "map"
              : action === "outline" || action === "sections"
                ? "outline"
                : action
            : str(args.mode) ?? "text";
        const paths = Array.isArray(args.paths)
          ? args.paths.filter((item): item is string => typeof item === "string").join(",")
          : "";
        const query = str(args.pattern) ?? str(args.path) ?? paths;
        const found: Ref[] = [];
        if (mode === "files") {
          for (const line of resultText.split("\n")) {
            const path = line.trim();
            if (!path || path.startsWith("no ") || path.startsWith("[")) continue;
            found.push({ path });
            if (found.length >= 10) break;
          }
        } else if (mode === "outline") {
          const match = /^(.+?) \(\d+ lines\)/.exec(resultText.trimStart());
          if (match) found.push({ path: match[1]!.trim() });
        } else if (mode === "map") {
          let root = "";
          for (const line of resultText.split("\n")) {
            const dir = /^(\S+\/) \(\d+ files\)/.exec(line.trim());
            if (dir) {
              root = dir[1]!;
              found.push({ path: root });
            } else {
              const file = /^\s+(\S+) \(\d+\)/.exec(line);
              if (file && root) found.push({ path: `${root}${file[1]}` });
            }
            if (found.length >= 10) break;
          }
        } else {
          for (const line of resultText.split("\n")) {
            const match = /^([^:\n]+):(\d+)(?::\d+)?/.exec(line.trim());
            if (!match) continue;
            found.push({ path: match[1]!, range: [Number(match[2]), Number(match[2])] });
            if (found.length >= 10) break;
          }
        }
        const hits = found
          .slice(0, 3)
          .map((ref) => `${ref.path}${ref.range ? `:${ref.range[0]}` : ""}`)
          .join(", ");
        this.addSearchFact(mode === "text" ? query : `${mode} ${query}`.trim(), found, turn, hits);
        refs.push(...found.slice(0, 3));
      } else if (toolName === "command") {
        // describe/list are reads. Only run executes a gate or mutates the
        // tree; treating introspection as verification put runs into a test
        // loop before they made a single edit.
        if ((str(args.action) ?? "run") !== "run") continue;
        commandRan = true;
        commandName = str(args.name) ?? "command";
        this.addCommandFact(commandName, message.isError !== true, turn, excerpt(resultText));
        verified = true;
      } else if ((toolName === "edit" || toolName === "write") && path) {
        if (message.isError === true) continue;
        const oldText = str(args.oldString) ?? "";
        const newText = str(args.newString) ?? "";
        const content = str(args.content) ?? "";
        const range = toolName === "edit" ? editRange(this.repoRoot, path, newText) : undefined;
        const ref: Ref = { path, ...(range ? { range } : {}) };
        const delta =
          toolName === "edit"
            ? `edit ${lineCount(oldText)}->${lineCount(newText)} lines (${oldText.length}->${newText.length} chars)`
            : `write ${Buffer.byteLength(content, "utf8")} bytes`;
        const intent = assistantText ? ` · intent: ${inline(assistantText)}` : "";
        this.addChangeFact(path, ref, turn, resultText, {
          ...actor,
          tool: toolName,
          detail: `${resultText} · ${delta}${intent}`,
        });
        refs.push(ref);
        changedPaths.add(path);
        changed = true;
      }
    }

    // Workspace changes are rendered by the workspace block from git diff
    // at prompt time. No parallel git change fact tracking needed.

    if (refs.length > 0 && !explicitFocus) this.append({ type: "focus", refs });
    if (changed) this.setPhase("act");
    else if (verified) this.setPhase("verify");
    this.append({ type: "turn", turn });
    this.recorder?.event("context_ingested", {
      turn,
      facts: this.state.facts.filter((fact) => fact.status === "active").length,
      refs: refs.length,
      artifacts,
    });
    this.saveMarkdown();
    return { changed };
  }

  /** Current git diff summary as a compact workspace block. */
  renderWorkspace(): string {
    if (!this.repoRoot) return "";
    try {
      const diffArgs = ["-C", this.repoRoot, "diff", "--stat"];
      const untrackedArgs = ["-C", this.repoRoot, "ls-files", "--others", "--exclude-standard"];

      let diffOutput: string;
      let untrackedOutput: string;
      if (this.processes) {
        const diff = this.processes.runSync("git", diffArgs,
          { cwd: this.repoRoot, timeoutMs: 3_000, origin: "tool", name: "git:workspace-diff" });
        diffOutput = diff.status === 0 ? diff.stdout : "";
        const untracked = this.processes.runSync("git", untrackedArgs,
          { cwd: this.repoRoot, timeoutMs: 3_000, origin: "tool", name: "git:workspace-untracked" });
        untrackedOutput = untracked.status === 0 ? untracked.stdout : "";
      } else {
        diffOutput = execFileSync("git", diffArgs, { encoding: "utf8", timeout: 3_000 });
        untrackedOutput = execFileSync("git", untrackedArgs, { encoding: "utf8", timeout: 3_000 });
      }

      const changes = diffOutput.trim().split("\n").filter(Boolean);
      const untracked = untrackedOutput.trim().split("\n").filter(Boolean);
      if (changes.length === 0 && untracked.length === 0) return "";

      // Parse diff --stat lines: "src/file.ts | 10 +++++-----" -> just the path
      const changedPaths = changes
        .map((line) => (line.split("|")[0] ?? "").trim())
        .filter((p) => p.length > 0 && !p.includes("file changed") && !p.includes("files changed"));

      const lines: string[] = ["<workspace>"];
      if (changedPaths.length > 0) {
        lines.push(`modified: ${changedPaths.length} file(s)`);
        for (const path of changedPaths) lines.push(`  M ${path}`);
      }
      if (untracked.length > 0) {
        lines.push(`untracked: ${untracked.length} file(s)`);
        for (const path of untracked) lines.push(`  ? ${path}`);
      }
      lines.push("</workspace>");
      return lines.join("\n");
    } catch {
      return "";
    }
  }

    /** Compact model-facing state block: decisions, findings, and open questions. */
  renderBlock(): string {
    let active = this.state.facts.filter((fact) => fact.status === "active");
    const build = (): string => {
      const decisions = active.filter((fact) => fact.kind === "decision");
      const findings = active.filter((fact) => fact.kind === "finding" && !fact.key.startsWith("read:") && !fact.key.startsWith("search:") && !fact.key.startsWith("command:"));
      const changes = active.filter((fact) => fact.kind === "change");
      const runChanges = changes.filter((fact) => !fact.key.startsWith("change:git:"));
      const lines: string[] = ["<run-state>", `Goal: ${this.state.goal}`];
      if (decisions.length > 0) {
        lines.push("Decisions:");
        for (const fact of decisions) lines.push(`- ${fact.text}`);
      }
      if (findings.length > 0) {
        lines.push("Findings:");
        for (const fact of findings) lines.push(`- ${fact.text}`);
      }
      if (runChanges.length > 0) {
        lines.push("Changes:");
        for (const fact of runChanges) lines.push(`- ${fact.text}`);
      }
      const externalChanges = changes.filter((fact) => !runChanges.includes(fact));
      if (externalChanges.length > 0) {
        lines.push("Tree changes (not from this run):");
        for (const fact of externalChanges) lines.push(`- ${fact.text}`);
      }
      const open = this.state.open.filter((question) => question.status === "open");
      if (open.length > 0) {
        lines.push("Open:");
        for (const question of open) lines.push(`- ${question.text}`);
      }
      lines.push("</run-state>");
      return lines.join("\n");
    };

    let block = build();
    if (block.length > MAX_STATE_CHARS) {
      for (const fact of active.filter((item) => item.kind === "finding")) {
        active = active.filter((item) => item !== fact);
        block = build();
        if (block.length <= MAX_STATE_CHARS) break;
      }
    }
    return block;
  }

  renderMarkdown(): string {
    return `# Run state: ${this.state.runId}\nPhase: ${this.state.phase}\n\n${this.renderBlock()}\n`;
  }

  saveMarkdown(): void {
    writeTextAtomic(this.markdownPath, this.renderMarkdown());
  }
}
