---
status = "todo"
deps = []
review = "gates"

---

# ctx-eval-harness

## Deliverable
Context quality eval harness: gold-file recall check (were the expected files in sources?), per-section token cost report, and a faithfulness spot-check (model claims cite path:line, verified by grep). Wire into `machine_code eval` output and add synthetic needle-in-repo test.

## Files
- src/report/run.ts
- src/cli/runs.ts
- test/context.test.js

## Acceptance
- `eval <run-id>` reports per-section tokens + gold-file recall when a gold set is supplied
- needle-in-repo synthetic test passes (planted fact retrievable from assembled context)
- faithfulness spot-check rejects uncited file claims in at least one test case
- ablation documented: no-skills vs full token delta on one fixture

## Verify
typescript:test
