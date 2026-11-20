commit: 5a77d92a2972e083748f6a0c8407fa735c1263cb
depends: tui-alt-keys-swallowed-by-shortcuts
files: src/tui/screens/composer/keys.ts
tags: tui
acceptance: script:build
keywords: new-run composer, prompt, Enter, cursor

# New-run Enter inserts newline at cursor

New-run insert mode appends `\n` at end of prompt (`src/tui/screens/composer/keys.ts:87-89`). Issue composer inserts at cursor via `editLine` (`src/tui/screens/issue-composer/keys.ts:76`). Typing in middle of long prompt then pressing Enter moves text to wrong place.

Change Enter in new-run insert mode to insert `\n` at `newRunCursor` through `editLine`, then clamp cursor. Keep 12_000 cap. Keep Esc to leave insert mode. No new keys.

Verify: type `abc`, move left, press Enter, newline splits at cursor.
