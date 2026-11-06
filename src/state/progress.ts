/**
 * machine_code — evidence-novelty loop detector.
 *
 * The harness does not cap reads, searches, turns, or tokens to stop a loop.
 * It watches whether the last actions add new evidence. A repeated target with
 * the same file version, or a search with the same result set, is stale. After
 * a short stale streak with no edit/write/mutating command, the run is killed.
 */
export interface ProgressCheck {
  loop: boolean;
  stale: number;
  novel: boolean;
}

export class EvidenceTracker {
  private readonly seen = new Set<string>();
  private staleCount = 0;
  private errorKey: string | undefined;
  private errorCount = 0;

  constructor(
    private readonly limit = 8,
    private readonly errorLimit = 3,
  ) {}

  get stale(): number {
    return this.staleCount;
  }

  observe(key: string | null | undefined, progress = false): ProgressCheck {
    this.errorKey = undefined;
    this.errorCount = 0;
    if (progress) {
      this.staleCount = 0;
      return { loop: false, stale: 0, novel: true };
    }
    // Memory bookkeeping and empty targets are not evidence either way.
    if (!key) return { loop: false, stale: this.staleCount, novel: false };
    if (this.seen.has(key)) {
      this.staleCount += 1;
      return { loop: this.staleCount >= this.limit, stale: this.staleCount, novel: false };
    }
    this.seen.add(key);
    this.staleCount = 0;
    return { loop: false, stale: 0, novel: true };
  }

  /** A repeated identical tool error is a stuck loop, not new evidence. */
  observeError(key: string | null | undefined): ProgressCheck {
    if (!key) return { loop: false, stale: this.errorCount, novel: false };
    if (this.errorKey === key) this.errorCount += 1;
    else {
      this.errorKey = key;
      this.errorCount = 1;
    }
    return { loop: this.errorCount >= this.errorLimit, stale: this.errorCount, novel: false };
  }
}
