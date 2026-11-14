/**
 * machine_code — held file index.
 *
 * Owns the living map: which ranges the model has seen, and the symbols,
 * docs, and connections those ranges exposed. The map is an index, not a
 * payload store: no file bodies render from here (inspect serves bytes on
 * demand). The state ledger only records facts; this store answers "what
 * does the model already know about?".
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { extractSymbols } from "../map/deterministic.js";
import type { Ref } from "./state.js";
import { type SymbolEntry } from "./symbols.js";

/** Content fingerprint for fact keys (no store behind it). */
export function contentHash(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

export interface SymbolMapConfig {
  /** Files under this many lines always render full body. */
  fullLines: number;
  /** Seeded files under this many lines always render full body. */
  seededFullLines: number;
  /** Files over this many lines always render metadata-only. */
  outlineLines: number;
  /** Max inventory entries. */
  maxFiles: number;
}

export const DEFAULT_SYMBOL_MAP_CONFIG: SymbolMapConfig = {
  fullLines: 50,
  seededFullLines: 200,
  outlineLines: 500,
  maxFiles: 40,
};

export interface SymbolMapHost {
  repoRoot?: string;
  currentTurn: () => number;
  addReadFact(ref: Ref, turn: number, excerptText?: string): void;
}

export class SymbolMap {
  readonly map = new Map<string, SymbolEntry>();
  constructor(
    private readonly host: SymbolMapHost,
    private config: SymbolMapConfig = DEFAULT_SYMBOL_MAP_CONFIG,
  ) {}

  setConfig(c: Partial<SymbolMapConfig>): void {
    this.config = { ...this.config, ...c };
  }

  /** Put task-relevant files in the working set before the first model call.
   * Seeds the symbol map with each file's outline (symbols + docs) so the
   * first prompt already indexes the suggested files — no bodies, no inspect
   * needed to discover what's in them. */
  seedSeenFiles(paths: readonly string[], turn = 0, maxBytes = 65536): void {
    if (!this.host.repoRoot) return;
    for (const [index, path] of paths.entries()) {
      try {
        const abs = isAbsolute(path) ? path : join(this.host.repoRoot, path);
        const content = readFileSync(abs, "utf8");
        if (Buffer.byteLength(content, "utf8") > maxBytes) continue;
        const total = content.length === 0 ? 1 : content.split("\n").length;
        const ref: Ref = {
          path,
          range: [1, total],
          hash: contentHash(content),
          bytes: Buffer.byteLength(content, "utf8"),
        };
        this.host.addReadFact(ref, turn);
        this.addSeen(ref.path, true, turn, paths.length - index);
        for (const symbol of extractSymbols(path, content).slice(0, 40)) {
          this.addSymbolWithDoc(path, symbol.name, [symbol.line, symbol.end], symbol.doc, turn);
        }
      } catch {
        // A missing or unreadable preload is not a run failure.
      }
    }
  }

  /**
   * Record a seen file. Presence, symbols, and turn are the whole record —
   * byte ranges are not tracked; inspect serves bytes on demand.
   */
  addSeen(
    path: string,
    seeded: boolean,
    turn: number,
    priority = 0,
  ): void {
    if (!path) return;
    const existing = this.map.get(path);
    if (existing) {
      existing.seeded = existing.seeded && seeded;
      existing.priority = Math.max(existing.priority, priority);
      existing.turn = Math.max(existing.turn, turn);
    } else {
      this.map.set(path, {
        path,
        symbols: [],
        seeded,
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
      symbols: [],
      seeded: false,
      priority: 0,
      turn,
    };
    this.map.set(path, existing);
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

  /** Get a tunable value from instance config or the static default. */
  private cfg<K extends keyof SymbolMapConfig>(key: K): SymbolMapConfig[K] {
    return this.config[key] ?? DEFAULT_SYMBOL_MAP_CONFIG[key];
  }

  /**
   * Durable index as one line per file. Every entry renders, most recent
   * first; the map is capped at maxFiles entries (LRU). The cap is a hard
   * fail — if exceeded the run aborts so the operator tunes the constants.
   */
  /** Evict the least-recently-seen file when the map is full. No
   * turn-based eviction otherwise: entries stay for the whole run. */
  private evictLru(): void {
    while (this.map.size >= this.cfg("maxFiles")) {
      let oldest: { path: string; turn: number } | null = null;
      for (const entry of this.map.values()) {
        if (!oldest || entry.turn < oldest.turn) oldest = { path: entry.path, turn: entry.turn };
      }
      if (oldest) this.map.delete(oldest.path);
    }
  }

  renderSymbols(maxChars = 48_000, maxFiles = 40): string {
    if (this.map.size === 0 || !this.host.repoRoot) return "";
    this.evictLru();
    // Most-recently-touched first: the working set sits at the top where
    // attention actually lands; older files follow alphabetically.
    const sorted = [...this.map.values()].sort(
      (a, b) => b.turn - a.turn || b.priority - a.priority || a.path.localeCompare(b.path),
    );
    const shown = sorted.slice(0, Math.max(1, maxFiles));
    const lines: string[] = [
      "<symbols>",
      "The run's symbol map: every file it has seen, with symbols and docs.",
      "No file bodies are included — inspect a path, symbol, or range for bytes.",
      "",
    ];
    let lastDir = "";
    let inventoryUsed = 0;

    // Inventory: one line per file. Symbols and docs only — the model's
    // symbol map, most-recently-touched first.
    for (const entry of shown) {
      const dir = entry.path.includes("/") ? `${entry.path.split("/").slice(0, -1).join("/")}/` : "./";
      if (dir !== lastDir) {
        lines.push(`[${dir}]`);
        lastDir = dir;
      }
      const flagText = entry.seeded ? " [seeded]" : "";
      const meta = [
        entry.doc ? `doc: ${entry.doc.slice(0, 120)}` : "",
        entry.symbols.length > 0 ? `symbols: ${entry.symbols.slice(0, 6).map((s) => `${s.name}(${s.range[0]})${s.doc ? ` "${s.doc.slice(0, 60)}"` : ""}`).join(", ")}${entry.symbols.length > 6 ? ", …" : ""}` : "",
      ].filter(Boolean).join(" · ");
      lines.push(`${entry.path.split("/").pop()}${flagText}${meta ? ` — ${meta}` : ""}`);
      inventoryUsed += lines[lines.length - 1]!.length + 1;
    }
    if (sorted.length > shown.length) {
      const names = sorted.slice(shown.length).map((h) => h.path).join(", ");
      lines.push(`+${sorted.length - shown.length} more: ${names}`);
    }
    if (inventoryUsed > maxChars) {
      throw new Error(`symbol map alone exceeds ${maxChars.toLocaleString()} chars (${inventoryUsed.toLocaleString()}); raise maxFiles or reduce file path lengths`);
    }

    lines.push("</symbols>");
    return lines.join("\n");
  }

  /** Pre-fill the map from hints: paths register as seen, so the first
   * render lists them in the inventory without an inspect call. */
  seedHintRanges(entries: ReadonlyArray<{ path: string; range: [number, number] }>, turn = 0): void {
    const seeded = entries.slice(0, 24);
    for (const [index, entry] of seeded.entries()) {
      if (!entry.path) continue;
      this.addSeen(entry.path, false, turn, seeded.length - index);
    }
  }

}
