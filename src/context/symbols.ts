/**
 * machine_code — the run's symbol map.
 *
 * An index of files the run has seen: their symbols and docs. No bodies,
 * no line ranges — inspect serves bytes on demand. The model navigates by
 * this map and reads by tool call.
 */

export interface SymbolRef {
  name: string;
  range: [number, number];
  /** Doc comment or docstring from the repo map. */
  doc?: string;
}

export interface SeenFile {
  path: string;
  /** Symbols held, by name — the map fills in at symbol granularity. */
  symbols: SymbolRef[];
  /** File-level doc comment or module docstring, from the repo map. */
  doc?: string;
  /** Fully present in the stable prefix: bytes skipped until it changes. */
  seeded: boolean;
  /** Higher renders first; recency decides the working set order. */
  priority: number;
  turn: number;
}

export function rangesOverlap(a: readonly [number, number], b: readonly [number, number]): boolean {
  return a[0] <= b[1] && b[0] <= a[1];
}

