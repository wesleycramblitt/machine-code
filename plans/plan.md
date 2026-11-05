# machine_code — remaining work

> This file lists only work that is not built. Completed phases were removed;
> their design history remains in git and in `knowledge/`.
>
> Current baseline: a live Planner → Build → Review → Task PR → Feature PR run
> passed; the suite has 392 tests (391 passing, 1 skipped). See `knowledge/` for
> architecture and the latest evaluation.
>
> Goal: complete real repository work with runner-owned evidence, low context
> cost, and deterministic scheduling. Measure against a fixed task suite and
> competitor agents on the same model.

## 1. Evaluation and call efficiency

### 1.1 Fixed task suite and replay harness

- Build the fixed 12-task evaluation suite and a replay command.
- Record turns, model calls, tool calls, peak context, total tokens, cost,
  edits, gate result, and wall time.
- Acceptance: the same task can be replayed and compared across builds; the
  default suite does not require network or GitHub.
- Status: not built. The only live end-to-end evidence is
  `knowledge/eval-2026-11-03.md`.

### 1.2 Call-efficiency target

- Re-run the live Build after the recent loop changes.
- Target: ≤10 model calls, ≤12 turns, ≤250,000 total tokens, with the edit,
  gates, Review approval, and PR flow intact.
- Compare cost per completed task and p50 time with `pi` and `mini-swe-agent` on
  the same model.
- Status: open. The last live Build used 25 calls, 101,356 tokens, and 5,500 peak
  context tokens.

### 1.3 Live end-to-end matrix

Exercise and record these paths against a disposable repository:

- two dependent Tasks;
- parallel Tasks under separate Features;
- project and Feature scopes;
- human packet approval and rejection;
- Review rejection and retry evidence;
- missing script reuse and artifact provisioning;
- killing a running script or process.

Status: implemented in pieces, but not all paths are exercised live.

### 1.4 Planner model-backed evaluation

- Run the deterministic Planner fixture matrix through a live model.
- Record ambiguity handling, issue graph validity, artifact reuse, and replan
  bounds.
- Status: deterministic fixtures pass; live model evaluation remains.

## 2. Orchestration and issue gaps

### 2.1 Review-role Tasks

- The Orchestrator currently holds a Task with `mc:plan role=review` with
  "review dispatch is not implemented".
- Decide whether a review-role Task dispatches a standalone Review run or is
  removed from the plan schema.
- Implement the chosen path and add tests.
- Acceptance: a ready review-role Task either runs a typed Review or is rejected
  during validation; it is never silently held.

### 2.2 Plan audit trail

- Record each accepted plan revision as an issue comment.
- Acceptance: each `mc:plan` change has an issue-visible history of what changed
  and why.

## 3. Tool-call reliability

Shipped: native-call policy, text-markup detection, serialized-argument repair,
strict JSON-schema sampling, malformed-call rotation, and empty/rejected-run
guards.

Remaining:

- Add a bounded live tool-call smoke probe during catalogue refresh or
  selection. Use one harmless tool and require a native call. Record pass/fail
  and latency.
- Mark failing models unreliable for tool-using roles and re-probe later. Do not
  trust metadata alone.
- Add curated overrides for known text-only or malformed models.
- Decide the per-tier failure policy: fail fast, use a funded model, or use a
  strict text parser for a named model family.
- Cover provider routing: the same model may work on one backend and fail on
  another.
- Extend the detector for JSON tool calls, ReAct `Action:` blocks, and other XML
  variants.

Acceptance: a model that emits text markup never produces a completed run; the
event log records the failure; the model is cooled; the run fails clearly when
no eligible model remains; a model that passes the probe completes a real
tool-using run.

## 4. Integration and compatibility

### 4.1 Opt-in GitHub write/PR integration

- Convert the manual live flow into an opt-in test using a disposable repository.
- Cover reserved Feature 0 / Task 0 creation and repair; Task-only association;
  dependency links; acceptance and approval closure; Task PR → Feature and
  Feature PR → main; cleanup of the temporary repository and branches.
- Acceptance: one environment flag runs the full lifecycle; the default suite
  never writes to GitHub.
- Status: the checked-in test is read-only; the full write/PR flow passed
  manually.

### 4.2 Compatibility cleanup

- Remove or formally document the remaining legacy `delegate` configuration.
- Remove or document `--direct-exec`; no queue or child path uses it.
- Keep `queue` documented as a compatibility path until a breaking release.

## 5. Repo map and semantic search quality

- Derive each semantic module description only from that module's own files.
  Current defects: `src/plan` includes "artifact usage events"; `data/` is
  described as the reference-index layer.
- Cover `data/`, `.machine_code/`, and `docs/` in semantic ranking so model
  configs, policy, skills, and the manual Task lifecycle surface by concept.
- Add regression tests for attribution and ranking.
- Acceptance: descriptions are module-local; the three concept queries return
  the expected files; existing map and semantic tests stay green.
