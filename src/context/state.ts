/**
 * machine_code — run state: facts, working set, changes, and a durable ledger.
 *
 * state.jsonl is the authoritative record. The live prompt is rendered from
 * this state plus the current step; the raw transcript is never replayed.
 */
import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";
import { getArtifact, putArtifact, type Artifact } from "./artifacts.js";
import { readGitStatus, type GitStatusEntry } from "./git-status.js";
import type { ProcessSupervisor } from "../processes/supervisor.js";
import { markSemanticDirty } from "../map/semantic.js";
import { recordSemanticChange } from "../map/changes.js";

/** Keep the model-facing state block compact; full facts remain in state.jsonl. */
const MAX_STATE_CHARS = 10_000;
const PLAN_NEXT = /^(?:execute the plan|make the first edit)\b/i;
const VERIFY_NEXT = "Verify the change: run the task's tests and typecheck.";

export type FactKind = "finding" | "decision" | "change" | "issue";
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
  nextAction?: string;
  /** Turn that recorded the current next action. */
  nextActionTurn?: number;
  facts: Fact[];
  workingSet: Ref[];
  open: OpenQuestion[];
  counters: { turn: number; steps: number; artifacts: number };
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
  /** Git status at run construction; only deltas belong to this run. */
  private gitBaseline: Map<string, GitStatusEntry> | null = null;

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
    if (this.repoRoot) this.gitBaseline = readGitStatus(this.repoRoot, this.processes);
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
          for (const existing of this.state.facts) {
            if (existing.status !== "active") continue;
            if (existing.key === fact.key) existing.status = "stale";
            if (existing.refs.some((ref) => ref.path === fact.refs[0]?.path)) {
              const newHash = fact.refs[0]?.hash;
              if (!newHash || existing.refs.some((ref) => ref.path === fact.refs[0]?.path && ref.hash !== newHash)) {
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
      case "next":
        this.state.nextAction = entry.text.trim() || undefined;
        this.state.nextActionTurn = entry.turn ?? this.state.counters.turn;
        break;
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

  note(kind: "finding" | "decision" | "open" | "next", text: string, refs: string[] = [], turn?: number): void {
    const clean = text.replace(/\s+/g, " ").trim();
    if (!clean) return;
    const at = turn ?? this.currentTurn();
    if (kind === "next") {
      this.append({ type: "next", text: clean.slice(0, 240), turn: at });
      this.saveMarkdown();
      return;
    }
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

  /** Remember an issue by number so the next prompt still has the graph. */
  addIssueFact(number: number | string, text: string, turn?: number): void {
    const at = turn ?? this.currentTurn();
    const clean = text.replace(/\s+/g, " ").trim();
    if (!clean) return;
    this.append({
      type: "fact",
      fact: {
        id: this.id(),
        kind: "issue",
        text: clean.slice(0, 240),
        refs: [],
        turn: at,
        status: "active",
        key: `issue:${number}`,
      },
    });
    this.saveMarkdown();
  }

  /**
   * Remember a short body excerpt only when the model explicitly views an
   * issue. Create/edit/plan already return the compact issue fact; storing the
   * authored body again makes every later prompt larger.
   */
  addIssueBodyFact(number: number | string, body: string, turn?: number): void {
    const at = turn ?? this.currentTurn();
    const clean = body.replace(/\s+/g, " ").trim();
    if (!clean) return;
    this.append({
      type: "fact",
      fact: {
        id: this.id(),
        kind: "finding",
        text: `#${number} body: ${clean.slice(0, 300)}`,
        refs: [],
        turn: at,
        status: "active",
        key: `issue-body:${number}`,
      },
    });
    this.saveMarkdown();
  }

  private ignoredStatusPath(path: string): boolean {
    if (path === ".machine_code" || path.startsWith(".machine_code/")) return true;
    if (!this.repoRoot) return false;
    const runPrefix = relative(this.repoRoot, this.runDir).split("\\").join("/");
    if (!runPrefix || runPrefix.startsWith("..")) return false;
    return path === runPrefix || path.startsWith(`${runPrefix}/`);
  }

  /** New or changed status entries since the last snapshot. */
  private syncGitChanges(known: ReadonlySet<string>): Array<{ path: string; code: string }> {
    if (!this.repoRoot || !this.gitBaseline) return [];
    const current = readGitStatus(this.repoRoot, this.processes);
    if (!current) return [];
    const changed: Array<{ path: string; code: string }> = [];
    for (const [path, entry] of current) {
      if (this.ignoredStatusPath(path)) continue;
      if (known.has(path)) continue;
      const prior = this.gitBaseline.get(path);
      if (prior && prior.code === entry.code && prior.mtimeMs === entry.mtimeMs && prior.size === entry.size) {
        continue;
      }
      changed.push({ path, code: entry.code });
    }
    this.gitBaseline = current;
    return changed;
  }

  /** Replace a plan's "first edit" next action once a change exists. */
  private settleNextAfterChange(turn: number): void {
    if (!this.state.nextAction || PLAN_NEXT.test(this.state.nextAction)) {
      this.append({ type: "next", text: VERIFY_NEXT, turn });
    }
  }

  private addGitChangeFact(
    items: ReadonlyArray<{ path: string; code: string }>,
    turn: number,
    actor?: { agent?: string; model?: string },
    commandName?: string,
  ): void {
    if (!this.repoRoot || items.length === 0) return;
    const paths = [...new Set(items.map((item) => item.path))].sort();
    for (const item of items) {
      markSemanticDirty(this.repoRoot, [item.path]);
      recordSemanticChange(this.repoRoot, {
        runId: this.runId,
        turn,
        agent: actor?.agent ?? "unknown",
        ...(actor?.model ? { model: actor.model } : {}),
        path: item.path,
        tool: "git",
        detail: `git status ${item.code} ${item.path}${commandName ? ` · via ${commandName}` : ""}`,
      });
    }
    const shown = paths.slice(0, 8).join(", ");
    this.append({
      type: "fact",
      fact: {
        id: this.id(),
        kind: "change",
        text: `git status changed ${paths.length} path(s): ${shown}${paths.length > 8 ? " …" : ""}`,
        refs: paths.slice(0, 10).map((path) => ({ path })),
        turn,
        status: "active",
        key: `change:git:${sha1(paths.join("\0"))}`,
      },
    });
    this.settleNextAfterChange(turn);
  }

  addChangeFact(
    path: string,
    ref: Ref,
    turn: number,
    summary: string,
    change?: { agent?: string; model?: string; tool?: string; detail?: string },
  ): void {
    if (this.repoRoot) {
      markSemanticDirty(this.repoRoot, [path]);
      recordSemanticChange(this.repoRoot, {
        runId: this.runId,
        turn,
        agent: change?.agent ?? "unknown",
        ...(change?.model ? { model: change.model } : {}),
        path,
        tool: change?.tool ?? "edit",
        detail: change?.detail ?? summary,
      });
    }
    this.append({
      type: "fact",
      fact: {
        id: this.id(),
        kind: "change",
        text: `change ${path}: ${summary.replace(/\s+/g, " ").trim().slice(0, 160)}`,
        refs: [{ ...ref, path }],
        turn,
        status: "active",
        key: `change:${path}`,
      },
    });
    this.settleNextAfterChange(turn);
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
        const range: [number, number] | undefined = header
          ? [Number(header[2]), Number(header[3])]
          : str(args.symbol)
            ? undefined
            : [num(args.offset, 1), num(args.offset, 1) + num(args.limit, 1) - 1];
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
      } else if (toolName === "search") {
        const mode = str(args.mode) ?? "text";
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
        commandRan = true;
        commandName = str(args.name) ?? "command";
        this.addCommandFact(commandName, message.isError !== true, turn, excerpt(resultText));
        verified = true;
      } else if ((toolName === "edit" || toolName === "write") && path) {
        if (message.isError === true) continue;
        const ref: Ref = { path };
        const oldText = str(args.oldString) ?? "";
        const newText = str(args.newString) ?? "";
        const content = str(args.content) ?? "";
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

    // Git status is the safety net for deletes, renames, formatters, and
    // command-side writes. Edit/write keep the precise intent.
    if (changed || commandRan) {
      const gitChanges = this.syncGitChanges(changedPaths);
      if (gitChanges.length > 0) {
        this.addGitChangeFact(gitChanges, turn, actor, commandName);
        for (const item of gitChanges) changedPaths.add(item.path);
        changed = true;
      }
    }

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

  /** Compact model-facing state block, capped by dropping body findings first. */
  renderBlock(): string {
    let active = this.state.facts.filter((fact) => fact.status === "active");
    const build = (): string => {
      const decisions = active.filter((fact) => fact.kind === "decision");
      const issues = active.filter((fact) => fact.kind === "issue");
      const findings = active.filter((fact) => fact.kind === "finding");
      const readFacts = findings.filter((fact) => fact.key.startsWith("read:") && fact.refs.length > 0);
      const otherFindings = findings.filter((fact) => !fact.key.startsWith("read:"));
      const changes = active.filter((fact) => fact.kind === "change");
      const planDecision = decisions.some((fact) => /\bplan\b/i.test(fact.text));
      const lines: string[] = ["<run-state>", `Goal: ${this.state.goal}`];
      if (decisions.length > 0) {
        lines.push("Decisions:");
        for (const fact of decisions) lines.push(`- ${fact.text}`);
      }
      // A plan that has not changed for several turns is stale. Do not let the
      // model follow yesterday's "explore" instruction forever. Once a plan
      // exists, the next action is the first edit, not more reading.
      const nextTurn = this.state.nextActionTurn;
      const nextAge = nextTurn === undefined ? 0 : this.currentTurn() - nextTurn;
      const planNext = PLAN_NEXT.test(this.state.nextAction ?? "");
      if (changes.length > 0 && (planNext || !this.state.nextAction || nextAge > 6)) {
        lines.push(`Next: ${VERIFY_NEXT}`);
      } else if (planDecision && changes.length === 0) {
        lines.push("Next: Execute the plan: make the first edit.");
      } else if (this.state.nextAction && nextAge <= 6) {
        lines.push(`Next: ${this.state.nextAction}`);
      } else {
        lines.push(`Next: unset — record the next action with context note kind "next".`);
      }
      if (readFacts.length > 0) {
        lines.push("Read coverage:");
        const coverage = new Map<string, { ranges: Array<[number, number]>; symbols: Set<string>; all: boolean }>();
        for (const fact of readFacts) {
          const ref = fact.refs[0]!;
          const entry = coverage.get(ref.path) ?? { ranges: [], symbols: new Set<string>(), all: false };
          if (ref.range) entry.ranges.push([ref.range[0], ref.range[1]]);
          else if (ref.symbol) entry.symbols.add(ref.symbol);
          else entry.all = true;
          coverage.set(ref.path, entry);
        }
        let shownPaths = 0;
        for (const [path, entry] of coverage) {
          if (shownPaths >= 12) {
            lines.push(`- … ${coverage.size - shownPaths} more file(s) read`);
            break;
          }
          shownPaths += 1;
          const merged = mergeRanges(entry.ranges);
          const parts = [
            ...(entry.all ? ["all"] : []),
            ...merged.slice(-10).map(([start, end]) => `${start}-${end}`),
            ...[...entry.symbols].slice(0, 4).map((symbol) => `symbol ${symbol}`),
          ];
          const older = merged.length > 10 ? ` (+${merged.length - 10} earlier range(s))` : "";
          lines.push(`- ${path}: ${parts.join(", ") || "seen"}${older}`);
        }
      }
      if (issues.length > 0) {
        lines.push("Issues:");
        const shown = issues.slice(-40);
        for (const fact of shown) lines.push(`- ${fact.text}`);
        if (issues.length > shown.length) {
          lines.push(`- … ${issues.length - shown.length} older issue(s) omitted; use issue list or tree to inspect`);
        }
      }
      if (otherFindings.length > 0) {
        lines.push("Findings:");
        for (const fact of otherFindings) lines.push(`- t${fact.turn}: ${fact.text}`);
      }
      if (this.state.workingSet.length > 0) {
        lines.push("Working set:");
        for (const ref of this.state.workingSet) lines.push(`- ${refLabel(ref)}`);
      }
      if (changes.length > 0) {
        lines.push("Changes:");
        for (const fact of changes) lines.push(`- ${fact.text}`);
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
    if (block.length <= MAX_STATE_CHARS) return block;
    const bodyKeys = new Set(
      active.filter((fact) => fact.key.startsWith("issue-body:")).map((fact) => fact.key),
    );
    if (bodyKeys.size > 0) {
      active = active.filter((fact) => !bodyKeys.has(fact.key));
      block = build();
    }
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
