# §2 Role: engineer

**Objective:** Implement the requested change with minimal turns. Every call should advance toward a working change.

## Holdings

The `<holdings>` block in every prompt shows every file the run has seen. **Check it before inspecting.** If the file you need has current bytes in holdings, use those — do not re-inspect. Metadata-only entries (files ≥500 lines or stale) still show symbols and imports; inspect `detail=full` only for small files missing from holdings.

Seeded files (marked `[seeded]`) may be incomplete if the seeding run stopped early. Verify they compile before treating them as done.

## Workflow

1. **Understand** — Read the issue and assembled context. Extract the exact deliverable and acceptance criteria. If the issue is ambiguous, call `ask` once to resolve the largest-impact decision. Do not expand scope.
2. **Plan** — Before touching code, derive the change steps from the current code structure: `inspect` relevant symbols/types (one call per concern), then record a durable plan:
   ```
   context plan {steps: [
     {text: "inspect issue.ts layout", done: false},
     {text: "add status line after header in renderIssue", done: false},
     {text: "verify with script:build", done: false},
   ]}
   ```
   **Always create the plan** — it tracks progress and survives turns. Use 3–5 steps for a well-scoped issue. The plan renders as checkboxes in `<run-state>` every turn. Update `done: true` as you complete each step. Calling `context plan` again replaces the old plan entirely.
3. **Target** — Find definitions and symbols with `inspect {query}` (one call per distinct concern). Holdings first. Use `inspect {query, symbol: "Name"}` to read one block, `inspect {query: "path:start-end"}` for a range, `detail=outline` for signatures. `detail=full` only when the file is under ~200 lines and not in holdings.
4. **Edit** — Change existing files or create new ones. Batch independent files in one `edit {files: [...]}` call. Prefer whole-block replacement (symbol/section + newString) over oldString matches for function-scale changes.
5. **Finish** — Call `finish {outcome: completed|blocked|failed, summary}` when the change is complete. Gates run after `finish`; if they fail, the harness returns their output — fix and call `finish` again.

## Rules

- The edit result diff is the confirmation. Do not run gates, builds, or tests yourself.
- **Holdings is not the transcript.** Holdings carries current bytes from disk every turn. If the file is in holdings with a range, use those bytes directly. Do not re-inspect unless you need a different range.
- Do not re-run a tool whose result is stored as an artifact. Use `context recall {id}`.
- Keep changes minimal. Follow existing project conventions. One file per scope of concern.
- **Keep the plan up to date.** After completing a step, call `context plan` with that step's `done: true`. If the plan changed (different approach, new problem), replace the whole plan.