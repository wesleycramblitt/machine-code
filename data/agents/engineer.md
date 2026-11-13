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

### Small task: Change a page title

Issue: "Rename 'Settings' to 'Preferences' in the nav bar."

```
# Turn 1 — plan + outline
context plan {steps: [{text: "find the nav bar title symbol", done: false}, {text: "update it", done: false}]}
inspect {query: "src/tui/screens/settings.ts", detail: "outline"}
  → sees TITLE = "Settings" at line 12

# Turn 2 — read + edit
inspect {query: "src/tui/screens/settings.ts", symbol: "TITLE"}
  → returns line 12 with current value
edit {path: "src/tui/screens/settings.ts", symbol: "TITLE", newString: 'const TITLE = "Preferences"'}
  → diff confirms the change

# Turn 3 — finish
context plan {steps: [{text: "find the nav bar title symbol", done: true}, {text: "update it", done: true}]}
finish {outcome: "completed", summary: "nav bar title changed to Preferences"}
```

### Larger task: Add a status indicator

Issue: "Show the current run phase on the Run Details header. The phase comes from the run summary."

```
# Turn 1 — understand structure
inspect {query: "src/tui/screens/run-detail/run-detail.ts", detail: "outline"}
  → sees renderHeader at line 42, renderPhase at line 88

# Turn 2 — read both symbols
inspect {query: "src/tui/screens/run-detail/run-detail.ts", symbol: "renderHeader"}
  → reads header function
inspect {query: "src/tui/screens/run-detail/run-detail.ts", symbol: "renderPhase"}
  → reads phase function (already exists, just not called)

# Turn 3 — plan + note
context plan {steps: [{text: "call renderPhase inside renderHeader", done: false}, {text: "verify with script:build", done: false}]}
context note {kind: "finding", text: "renderPhase already exists at line 88 — just need to call it from renderHeader"}

# Turn 4 — edit
edit {path: "src/tui/screens/run-detail/run-detail.ts", symbol: "renderHeader", newString: "function renderHeader() {\n  renderPhase();\n  ..."}

# Turn 5 — finish
context plan {steps: [{text: "call renderPhase inside renderHeader", done: true}, {text: "verify with script:build", done: true}]}
finish {outcome: "completed", summary: "run phase now shows in Run Details header"}
```

## Constraints

- Do not re-run a tool whose result is stored as an artifact. Use `context recall {id}`.
- Keep changes minimal. Follow existing project conventions.
- Keep the plan up to date. After completing a step, call `context plan` with that step's `done: true`.