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

export interface HoldingHost {
  repoRoot?: string;
  putArtifact(text: string): Artifact;
  addReadFact(ref: Ref, turn: number, excerptText?: string): void;
}

export class HoldingStore {
  readonly map = new Map<string, Holding>();
  constructor(private readonly host: HoldingHost) {}

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

  /**
   * Durable knowledge as inventory + current bytes. Every holding gets one
   * inventory line (names are never dropped); held ranges render their
   * current bytes from disk every turn so the model never has to re-fetch a
   * file because the transcript abbreviated an older result. Seeded files
   * skip bytes until they change because the stable prefix carries them.
   * Past the cap, bytes yield to artifact ids and inspect anchors.
   *
   * Dropping policy: inventory lists every holding (capped at maxFiles with
   * a names-only overflow line — addressability is never lost). Deltas favor
   * recent acquisitions first; files that do not fit keep their old sentSig
   * and retry next turn; a single file larger than the cap sends a truncated
   * head marked with its artifact id and inspect path.
   */
  renderHoldings(maxChars = 24_000, maxFiles = 40): string {
    if (this.map.size === 0 || !this.host.repoRoot) return "";
    const sorted = [...this.map.values()].sort((a, b) => a.path.localeCompare(b.path));
    const shown = sorted.slice(0, Math.max(1, maxFiles));
    const lines: string[] = ["<holdings>", "Living map: files held, with symbols, connections, and current bytes re-read from disk. The transcript may abbreviate older tool results; these bytes are current."];
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
    const ordered = [...shown].sort((a, b) => b.priority - a.priority || b.turn - a.turn || a.path.localeCompare(b.path));
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
      if (holding.ranges.length === 0) continue;
      // Held bytes render every turn: the transcript abbreviates old results,
      // so "already sent once" is not the same as "still visible to the model".
      const toSend = holding.ranges;
      if (toSend.length === 0) continue;
      let raw: string;
      try {
        const abs = isAbsolute(holding.path) ? holding.path : join(this.host.repoRoot, holding.path);
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
    const seeded = entries.slice(0, 24);
    for (const [index, entry] of seeded.entries()) {
      if (!entry.path || entry.range[0] < 1 || entry.range[1] < entry.range[0]) continue;
      this.addHolding(entry.path, entry.range, "", false, turn, seeded.length - index);
    }
  }

}
