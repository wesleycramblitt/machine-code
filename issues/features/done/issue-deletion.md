tags: issues
acceptance: script:build
todo:
  - [x] Locate the runs-page delete flow and confirmation
  - [x] Add DeleteTarget (run | issue) + issue confirmation render in src/tui/screens/delete.ts
  - [x] Route D on issue rows (runs list) and d on the issue page into the confirm screen
  - [x] Confirm/delete handling in delete-keys.ts; update state.ts + tui.ts call sites
  - [x] Typecheck via build gate

From the runs page, issue deletion should be gated just like run deletion. There should be a page that pops up with information and final confirmation so you have to hit D twice.
