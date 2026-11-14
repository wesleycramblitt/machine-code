/**
 * machine_code — issue file footprints.
 *
 * Issues can declare the repo-relative files or globs they expect to touch
 * (`files: src/loop.ts, src/tools/*.ts`). Two issues with overlapping
 * footprints are a merge conflict waiting to happen, so the runner uses this
 * to sequence them (research-time `depends:` enforcement) and to refuse to run
 * them at the same time.
 */

export function normalizeFootprint(value: string): string {
  return value
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/\/{2,}/g, "/");
}

/** Turn a glob into an anchored regexp. `**` crosses directories, `*` does not. */
function globToRegExp(glob: string): RegExp {
  let out = "";
  for (let i = 0; i < glob.length; i += 1) {
    const char = glob[i]!;
    if (char === "*" && glob[i + 1] === "*") {
      if (glob[i + 2] === "/") {
        // `src/**/x` matches `src/x` and `src/a/b/x`.
        out += "(?:.*/)?";
        i += 2;
      } else {
        out += ".*";
        i += 1;
      }
    } else if (char === "*") {
      out += "[^/]*";
    } else if (char === "?") {
      out += "[^/]";
    } else {
      out += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${out}$`);
}

/**
 * Whether a footprint pattern covers a concrete path (or another footprint).
 * A directory pattern (`src/tui/` or `src/tui`) covers everything under it;
 * globs match with `*`/`**`; anything else is an exact path.
 */
export function footprintMatches(pattern: string, path: string): boolean {
  const p = normalizeFootprint(pattern);
  const target = normalizeFootprint(path);
  if (!p || !target) return false;
  if (p === target) return true;
  // Directory footprint (explicit trailing slash or a plain directory path).
  if (p.endsWith("/")) {
    const dir = p.slice(0, -1);
    return target === dir || target.startsWith(`${dir}/`);
  }
  if (p.includes("*") || p.includes("?")) {
    return globToRegExp(p).test(target);
  }
  return target.startsWith(`${p}/`);
}

/** Human-readable overlap pairs between two footprints (empty = disjoint). */
export function overlapFootprints(a: readonly string[], b: readonly string[]): string[] {
  const overlaps: string[] = [];
  for (const left of a) {
    for (const right of b) {
      if (footprintMatches(left, right) || footprintMatches(right, left)) {
        overlaps.push(left === right ? left : `${left} ~ ${right}`);
      }
    }
  }
  return [...new Set(overlaps)];
}
