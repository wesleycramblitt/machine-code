priority: medium
review: none
verification: direct
tags: tui, new-runs, composer
acceptance: script:build
todo:
  - [ ] Render Agent Prompt rows without the ✓ mark
  - [ ] Finish

# Agent Prompt tab: drop the per-line checkmark

The Agent Prompt sub-tab of the new-run composer renders every prompt
line with a green ✓ mark, implying each line is an individually
toggleable context item. The tab is view-only: the resolved agent
prompt is always sent and cannot be enabled, disabled, or reordered
from the composer.

## Evidence

- `promptItems` are built with `fixed: true` and `exists: true`
  (`src/tui/screens/composer/composer.ts:393-404`).
- The row renderer picks the mark from `isExcluded` / `available` /
  `exists` (`composer.ts:529`): `fixed` rows are neither excluded nor
  available, and `exists` is true, so every line gets
  `` `${G}✓${R}` ``.
- The space handler explicitly refuses to act on these rows
  (`src/tui/screens/composer/keys.ts:149` skips `prompt:` keys), so the
  ✓ is a lie about interactivity.

## What to do

In `renderComposer`, render Agent Prompt rows (and any other `fixed`
row, such as the core-tool rows on the Tools tab, which have the same
"always sent" semantics but currently also show ✓) with a neutral,
non-interactive mark — e.g. the dim `·` used for available rows, or no
mark at all with the line indented as plain text. Keep the token count
column if it is meaningful for prompt lines; otherwise drop it.

The footer command row for this tab must also not advertise `space`
(see the per-tab commands issue).

## Definition of done

- Agent Prompt rows render without a ✓ (or any mark that reads as
  toggleable).
- Tools tab core-tool rows are consistent with the same treatment.
- `script:build` passes.
