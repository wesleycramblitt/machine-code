priority: high
review: none
verification: direct
tags: tui, new-runs, composer, keys
acceptance: script:build
todo:
  - [ ] Make the context-panel footer command row per-section
  - [ ] Suppress space on rows where it does nothing
  - [ ] Finish

# Composer context tabs: show only the commands that work on that tab

The new-run composer's context panel advertises `space ✓/✕` on every
sub-tab, but space only does something on some of them. The footer
should list the commands that actually apply to the active section, and
rows that cannot be toggled should not be selectable targets for space
(or should visibly show why).

## Evidence

- The footer is built once for all sections
  (`src/tui/screens/composer/composer.ts:541-555`): it always renders
  `h/l tabs`, `j/k sel`, `/ filter`, and `space ✓/✕` (or the skills
  `include→on-demand→exclude` variant for the skills tab).
- The space handler (`src/tui/screens/composer/keys.ts:129-158`) only
  acts on:
  - `skill:` keys — cycles include → on-demand → exclude;
  - `file:`, `reference:`, `issue:` keys that are `available` —
    toggles include;
  - any other non-`core-tool:`, non-`prompt:` key — toggles exclude.
- Therefore space does **nothing** on:
  - **Tools tab** `core-tool:*` rows (explicitly skipped,
    `keys.ts:149`); these are fixed definitions, rendered with a ✓
    mark but no effect;
  - **Agent Prompt** `prompt:*` rows (skipped, `keys.ts:149`); fixed,
    view-only;
  - **Codebase** `map:index` / `semantic:index` rows — the key has no
    recognized prefix, so space falls into the exclude branch and adds
    them to `newRunContextExcluded`, which the preview does not honor
    as a per-item toggle the way the other rows work (verify);
  - **Scripts** `script:*` rows — same unrecognized-prefix path as
    codebase; confirm whether excluding a script row has any effect on
    the assembled context.

## What to do

1. **Per-section command row.** In `renderComposer`, derive the footer
   from `activeSection.sectionKey` (the value already exported as
   `frame.contextSectionKey`):
   - Skills: `space include→on-demand→exclude` (current behavior).
   - Issues / Files / References: `space ✓/✕` (include toggle works).
   - Tools / Agent Prompt / Codebase / Scripts: drop the `space`
     command entirely; keep `h/l`, `j/k`, `/` (and `i` on Issues).
   Consider `x` (section off, `keys.ts:159-166`) only where it is
   meaningful — it currently targets `s.newRunContextSectionKey` for
   whichever tab is active; confirm each section key is honored by the
   preview before advertising it.
2. **Non-actionable rows.** For rows space cannot touch (fixed tools,
   prompt lines), either make them non-selectable cursor stops or keep
   them selectable but render their mark so it reads as fixed (the ✓
   on prompt lines is covered by the separate prompt-checkmark issue).
   The important property: the advertised command and the cursor's
   behavior never disagree.
3. **Verify the codebase/script exclude path.** If `map:index`,
   `semantic:index`, and `script:*` exclusion is silently ignored by
   the context preview, either wire it up or remove the row's
   sensitivity to space; if it works, document it in the footer.

## Definition of done

- Every context sub-tab's footer lists exactly the keys that do
  something on that tab.
- Space on a Tools or Agent Prompt row is either a no-op with no
  advertised command, or the row is not a cursor stop.
- `script:build` passes.
