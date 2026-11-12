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
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";
import { getArtifact, putArtifact, type Artifact } from "./artifacts.js";
import type { ProcessSupervisor } from "../processes/supervisor.js";
import { rangesOverlap } from "./holdings.js";
import { HoldingStore } from "./holding-store.js";
import { ingestTurn as ingestTurnInto } from "./ingest.js";

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
  readonly repoRoot?: string;
  private readonly recorder?: EventSink;
  private readonly processes?: ProcessSupervisor;
  private state: RunState;
  private sequence = 0;
  private readonly holdingsStore: HoldingStore;

  constructor(options: StateStoreOptions) {
    this.runDir = options.runDir;
    this.runId = options.runId;
    this.repoRoot = options.repoRoot;
    this.recorder = options.recorder;
    this.processes = options.processes;
    this.holdingsStore = new HoldingStore({
      repoRoot: options.repoRoot,
      putArtifact: (text) => this.putArtifact(text),
      addReadFact: (ref, turn, excerptText) => this.addReadFact(ref, turn, excerptText),
    });
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

  seedWorkingFiles(paths: readonly string[], turn = 0, maxBytes = 65536): void {
    this.holdingsStore.seedWorkingFiles(paths, turn, maxBytes);
  }

  seedHintRanges(entries: ReadonlyArray<{ path: string; range: [number, number] }>, turn = 0): void {
    this.holdingsStore.seedHintRanges(entries, turn);
  }

  renderHoldings(maxChars = 24_000, maxFiles = 40): string {
    return this.holdingsStore.renderHoldings(maxChars, maxFiles);
  }

  artifactStatus(id: string): { path: string; stale: boolean } | null {
    return this.holdingsStore.artifactStatus(id);
  }

  get holdings(): HoldingStore {
    return this.holdingsStore;
  }

  appendTurn(turn: number): void {
    this.append({ type: "turn", turn });
  }

  activeFacts(): number {
    return this.state.facts.filter((fact) => fact.status === "active").length;
  }

  event(type: string, data?: Record<string, unknown>): void {
    this.recorder?.event(type, data);
  }

  save(): void {
    this.saveMarkdown();
  }

  ingestTurn(
    input: readonly unknown[],
    turn: number,
    actor?: { agent?: string; model?: string },
  ): { changed: boolean } {
    return ingestTurnInto(this, input, turn, actor);
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
      const next = this.state.phase === "done"
        ? "finished"
        : this.state.phase === "verify"
          ? "fix any gate output, then call finish again"
          : "make the smallest change that satisfies the issue, then call finish";
      const lines: string[] = ["<run-state>", `Goal: ${this.state.goal}`, `Phase: ${this.state.phase} · next: ${next}`];
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
