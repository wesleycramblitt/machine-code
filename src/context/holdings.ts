/**
 * machine_code — held file ranges.
 *
 * A holding is the model's durable knowledge of one file: which ranges it has
 * seen, the symbols and connections those ranges exposed, and the artifacts
 * that can recall older bytes. Bytes are always re-read from disk.
 */

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
  /** Higher renders its bytes first when the cap is tight. */
  priority: number;
  turn: number;
}

export function rangesOverlap(a: readonly [number, number], b: readonly [number, number]): boolean {
  return a[0] <= b[1] && b[0] <= a[1];
}

/** Merge overlapping or adjacent line ranges for compact coverage. */
export function mergeRanges(ranges: ReadonlyArray<readonly [number, number]>): Array<[number, number]> {
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

