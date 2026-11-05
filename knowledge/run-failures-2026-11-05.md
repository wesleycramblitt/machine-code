# Four-run failure review — 2026-11-05

Scope: `.machine_code/local/runs/` runs `20261105-041337-ig70`,
`20261105-041811-ew9u`, `20261105-042213-l34u`, and `20261105-042530-dzg5`.

## What happened

| Run | Role / model | Symptom | Root cause |
|---|---|---|---|
| `ig70` | planner / free | `awaiting_input` after an ask | The harness injected "make the first edit" into a read-only planner. The planner then asked a good question, but the TUI did not advertise how to answer it. |
| `ew9u` | sudo / beam-free | `completed` with "I used malformed XML. Need correct." | The request did not ask for strict JSON-schema constrained sampling even though Beam Free advertises `supportsStrictMode`. Without it, the model serialized tool fields as attribute text. Validation failed, it repeated, and the run completed on a non-answer. |
| `l34u` | sudo / gemma4:12b | `completed` with no final text | `sudo` was subject to the Build plan gate. After 12 research calls, reads and searches were blocked. The model wrote an evidence gap and stopped empty. |
| `dzg5` | sudo / deepseek | `blocked` after reproducing the bug | Same sudo/build gate. After the plan, `context recall` and off-plan reads were blocked, so diagnosis could not finish. |

## Decisions

1. The Build plan gate is role-specific. Only `build` requires a change plan.
   `sudo` is an escape hatch and may investigate without a forced edit.
2. A decision must name at least two files and two change verbs to count as a
   plan. A sentence that merely contains the word "plan" is not a plan.
3. Research is bounded, not permanently locked. Build gets 12 calls before the
   plan checkpoint and 8 more after the plan. Memory operations
   (`context note/focus/recall/state`) are not research.
4. An empty final response is `blocked`. Repeated rejected tool calls with no
   substantive success are `blocked`.
5. Core tools request provider-side strict JSON-schema sampling when the model
   supports it. Beam Free does; OpenCode used it and machine_code did not.
6. One-value attribute serialization is repaired before validation. If it
   cannot be repaired, it is a malformed model response and the model rotates.
7. The TUI shows an `a answer` hint in run detail and accepts `a` on the run
   list. Ask options are selectable with `1`–`9`.

## Verification

- `test/loop-policy.test.js` covers the role gate, plan detection, and read
  bucket.
- `test/tool-args.test.js` covers serialized argument repair.
- `test/tools.test.js` covers nested-symbol reads and unknown search modes.
