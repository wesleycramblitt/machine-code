/**
 * machine_code — held file bodies.
 *
 * Owns the living map: which ranges the model has seen, symbols and
 * connections, and the current bytes re-read from disk. The state ledger
 * only records facts; this store answers "what does the model hold now?".
 */
import { readFileSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { numberLinesCapped } from "../tools/safety.js";
import type { Artifact } from "./artifacts.js";
import type { Ref } from "./state.js";
import { mergeRanges, type Holding } from "./holdings.js";

export interface HoldingsConfig {
  /** Fraction of model input budget to allocate (0.0-1.0). */
  modelPct: number;
  /** Files under this many lines always render full body. */
  fullLines: number;
  /** Seeded files under this many lines always render full body. */
  seededFullLines: number;
  /** Files over this many lines always render metadata-only. */
  outlineLines: number;
  /** Turns since last activity before file is downgraded. */
  recencyTurnsBudget: number;
  /** Turns since last activity before file is evicted to metadata-only. */
  recencyTurnsEvict: number;
  /** Max inventory entries. */
  maxFiles: number;
}

export const DEFAULT_HOLDINGS_CONFIG: HoldingsConfig = {
  modelPct: 0.10,
  fullLines: 50,
  seededFullLines: 200,
  outlineLines: 500,
  recencyTurnsBudget: 3,
  recencyTurnsEvict: 5,
  maxFiles: 40,
};

export interface HoldingHost {
  repoRoot?: string;
  currentTurn: () => number;
  putArtifact(text: string): Artifact;
  addReadFact(ref: Ref, turn: number, excerptText?: string): void;
}

export class HoldingStore {
  readonly map = new Map<string, Holding>();
  constructor(
    private readonly host: HoldingHost,
    private config: HoldingsConfig = DEFAULT_HOLDINGS_CONFIG,
  ) {}

  setConfig(c: Partial<HoldingsConfig>): void {
    this.config = { ...this.config, ...c };
  }

  /** Put task-relevant files in the working set before the first model call. */
  seedWorkingFiles(paths: readonly string[], turn = 0, maxBytes = 65536): void {
    if (!this.host.repoRoot) return;
    for (const [index, path] of paths.entries()) {
      try {
        const abs = isAbsolute(path) ? path : join(this.host.repoRoot, path);
        const content = readFileSync(abs, "utf8");
        if (Buffer.byteLength(content, "utf8") > maxBytes) continue;
        const artifact = this.host.putArtifact(content);
        const total = content.length === 0 ? 1 : content.split("\n").length;
        const ref: Ref = {
          path,
          range: [1, total],
          hash: artifact.hash.slice(0, 16),
          artifact: artifact.id,
          bytes: artifact.bytes,
        };
        this.host.addReadFact(ref, turn);
        this.addHolding(ref.path, ref.range, artifact.id, true, turn, paths.length - index);
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
    priority = 0,
  ): void {
    if (!path) return;
    const existing = this.map.get(path);
    if (existing) {
      if (range) existing.ranges = mergeRanges([...existing.ranges, range]);
      if (artifactId && !existing.artifacts.includes(artifactId)) existing.artifacts.push(artifactId);
      existing.seeded = existing.seeded && seeded;
      existing.priority = Math.max(existing.priority, priority);
      existing.turn = Math.max(existing.turn, turn);
    } else {
      const sig = this.holdingSig(path);
      this.map.set(path, {
        path,
        ranges: range ? [range] : [],
        symbols: [],
        connections: { imports: [], importedBy: [] },
        artifacts: artifactId ? [artifactId] : [],
        seeded,
        acqSig: sig,
        priority,
        turn,
      });
    }
  }

  /** Record a held symbol by name (evidence lines, symbol queries, hints). */
  addSymbol(path: string, name: string, range: [number, number], turn: number): void {
    if (!path || !name) return;
    const existing = this.map.get(path) ?? {
      path,
      ranges: [],
      symbols: [],
      connections: { imports: [], importedBy: [] },
      artifacts: [],
      seeded: false,
      acqSig: this.holdingSig(path),
      priority: 0,
      turn,
    };
    this.map.set(path, existing);
    if (range) existing.ranges = mergeRanges([...existing.ranges, range]);
    if (!existing.symbols.some((s) => s.name === name)) {
      existing.symbols.push({ name, range });
      existing.symbols.sort((a, b) => a.range[0] - b.range[0]);
    }
    existing.turn = Math.max(existing.turn, turn);
  }

  /** Attach file-level doc (from the repo map or file header). */
  setDoc(path: string, doc: string | undefined): void {
    const h = this.map.get(path);
    if (h && doc) h.doc = doc;
  }

  /** Attach a symbol with its doc (from the repo map). */
  addSymbolWithDoc(
    path: string, name: string, range: [number, number], doc: string | undefined, turn: number,
  ): void {
    this.addSymbol(path, name, range, turn);
    if (doc) {
      const h = this.map.get(path);
      const sym = h?.symbols.find((s) => s.name === name);
      if (sym) sym.doc = doc;
    }
  }

  /** Attach connections shown for a file (parsed from inspect relations). */
  addConnections(path: string, imports: string[], importedBy: string[]): void {
    const existing = this.map.get(path);
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
    for (const holding of this.map.values()) {
      if (!holding.artifacts.includes(id)) continue;
      const current = this.holdingSig(holding.path);
      if (current === null) return { path: holding.path, stale: true };
      return { path: holding.path, stale: holding.acqSig !== null && current !== holding.acqSig };
    }
    return null;
  }

  private holdingSig(path: string): string | null {
    if (!this.host.repoRoot) return null;
    try {
      const abs = isAbsolute(path) ? path : join(this.host.repoRoot, path);
      const stat = statSync(abs);
      return `${stat.mtimeMs}:${stat.size}`;
    } catch {
      return null;
    }
  }

  /** Get a tunable value from instance config or the static default. */
  private cfg<K extends keyof HoldingsConfig>(key: K): HoldingsConfig[K] {
    return this.config[key] ?? DEFAULT_HOLDINGS_CONFIG[key];
  }

  /**
   * Durable knowledge as metadata + current bytes. Every holding gets a
   * metadata line (always, even when evicted); bytes are included based on
   * file size, recency, and seeding status. The cap is a hard fail — if
   * exceeded the run aborts so the operator tunes the constants.
   *
   * Priority: files the model just edited/inspected first, then small seeded
   * files, then inspected ranges, then eviction-retry files. Files that do
   * not fit throw so the cap can be tuned.
   */
  renderHoldings(maxChars = 48_000, maxFiles = 40): string {
    const currentTurn = this.host.currentTurn();
    if (this.map.size === 0 || !this.host.repoRoot) return "";
    const sorted = [...this.map.values()].sort((a, b) => a.path.localeCompare(b.path));
    const shown = sorted.slice(0, Math.max(1, maxFiles));
    const lines: string[] = [
      "<holdings>",
      "Every file the run has seen. Metadata is always shown. Bytes are current from disk every turn.",
      "Never re-read what is here. To read a specific symbol, call inspect { query: \"SymbolName\" }.",
      "",
    ];
    let lastDir = "";
    let inventoryUsed = 0;

    // Phase 1: inventory (metadata for every file, always)
    for (const holding of shown) {
      const dir = holding.path.includes("/") ? `${holding.path.split("/").slice(0, -1).join("/")}/` : "./";
      if (dir !== lastDir) {
        lines.push(`[${dir}]`);
        lastDir = dir;
      }
      const lineInfo = holding.ranges.length > 0
        ? `${holding.ranges[0]![0]}-${holding.ranges[holding.ranges.length - 1]![1]} lines`
        : "outline";
      const flags = [
        holding.seeded ? "seeded" : "",
        this.recencyLevel(holding, currentTurn) === "evicted" ? "evicted" : "",
      ].filter(Boolean).join(", ");
      const flagText = flags ? ` [${flags}]` : "";
      const art = holding.artifacts[holding.artifacts.length - 1] ?? "";
      const meta = [
        holding.doc ? `doc: ${holding.doc.slice(0, 120)}` : "",
        holding.symbols.length > 0 ? `symbols: ${holding.symbols.slice(0, 6).map((s) => `${s.name}(${s.range[0]})${s.doc ? ` "${s.doc.slice(0, 60)}"` : ""}`).join(", ")}${holding.symbols.length > 6 ? ", …" : ""}` : "",
        holding.connections.imports.length > 0 ? `imports: ${holding.connections.imports.slice(0, 4).join(", ")}` : "",
        art,
      ].filter(Boolean).join(" · ");
      lines.push(`${holding.path.split("/").pop()}${flagText} — ${lineInfo}${meta ? ` · ${meta}` : ""}`);
      inventoryUsed += lines[lines.length - 1]!.length + 1;
    }
    if (sorted.length > shown.length) {
      const names = sorted.slice(shown.length).map((h) => h.path).join(", ");
      lines.push(`+${sorted.length - shown.length} more: ${names}`);
    }
    if (inventoryUsed > maxChars) {
      throw new Error(`holdings inventory alone exceeds ${maxChars.toLocaleString()} chars (${inventoryUsed.toLocaleString()}); raise maxFiles or reduce file path lengths`);
    }

    // Phase 2: body bytes (size + recency gated)
    const bodyChars = maxChars - inventoryUsed;
    const ordered = [...shown].sort((a, b) => {
      const al = this.recencyLevel(a, currentTurn);
      const bl = this.recencyLevel(b, currentTurn);
      const r = (al === "evicted" ? 0 : al === "budget" ? 1 : 2) - (bl === "evicted" ? 0 : bl === "budget" ? 1 : 2);
      return r || b.priority - a.priority || b.turn - a.turn || a.path.localeCompare(b.path);
    });
    const bodies: string[] = [];
    let used = 0;
    for (const holding of ordered) {
      if (used >= bodyChars) break;
      const level = this.recencyLevel(holding, currentTurn);
      if (level === "evicted") continue;

      const fileLines = this.readLines(holding.path);
      if (!fileLines) continue;
      const totalLines = fileLines.length;

      // Decide which ranges to send based on size and recency.
      let toSend: Array<[number, number]> | null = null;
      if (totalLines <= this.cfg("fullLines")) {
        toSend = [[1, totalLines]]; // full
      } else if (holding.seeded && totalLines <= this.cfg("seededFullLines")) {
        toSend = [[1, totalLines]]; // full
      } else if (totalLines <= this.cfg("outlineLines") && level === "budget") {
        toSend = [...holding.ranges]; // user-chosen ranges
      } else if (level === "active") {
        toSend = [[1, Math.min(totalLines, this.cfg("outlineLines"))]]; // recent, cap at outline
      }
      if (!toSend || toSend.length === 0) {
        // Metadata-only: body block skipped entirely.
        continue;
      }
      const parts: string[] = [];
      for (const [start, end] of toSend) {
        const clamped = Math.min(end, totalLines);
        const page = numberLinesCapped(fileLines, start, Math.max(1, clamped - start + 1), Math.max(256, bodyChars - used));
        parts.push(page.text);
        used += page.text.length + 1;
        if (used >= bodyChars) break;
      }
      if (parts.length === 0) continue;
      const art = holding.artifacts[holding.artifacts.length - 1] ?? "";
      bodies.push(`### ${holding.path}${art ? ` · ${art}` : ""}\n${parts.join("\n")}`);
    }
    lines.push("", ...bodies);
    lines.push("</holdings>");

    const total = lines.reduce((s, l) => s + l.length + 1, 0);
    if (total > maxChars) {
      throw new Error(
        `holdings block exceeds ${maxChars.toLocaleString()} chars (${total.toLocaleString()}). ` +
        `Tune holdings config (outlineLines, fullLines, modelPct) or raise the cap. ` +
        `Pending: ${sorted.filter((h) => this.recencyLevel(h, currentTurn) !== "evicted" && !bodies.some((b) => b.includes(h.path))).map((h) => h.path).join(", ") || "none"}`,
      );
    }
    return lines.join("\n");
  }

  /** Which byte level a holding qualifies for based on turn recency. */
  private recencyLevel(holding: Holding, currentTurn: number): "evicted" | "budget" | "active" {
    const age = currentTurn - holding.turn;
    if (age > this.cfg("recencyTurnsEvict")) return "evicted";
    if (age > this.cfg("recencyTurnsBudget")) return "budget";
    return "active";
  }

  private readLines(path: string): string[] | null {
    try {
      const abs = isAbsolute(path) ? path : join(this.host.repoRoot!, path);
      return readFileSync(abs, "utf8").split("\n");
    } catch {
      return null;
    }
  }

  /** Pre-fill the map from hint symbols: ranges register as unsent, so the
   * first render carries their bodies as deltas without an inspect call. */
  seedHintRanges(entries: ReadonlyArray<{ path: string; range: [number, number] }>, turn = 0): void {
    const seeded = entries.slice(0, 24);
    for (const [index, entry] of seeded.entries()) {
      if (!entry.path || entry.range[0] < 1 || entry.range[1] < entry.range[0]) continue;
      // Store a preamble artifact even for hint ranges so the model can
      // recall the file's approximate state before the tip changed.
      const snippet = `hint range ${entry.path}:${entry.range[0]}-${entry.range[1]}`;
      const art = this.host.putArtifact(snippet);
      this.addHolding(entry.path, entry.range, art.id, false, turn, seeded.length - index);
    }
  }

}
