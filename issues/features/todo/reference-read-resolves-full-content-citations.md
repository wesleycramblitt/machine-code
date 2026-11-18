priority: high
tags: references
files: src/references/store.ts
keywords: reference:read, reference store, minecraft-java, unversioned, citation, findReferences, readReference
acceptance: script:build

# Resolve full reference content citations (minecraft-java read path)

Reading a bundled reference by a *full content citation* still fails. A citation
such as `minecraft-java/unversioned/content/blocks.txt#8-3-common-functions` (or
any flat `/unversioned/content/...` path) returns `reference not found` instead
of the section text. The bare key `minecraft-java` already works (it resolves to
the single version's `index.md`), and `reference:find` already locates flat
bundles by scanning `minecraft-java/api-index.md` / `minecraft-java/index.md`,
but feeding that found citation line back into `reference:read` fails.

**What changes.** `reference:read <product>/<version>/content/<file>#<anchor>`
and `reference:read <product>/unversioned/content/<file>#<anchor>` return the
requested section text just as the bare-key read already does. A citation with
no `unversioned` segment resolves against `<product>/<version>` exactly as
written. A citation with three or more path segments that is not `raw/` and does
not exist verbatim is no longer silently reported as not found — it is resolved
against the store layout (product dir, then the single version dir, then the
content path) or reported with a path that names the missing file.

**Why.** The minecraft-java bundle is a recurring development blocker: many
runs in the window are about reference read failures there. `findReferences`
returns citation lines (e.g. `minecraft-java/unversioned/content/blocks.md: ...`)
but `readReference` cannot resolve them, so the reasoning loop cannot pull the
section it just found.

## Current behavior

`resolveReferencePath` (`src/references/store.ts:63-125`) handles:
- a bare key `minecraft-java` -> `minecraft-java/<single-version>/index.md`
  (single-version fallback at lines 94-107), and
- a two-part `<product>/<version>` key.

It does **not** handle a full content citation: a path with more than two parts
falls through to `resolve(storeRoot, rel)` and `existsSync` at line 110, then
`readReference` (line 185) returns `reference not found: <rel>`. The
`unversioned/` canonical segment is never interpreted, so the existing flat
bundles found by `findReferences` (lines 232-237) cannot be read through the
find/read roundtrip.

## Suggested change

In `resolveReferencePath`, after the two-part-key handling:
1. Split the path to detect the product dir and the version segment.
2. When the citation names `<product>/<version>/content/...`, verify the file
   exists (`<store>/<product>/<version>/content/<file>`); if that version dir
   does not exist but the product has exactly one version dir with the file,
   fall back to it — mirroring the single-version fallback already used for bare
   keys.
3. Keep the `raw/` and existence checks unchanged.

## Verification

- `reference:read minecraft-java/unversioned/content/blocks.md#8-3-common-functions`
  (or the equivalent path for the target bundle) returns the section text,
  not an error.
- `reference:find minecraft-java` returns a matching line that can be passed to
  `reference:read` and read successfully.
- Existing `reference:read minecraft-java` still returns the single-version
  index.
