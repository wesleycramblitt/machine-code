priority: medium
review: none
verification: direct
tags: tui, new-runs, composer, issues
acceptance: script:build
todo:
  - [ ] Decide and implement the Issues-tab default selection
  - [ ] Remove the duplicated research filter line
  - [ ] Finish

# Composer Issues tab: make the default selection meaningful

On the composer's Issues sub-tab the cursor always lands on the first
(top-level) issue row, and it is unclear what selecting it accomplishes.
Either the default selection should point at something meaningful (the
linked issue, or nothing) or the top row's role needs to be obvious.

## Evidence

- The Issues section is built from the attached issue (if any) plus
  every issue filtered by agent kind (`composer.ts:119-149`); the
  attached issue is first because `itemsFor` emits attached sources
  first.
- Tab switches reset the cursor to item 0
  (`src/tui/screens/composer/keys.ts:113-124` set
  `s.newRunContextItem = 0` on `h`/`l`), and the render only clamps it
  (`composer.ts:493`). So on the Issues tab the cursor sits on the
  first row — the linked issue when one is attached, otherwise the
  first issue in `listIssues` order (alphabetical by slug,
  `src/plan/issues.ts` `listIssues`).
- The footer already shows the linked-issue outcome
  (`composer.ts:512-514`, `issueOutcome` at `:82-88`), and `i` opens
  the issue picker (`keys.ts:173`), so the row-level "select" affordance
  on the top issue is redundant with `i` when an issue is attached.
- There is also a duplicated filter condition: the research branch
  appears twice (`composer.ts:126-128`); the second line is dead code
  and should be removed.

## What to do

1. Pick the sensible default and implement it:
   - When an issue is attached (`run.item`), the cursor should land on
     that issue's row (it already does, being first — make that
     explicit and key-anchored so it survives the stable-selection
     change) **or** the Issues tab should not be a cursor target at
     all when the linked issue is the only meaningful row.
   - When no issue is attached, landing on the first alphabetical
     issue is arbitrary; prefer leaving the selection unset (no row
     highlighted) until the user moves, or landing on the first row
     with the footer explaining `i` links an issue.
2. Make the top row's purpose unambiguous: when it is the linked issue,
   mark it as such in the row text (the `issue:` key already exists;
   the row text could carry `· linked`), so "always selected at top"
   reads as "the run's issue", not "the first issue alphabetically".
3. Delete the duplicated research filter line at `composer.ts:128`.

Coordinate with the stable-selection issue (key-anchored cursor) so
the default-selection logic is expressed in keys, not indices.

## Definition of done

- The Issues tab's initial cursor position is explainable (linked
  issue, or deliberately unset).
- The linked issue is visibly distinguishable from other rows.
- The duplicated filter line is gone.
- `script:build` passes.
