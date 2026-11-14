priority: high
tags: tui, orchestration
depends: orchestrator-settings-store-and-scheduler
files: src/tui/state.ts, src/tui/screens/orchestrate.ts, src/tui/screens/orchestrate-keys.ts, src/tui/screens/chrome.ts, src/tui/screens/keys.ts, src/tui/screens/runs-list-keys.ts, src/tui.ts
keywords: Orchestration, Back[Esc], Start[:!], Stop[:!], orchestrate screen, model preview
acceptance: script:build

# Orchestration page in the runs TUI

A new detail screen `orchestrate` on the runs page, opened per repo. The live scheduling loop is a separate issue (`orchestrator-keeps-runs-moving`); this one is the page: entry, chrome, settings, preview, Start/Stop.

Entry: in the runs list, `o` opens the orchestration page for the selected repo (`o` is unused in `src/tui/screens/runs-list-keys.ts:17-172`; follow the existing pattern of rebuilding the index and reading `index.selectable[s.runsSel]`). It is available only when the selected row IS a repo row (`row.kind === "repo"`): the orchestrator is triggered from the repo level, whatever repo row is selected. On any other row (or nothing selected) notify "select a repo to orchestrate" and stay on the list. Store the repo root in TuiState (new field next to `selectedIssueRepo`, `src/tui/state.ts`) and switch `s.screen = "orchestrate"`.

Screen (new `src/tui/screens/orchestrate.ts` render + `orchestrate-keys.ts` handler, wired into the key dispatch; add `"orchestrate"` to the `Screen` union at `src/tui/state.ts:26-28`):

- Header: `Back[Esc]` with the red background plus a bold `Orchestration` title — extend `backHeader`/`backTitle` in `src/tui/screens/chrome.ts:54-71` with `screen === "orchestrate"`; second header row shows the repo path right-aligned like the newrun screen does (`chrome.ts:78-82`).
- Status line: `Inactive` when the store's `active` flag is false, `Running` when true (store read from the repo's `.machine_code/local/orchestrator.json`, issue `orchestrator-settings-store-and-scheduler`).
- Settings, each editable with left/right cycling and persisted through the store so edits survive restarts and pick up on the next run the orchestrator starts:
  - `processes`: 1 → 2 → 4 → 8
  - `tier`: local ↔ cloud as display labels (store the run values `"paid" | "local"`, `src/tui.ts:490`)
  - `engineer minFit` and `research minFit`: each cycles the 4–8.5 ladder in 0.25 steps — reuse `NEW_RUN_MIN_FITS` (`src/tui.ts:116-119`). The role split matters because `agentForIssue` dispatches ideas to research and everything else to engineer (`src/plan/lifecycle.ts:14-17`).
  - `model preview` (read-only): for each role, the model name the current tier+minFit resolves to, resolved the same way the composer preview resolves its model — `resolveSelectionContext` with `{ role, tier, floors: { minFit } }` then `pickWithContext` (`src/select.ts:391-448`), applying the effective-def pattern from `src/tui.ts:501-515`. Show one resolved model name per role; dim placeholder text when pick returns an error.
- Counters line: `Running: N  Awaiting: N  Failed: N` from `orchestratorCounters` over the repo's orchestrator-started runs.
- Footer: when inactive, a red `Start[:!]` command badge; when running, `Stop[:!]` — same chord and construction as the composer's Start token (`commandBadge("Start", ":!", START_BG, WHITE)`, `src/tui/screens/composer/composer.ts:676-679`; `START_BG`/`WHITE` from `src/tui/format.ts:50,68`).

Start/Stop: add `startOrchestrator(repoRoot)` / `stopOrchestrator(repoRoot)` to `KeyServices` (`src/tui/screens/keys.ts:15-51`) and implement them in the services factory in `src/tui.ts` (~`:1600-1611`): Start persists current page settings and sets the store's `active` flag; Stop clears it. Until the loop issue lands, starting shows status Running with counters at zero and spawns nothing. Esc returns to the runs list like every other detail screen.
