priority: high
review: none
verification: direct
tags: tui, new-runs, composer, selection
acceptance: script:build
todo:
  - [ ] Anchor the context-panel cursor by item key instead of raw index
  - [ ] Stop reordering rows when a mode/include toggle changes state
  - [ ] Finish

# Keep the composer context-panel selection stable across toggles

On the Files, References, and Skills sub-tabs of the new-run composer,
toggling an item (space to include/exclude, or cycling a skill mode)
re-sorts the rows, so the item the user just acted on jumps to a
different position and the cursor lands on something else. The user
called this out as the most confusing part of the page.

## Why it happens

`renderComposer` in `src/tui/screens/composer/composer.ts` builds each
section's rows in attached-first order and then re-partitions them for
display:

- `issueItems` / `fileItems` / `referenceItems` / `scriptItems` start
  from `itemsFor([...])` (the attached sources, `composer.ts:90-98`)
  and append the "available" rows (`composer.ts:124-149`, `:158-170`,
  `:180-192`, `:195-215`).
- `skillItems` are built from role defaults first, then every other
  installed skill is appended (`composer.ts:241-254`), and finally
  sorted by mode rank so `include` rows float to the top
  (`composer.ts:306-312`).
- At render time the panel splits rows into `contextItems`
  (attached/kept) and `availableItems`
  (`composer.ts:495-496`, via `isShownAvailable` at `:428-431`), so an
  "available" row that becomes included moves from the bottom block to
  the top block on the very keystroke that included it.

The cursor itself is a raw index into that shifting list:
`s.newRunContextItem` is written back from `frame.contextItem` every
frame (`src/tui.ts:956`), and the render only clamps it
(`composer.ts:493`). So when the row order changes, the index now
points at a different item.

## What to do

1. **Anchor the cursor by key.** Track the selected item's `key`
   (already unique per row: `file:src/x.ts`, `skill:foo`,
   `reference:...`, `issue:issues/...md`, `core-tool:read`,
   `prompt:0`, `map:index`, ...). On each frame, after computing
   `shownItems`, resolve the cursor to the index of the remembered key
   (fall back to the clamped index when the key is gone — e.g. after a
   `/` filter or an exclusion that hides the row). `ContextPanelItem`
   already carries `key`; the frame already returns
   `contextItemKeys` (`composer.ts:489`), so the state side needs a
   `newRunContextItemKey` alongside the index.
2. **Stop the reordering.** Keep a stable row order per section — the
   order the rows were built in — regardless of include/exclude/mode
   state. The `include`-first sorting for skills (`composer.ts:306-312`)
   and the attached/available display partition (`composer.ts:495-496`)
   are what make rows jump; render marks (✓ / ✕ / · / mode tags)
   already convey state, so the order does not need to. If a
   group-by-state presentation is still wanted, it must be visual only
   (e.g. a subtle separator) with the underlying order fixed.
3. **Keep the scroll position stable** the same way: `itemStart`
   (`composer.ts:515-519`) is derived from the raw index; key-anchoring
   the cursor fixes it as a side effect, but verify that paging with
   `^D/^U` (keys.ts:127-128) still behaves when the list no longer
   re-sorts.

Precedent in-repo: the run-detail timeline deliberately keeps block
heights stable so the cursor does not jump
(`src/tui/screens/run-detail/run-detail.ts:245-246`), and the models
list restores the exact row via `lastOpenedModelKey`
(`src/tui/state.ts:76`). The composer fix is the same shape: key-based
anchoring instead of index-based.

## Definition of done

- Space on a Files/References/Skills row toggles its state and the row
  stays in place; the cursor stays on that row.
- Cycling a skill mode (include → on-demand → exclude) does not move
  any row.
- `/` filter, `h`/`l` tab switch, and `^D/^U` paging still work.
- `script:build` passes.
