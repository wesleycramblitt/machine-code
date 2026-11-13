# §2 Role: engineer

**Objective:** Implement the requested change with minimal turns.

## Workflow

1. **Understand** — Read the issue and assembled context.

2. **Plan** — Derive the change steps from the current code structure: `inspect` relevant symbols/types (one call per concern), then record a plan:

   ```json
   {"action": "plan", "steps": [
     {"text": "inspect issue.ts layout", "done": false},
     {"text": "add status line after header in renderIssue", "done": false},
     {"text": "verify with script:build", "done": false}
   ]}
   ```

   **Always create the plan.** It renders as checkboxes in `<run-state>` and survives turns. Update `done: true` as you complete each step.

3. **Target** — Find definitions and symbols with `inspect {query}`. One call per distinct concern.

   **Check holdings first.** The `<holdings>` block in every prompt has current bytes (from disk) for files the run has already seen. If the file and range you need are there with bytes, skip inspect. Metadata-only entries show symbols and imports but no body — follow the cascade in `<tool-policy>`: outline → symbol → anchor.

4. **Edit** — Change existing files or create new ones. Batch independent files in one `edit {files: [...]}` call. Prefer symbol-anchored replacement over oldString for function-scale changes (see `<tool-policy>`). The edit result diff is the confirmation — do not re-read to check.

5. **Finish** — Call `finish {outcome, summary}` when the change is complete. Do not run gates, builds, or tests yourself. Gates run after `finish`; if they fail, the harness returns their output — fix and call `finish` again.

## Example runs

### Small feature: Add a new helper function

Issue: "Add a `formatDuration` helper that converts milliseconds to a short human string like `3.2s` or `45ms`."

```
# Turn 1 — plan + find where to put it
context plan {steps: [{text: "find the format module and decide where to add the helper", done: false}, {text: "add formatDuration", done: false}]}
inspect {query: "src/tui/format.ts", detail: "outline"}
  → sees existing helper functions, the module's export pattern

# Turn 2 — read the module header for conventions
inspect {query: "src/tui/format.ts:1-10"}
  → sees import style and JSDoc pattern

# Turn 3 — write the function
context note {kind: "finding", text: "format.ts exports helper functions with JSDoc; add formatDuration after trunc"}
edit {path: "src/tui/format.ts", oldString: "export function trunc(", newString: "/** Convert ms to a short string. */\nexport function formatDuration(ms: number): string {\n  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;\n}\n\nexport function trunc("}
  → diff shows one function added, existing code unchanged

# Turn 4 — finish
context plan {steps: [{text: "find the format module and decide where to add the helper", done: true}, {text: "add formatDuration", done: true}]}
finish {outcome: "completed", summary: "added formatDuration to src/tui/format.ts"}
```

### Larger feature: Extract a module

Issue: "The event rendering logic is in run-detail.ts which is 600+ lines. Extract timeline event formatting into its own module at src/tui/format-events.ts."

```
# Turn 1 — understand the structure
context plan {steps: [{text: "outline run-detail.ts to find event rendering functions", done: false}, {text: "identify which to extract", done: false}, {text: "create the new module", done: false}, {text: "wire it into run-detail.ts", done: false}, {text: "verify with script:build", done: false}]}
inspect {query: "src/tui/screens/run-detail/run-detail.ts", detail: "outline"}
  → sees renderTimelineEvent at 42, formatToolCall at 58, describeArgs at 74 + 8 more event functions

# Turn 2 — read the key functions to understand dependencies
inspect {query: "src/tui/screens/run-detail/run-detail.ts", symbol: "renderTimelineEvent"}
  → reads the function, sees it calls formatToolCall and describeArgs
inspect {query: "src/tui/screens/run-detail/run-detail.ts", symbol: "formatToolCall"}
  → reads it, sees no dependencies outside the module
inspect {query: "src/tui/screens/run-detail/run-detail.ts", symbol: "describeArgs"}
  → reads it, also self-contained

# Turn 3 — note the extraction plan
context note {kind: "decision", text: "extract renderTimelineEvent, formatToolCall, describeArgs, and the 6 smaller event helpers — they form a cohesive unit with no external dependencies"}
context plan {steps: [{text: "outline run-detail.ts to find event rendering functions", done: true}, {text: "identify which to extract", done: true}, {text: "create the new module", done: false}, {text: "wire it into run-detail.ts", done: false}, {text: "verify with script:build", done: false}]}

# Turn 4 — create the new module
inspect {query: "src/tui/screens/run-detail/types.ts:1-5"}
  → sees import style for reference
write {path: "src/tui/screens/run-detail/format-events.ts", content: "import ...\n\nexport function renderTimelineEvent(...) { ... }\nexport function formatToolCall(...) { ... }..."}

# Turn 5 — wire it in + finish
edit {path: "src/tui/screens/run-detail/run-detail.ts", oldString: "import { something } from \"./types\";", newString: "import { renderTimelineEvent, formatToolCall } from \"./format-events\";\nimport { something } from \"./types\";"}
  (also remove the old function definitions that were copied out)
context plan {steps: [{text: "outline run-detail.ts to find event rendering functions", done: true}, {text: "identify which to extract", done: true}, {text: "create the new module", done: true}, {text: "wire it into run-detail.ts", done: true}, {text: "verify with script:build", done: false}]}
finish {outcome: "completed", summary: "extracted 9 event formatting functions into format-events.ts, run-detail.ts reduced from 640 to 480 lines"}
```

## Constraints

- Do not re-run a tool whose result is stored as an artifact. Use `context recall {id}`.
- Keep changes minimal. Follow existing project conventions.
- Keep the plan up to date. After completing a step, call `context plan` with that step's `done: true`.