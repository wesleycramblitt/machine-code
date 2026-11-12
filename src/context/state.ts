/**
 * machine_code — run state: facts, holdings, changes, and a durable ledger.
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
import { dirname, isAbsolute, join, relative } from "node:path";
import { numberLinesCapped } from "../tools/safety.js";
import { getArtifact, putArtifact, type Artifact } from "./artifacts.js";
import type { ProcessSupervisor } from "../processes/supervisor.js";

/** Keep the model-facing state block compact; full facts remain in state.jsonl. */
const MAX_STATE_CHARS = 10_000;

export type FactKind = "finding" | "decision" | "change";
export type RefKind = "read" | "search" | "edit";

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
  open: OpenQuestion[];
  counters: { turn: number; steps: number; artifacts: number };
}

/** File bodies this run has acquired: the model's durable knowledge.
 * Rendered per turn as inventory (always) + deltas (new/changed only),
 * re-read from disk so bytes are always current. Replaces the old
 * working-file set and read ledger with one map and one rule:
 * a signature match means the model already holds it. */
export interface Holding {
  path: string;
  ranges: Array<[number, number]>;
  /** Symbols held, by name — the map fills in at symbol granularity. */
  symbols: Array<{ name: string; range: [number, number] }>;
  /** Connections shown for this file, parsed from inspect results. */
  connections: { imports: string[]; importedBy: string[] };
  artifacts: string[];
  /** Fully present in the stable prefix: bytes skipped until it changes. */
  seeded: boolean;
  /** Disk signature when first acquired; recall compares against it. */
  acqSig: string | null;
  /** Disk signature the last send reflected (null = never sent). */
  sentSig: string | null;
  /** Ranges already sent (a subset of ranges once the file changes). */
  sentRanges: Array<[number, number]>;
  turn: number;
}

type Entry =
  | { type: "init"; runId: string; goal: string }
  | { type: "fact"; fact: Fact }
  | { type: "stale"; id: string }
  | { type: "resolve"; id: string }
  | { type: "next"; text: string; turn?: number }
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

/** Parts of `held` not covered by `sent`. Both must be merged + sorted. */
function unsentRanges(
  held: ReadonlyArray<readonly [number, number]>,
  sent: ReadonlyArray<readonly [number, number]>,
): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  let j = 0;
  for (const [start, end] of held) {
    let cursor = start;
    while (j < sent.length && sent[j]![1] < cursor) j += 1;
    let k = j;
    while (k < sent.length && sent[k]![0] <= end) {
      const [s, e] = sent[k]!;
      if (s > cursor) out.push([cursor, Math.min(end, s - 1)]);
      cursor = Math.max(cursor, e + 1);
      if (cursor > end) break;
      k += 1;
    }
    if (cursor <= end) out.push([cursor, end]);
  }
  return out;
}

/** Merge overlapping or adjacent line ranges for compact coverage. */
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
  /** Acquired file bodies: inventory always renders, deltas on change. */
  private holdings = new Map<string, Holding>();

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
        this.addHolding(ref.path, ref.range, artifact.id, true, turn);
        const holding = this.holdings.get(path);
        // Optimistic: the stable prefix already carries these bytes, so the
        // first render sends inventory only. A per-model trim can drop them
        // (same limitation the old pin had); recall + resend cover it.
        if (holding) {
          holding.sentSig = this.holdingSig(path);
          holding.sentRanges = [...holding.ranges];
        }
      } catch {
        // A missing or unreadable preload is not a run failure.
      }
    }
  }

  /**
   * Record acquired file bodies. Ranges merge per path; bytes always render
   * from disk, artifacts stay addressable for recall.
   */
  addHolding(
    path: string,
    range: [number, number] | undefined,
    artifactId: string,
    seeded: boolean,
    turn: number,
  ): void {
    if (!path) return;
    const existing = this.holdings.get(path);
    if (existing) {
      if (range) existing.ranges = mergeRanges([...existing.ranges, range]);
      if (artifactId && !existing.artifacts.includes(artifactId)) existing.artifacts.push(artifactId);
      existing.seeded = existing.seeded && seeded;
      existing.turn = Math.max(existing.turn, turn);
    } else {
      const sig = this.holdingSig(path);
      this.holdings.set(path, {
        path,
        ranges: range ? [range] : [],
        symbols: [],
        connections: { imports: [], importedBy: [] },
        artifacts: artifactId ? [artifactId] : [],
        seeded,
        acqSig: sig,
        sentSig: null,
        sentRanges: [],
        turn,
      });
    }
  }

  /** Record a held symbol by name (evidence lines, symbol queries, hints). */
  addSymbol(path: string, name: string, range: [number, number], turn: number): void {
    if (!path || !name) return;
    const existing = this.holdings.get(path) ?? {
      path,
      ranges: [],
      symbols: [],
      connections: { imports: [], importedBy: [] },
      artifacts: [],
      seeded: false,
      acqSig: this.holdingSig(path),
      sentSig: null,
      sentRanges: [],
      turn,
    };
    this.holdings.set(path, existing);
    if (range) existing.ranges = mergeRanges([...existing.ranges, range]);
    if (!existing.symbols.some((s) => s.name === name)) {
      existing.symbols.push({ name, range });
      existing.symbols.sort((a, b) => a.range[0] - b.range[0]);
    }
    existing.turn = Math.max(existing.turn, turn);
  }

  /** Attach connections shown for a file (parsed from inspect relations). */
  addConnections(path: string, imports: string[], importedBy: string[]): void {
    const existing = this.holdings.get(path);
    if (!existing) return;
    for (const name of imports) {
      const clean = name.trim().replace(/,?\s*…$/, "");
      if (clean && !existing.connections.imports.includes(clean)) existing.connections.imports.push(clean);
    }
    for (const name of importedBy) {
      const clean = name.trim().replace(/,?\s*…$/, "");
      if (clean && !existing.connections.importedBy.includes(clean)) existing.connections.importedBy.push(clean);
    }
  }

  /**
   * Staleness of a recalled artifact: the file it came from and whether the
   * disk has moved since acquisition. Bytes and command outputs have no
   * path and are never stale — only file bodies are checked.
   */
  artifactStatus(id: string): { path: string; stale: boolean } | null {
    for (const holding of this.holdings.values()) {
      if (!holding.artifacts.includes(id)) continue;
      const current = this.holdingSig(holding.path);
      if (current === null) return { path: holding.path, stale: true };
      return { path: holding.path, stale: holding.acqSig !== null && current !== holding.acqSig };
    }
    return null;
  }

  private holdingSig(path: string): string | null {
    if (!this.repoRoot) return null;
    try {
      const abs = isAbsolute(path) ? path : join(this.repoRoot, path);
      const stat = statSync(abs);
      return `${stat.mtimeMs}:${stat.size}`;
    } catch {
      return null;
    }
  }

  /**
   * Durable knowledge as inventory + deltas. Every holding gets one
   * inventory line (names are never dropped); only new or changed files
   * render bytes, re-read from disk so the model sees current state.
   * Seeded files skip bytes until they change (the stable prefix has them).
   * Past the cap, bytes yield to artifact ids and inspect anchors.
   *
   * Dropping policy: inventory lists every holding (capped at maxFiles with
   * a names-only overflow line — addressability is never lost). Deltas favor
   * recent acquisitions first; files that do not fit keep their old sentSig
   * and retry next turn; a single file larger than the cap sends a truncated
   * head marked with its artifact id and inspect path.
   */
  renderHoldings(maxChars = 12_000, maxFiles = 40): string {
    if (this.holdings.size === 0 || !this.repoRoot) return "";
    const sorted = [...this.holdings.values()].sort((a, b) => a.path.localeCompare(b.path));
    const shown = sorted.slice(0, Math.max(1, maxFiles));
    const lines: string[] = ["<holdings>", "Living map: files held, with symbols held, connections, and current bytes. Older bytes live in artifacts."];
    let lastDir = "";
    for (const holding of shown) {
      const dir = holding.path.includes("/") ? `${holding.path.split("/").slice(0, -1).join("/")}/` : "./";
      if (dir !== lastDir) {
        lines.push(`[${dir}]`);
        lastDir = dir;
      }
      const rangeText = holding.ranges.length > 0
        ? holding.ranges.map(([s, e]) => (s === e ? `${s}` : `${s}-${e}`)).join(",")
        : "outline";
      const art = holding.artifacts[holding.artifacts.length - 1] ?? "";
      const bits = [rangeText];
      if (holding.symbols.length > 0) {
        const names = holding.symbols.slice(0, 6).map((s) => `${s.name} (${s.range[0]}-${s.range[1]})`).join(", ");
        bits.push(`symbols: ${names}${holding.symbols.length > 6 ? ", …" : ""}`);
      }
      const relations = [
        ...(holding.connections.imports.length > 0 ? [`imports: ${holding.connections.imports.slice(0, 4).join(", ")}`] : []),
        ...(holding.connections.importedBy.length > 0 ? [`imported by: ${holding.connections.importedBy.slice(0, 4).join(", ")}`] : []),
      ].join(" · ");
      if (relations) bits.push(relations);
      if (art) bits.push(art);
      if (holding.seeded) bits.push("seeded");
      lines.push(`- ${holding.path.split("/").pop()}: ${bits.join(" · ")}`);
    }
    if (sorted.length > shown.length) {
      const names = sorted.slice(shown.length).map((holding) => holding.path).join(", ");
      lines.push(`- +${sorted.length - shown.length} more holdings (names only, bytes via recall): ${names}`);
    }
    const deltas: string[] = [];
    const pending: string[] = [];
    let used = 0;
    const ordered = [...shown].sort((a, b) => b.turn - a.turn || a.path.localeCompare(b.path));
    for (const holding of ordered) {
      if (used >= maxChars) {
        pending.push(holding.path);
        continue;
      }
      const sig = this.holdingSig(holding.path);
      if (sig === null) {
        const art = holding.artifacts[holding.artifacts.length - 1] ?? "";
        deltas.push(`### ${holding.path} (unreadable since acquired${art ? `; recall ${art}` : ""})`);
        continue;
      }
      if (holding.ranges.length === 0) {
        holding.sentSig = sig;
        continue;
      }
      if (holding.seeded && holding.sentSig === null) {
        // Already in the stable prefix: inventory suffices until it changes.
        holding.sentSig = sig;
        holding.sentRanges = [...holding.ranges];
        continue;
      }
      // Changed file → resend all held ranges (they may all be stale).
      // Unchanged file → send only ranges the model has never been sent.
      const changed = sig !== holding.sentSig;
      const toSend = changed ? holding.ranges : unsentRanges(holding.ranges, holding.sentRanges);
      if (toSend.length === 0) continue;
      let raw: string;
      try {
        const abs = isAbsolute(holding.path) ? holding.path : join(this.repoRoot, holding.path);
        raw = readFileSync(abs, "utf8");
      } catch {
        continue;
      }
      const fileLines = raw.split("\n");
      const parts: string[] = [];
      for (const [start, end] of toSend) {
        const page = numberLinesCapped(fileLines, start, Math.max(1, end - start + 1), Math.max(256, maxChars - used));
        parts.push(page.text);
        used += page.text.length + 1;
        if (used >= maxChars) break;
      }
      const art = holding.artifacts[holding.artifacts.length - 1] ?? "";
      deltas.push(`### ${holding.path}: held ranges (current)${art ? ` · ${art}` : ""}\n${parts.join("\n")}`);
      holding.sentSig = sig;
      holding.sentRanges = changed ? [...holding.ranges] : mergeRanges([...holding.sentRanges, ...toSend]);
    }
    lines.push(...deltas);
    if (pending.length > 0) {
      lines.push(`_unsent this turn (cap reached; retries next turn): ${pending.join(", ")}_`);
    }
    lines.push("</holdings>");
    return lines.join("\n");
  }

  /** Pre-fill the map from hint symbols: ranges register as unsent, so the
   * first render carries their bodies as deltas without an inspect call. */
  seedHintRanges(entries: ReadonlyArray<{ path: string; range: [number, number] }>, turn = 0): void {
    for (const entry of entries.slice(0, 24)) {
      if (!entry.path || entry.range[0] < 1 || entry.range[1] < entry.range[0]) continue;
      this.addHolding(entry.path, entry.range, "", false, turn);
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
    let changed = false;
    let commandRan = false;
    let commandName = "";
    let verified = false;
    let artifacts = 0;

    for (const message of messages.slice(assistantIndex + 1)) {
      if (message.role !== "toolResult") continue;
      const toolName = str(message.toolName) ?? "tool";
      const call = calls.get(str(message.toolCallId) ?? "");
      const args = call?.args ?? {};
      if (toolName === "context") continue;
      // Harness guard errors are not research evidence. Ingesting them would
      // turn warning text into working-set paths and artifacts.
      if (message.isError === true && toolName !== "command") continue;
      const resultText = textOf(message);
      const artifact = this.putArtifact(resultText);
      artifacts += 1;
      const path = str(args.path);
      const hash = artifact.hash.slice(0, 16);

      if (toolName === "search" || toolName === "map") {
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
      } else if (toolName === "inspect") {
        const query = str(args.query) ?? str(args.name) ?? str(args.path) ?? "";
        const mode = /mode="(file|symbol|directory|find)"/.exec(resultText)?.[1] ?? "find";
        const artifactId = /\[artifact: ([^\]]+)\]/.exec(resultText)?.[1] ?? artifact.id;
        const found: Ref[] = [];
        let current: string | null = null;
        for (const line of resultText.split("\n")) {
          const header = /^### (.+?): (\d+)-(\d+) of \d+ lines/.exec(line.trim());
          if (header) {
            current = header[1]!;
            const ref = { path: current, range: [Number(header[2]), Number(header[3])] as [number, number] };
            found.push(ref);
            this.addHolding(current, ref.range, artifactId, false, turn);
            if (mode === "symbol" && query && !query.includes("/") && !query.includes(" ")) {
              this.addSymbol(current, query, ref.range, turn);
            }
            continue;
          }
          const section = /^## (.+?) — .*\[match: /.exec(line.trim());
          if (section) {
            current = section[1]!;
            found.push({ path: current });
            continue;
          }
          const evidence = /^  "[^"]+" → \S+ (\S+) \((\d+)-(\d+)\)/.exec(line);
          if (evidence && current) {
            const range: [number, number] = [Number(evidence[2]), Number(evidence[3])];
            this.addHolding(current, range, artifactId, false, turn);
            this.addSymbol(current, evidence[1]!, range, turn);
            continue;
          }
          const relations = /^  (imports: .+|imported by: .+)(\s+·\s+(imports: .+|imported by: .+))?$/.exec(line);
          if (relations && current) {
            const parts = line.trim().split(/\s+·\s+/);
            const imports: string[] = [];
            const importedBy: string[] = [];
            for (const part of parts) {
              if (part.startsWith("imports:")) imports.push(...part.slice("imports:".length).split(","));
              else if (part.startsWith("imported by:")) importedBy.push(...part.slice("imported by:".length).split(","));
            }
            this.addConnections(current, imports, importedBy);
          }
        }
        if ((mode === "file" || mode === "symbol") && found.length === 0 && str(args.path)) {
          const ref = { path: str(args.path)! };
          found.push(ref);
          this.addHolding(ref.path, undefined, artifactId, false, turn);
        }
        if (mode === "file" || mode === "symbol") {
          const ref = found[0];
          if (ref) this.addReadFact({ ...ref, hash, artifact: artifact.id, bytes: artifact.bytes }, turn, excerpt(resultText));
        } else if (found.length > 0) {
          const hits = found.slice(0, 3).map((ref) => `${ref.path}${ref.range ? `:${ref.range[0]}` : ""}`).join(", ");
          this.addSearchFact(query || mode, found.slice(0, 10), turn, hits);
        }
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
        changed = true;
      }
    }

    // Workspace changes are rendered by the workspace block from git diff
    // at prompt time. No parallel git change fact tracking needed.

    if (changed) this.setPhase("act");
    else if (verified) this.setPhase("verify");
    this.append({ type: "turn", turn });
    this.recorder?.event("context_ingested", {
      turn,
      facts: this.state.facts.filter((fact) => fact.status === "active").length,
      holdings: this.holdings.size,
      artifacts,
    });
    this.saveMarkdown();
    return { changed };
  }

  /** Current git diff summary as a compact workspace block.
   *
   * Diffed against HEAD (not the empty diff): the worktree branch starts at
   * the run's base ref and the agent never commits, so HEAD is the original
   * state and this block is the cumulative change since the run began —
   * staged and unstaged — plus untracked files. */
  renderWorkspace(): string {
    if (!this.repoRoot) return "";
    try {
      const diffArgs = ["-C", this.repoRoot, "diff", "HEAD", "--stat"];
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
