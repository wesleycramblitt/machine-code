tags: new-runs
todo:
  - [x] Read and scope the idea
  - [x] Write features/bugs or curate references
  - [x] Finish

On each sub-tab of the new runs page, we should ensure that the selected context, key commands, and features make sense. For example, the command "space " is on several
sub tabs where you can't actually enable/disable the files, remove it from those. On the issues tab, we seem to always select the top level issue/? I don't understand the point of that.
On the Agent prompt, each line has a checkmark, remove that, it is just for viewing the prompt.   On files, references, skills, when you enable/disable or select a mode, the items shift around confusingly. Need a feature where that doesn't happen.

Researched: all four complaints trace to the new-run composer's context panel (`src/tui/screens/composer/`). Split into four feature issues under `issues/features/todo/`:

- `composer-context-commands-per-tab` — footer advertises `space ✓/✕` on every tab (composer.ts:541-555) but the space handler (keys.ts:129-158) only acts on skill:/file:/reference:/issue: keys; Tools (core-tool:*), Agent Prompt (prompt:*), Codebase (map:/semantic:), and Scripts rows are no-ops or silently excluded. Make the command row per-section.
- `composer-context-stable-selection` — rows re-sort on toggle (attached-first partition composer.ts:495-496; skills mode-rank sort composer.ts:306-312) while the cursor is a raw index (tui.ts:956, clamped at composer.ts:493). Anchor selection by item key and keep a fixed row order.
- `composer-prompt-view-only` — Agent Prompt rows carry `fixed:true` + `exists:true` (composer.ts:393-404) so line 529 renders a green ✓ on every line even though space refuses to act on them (keys.ts:149). Render fixed rows with a neutral mark.
- `composer-issues-tab-selection` — cursor lands on item 0 on every tab switch (keys.ts:113-124), which on Issues is the linked issue or an arbitrary first slug; make the default meaningful and key-anchored, mark the linked row, and drop the duplicated research filter at composer.ts:128.
