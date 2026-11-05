# machine_code — remaining work

> Only unbuilt work is listed. Finished phases were removed; their design
> history stays in git and in `knowledge/`.
>
> Baseline: a live Planner → Build → Review → Task PR → Feature PR run passed.
> The suite has 392 tests (391 passing, 1 skipped).
>
> Goal: finish real repository work with runner-owned evidence, low context
> cost, and deterministic scheduling.
>
> Filter for this list: an item stays only if it makes the harness more
> correct, cheaper to run, or measurable. Deferred work sits in §5.

Order of work: 1.1 → 2.1 → 3 → 4. Section 1 gives the numbers that judge the
rest.

## 1. Measure the loop

### 1.1 Replayable task suite

- Build a fixed 12-task suite and one replay command.
- Record per run: turns, model calls, tool calls, peak context, total tokens,
  cost, edits, gate result, and wall time.
- Include one suite entry that runs the deterministic Planner fixtures through
  a live model. Record ambiguity handling, issue-graph validity, artifact
  reuse, and replan bounds.
- Acceptance: the same task replays and compares across builds. The default
  suite needs no network and no GitHub.
- Status: not built. `knowledge/eval-2026-11-03.md` is the only live evidence.

### 1.2 Call-efficiency target

- Re-run the live Build after the recent loop changes.
- Target: ≤10 model calls, ≤12 turns, ≤250,000 total tokens, with edit, gates,
  Review approval, and the PR flow intact.
- Compare cost per completed task and p50 time with `pi` and
  `mini-swe-agent` on the same model.
- Status: open. The last live Build used 25 calls, 101,356 tokens, and 5,500
  peak context tokens.

### 1.3 Live path matrix

Exercise each path once on a disposable repository. Record the run id.

- two dependent Tasks;
- parallel Tasks under separate Features;
- project scope and Feature scope;
- human packet approval and rejection;
- Review rejection with retry evidence;
- missing script reuse and artifact provisioning;
- kill a running script or process.

Status: built in pieces, not exercised live.

## 2. Close silent gaps

### 2.1 Review-role Tasks

- The Orchestrator holds a Task with `mc:plan role=review` and reports "review
  dispatch is not implemented" (`src/cli.ts`).
- Decide: dispatch a standalone Review run, or reject the marker in
  `src/plan/validate.ts`.
- Implement the chosen path and add tests.
- Acceptance: a ready review-role Task either runs a typed Review or fails
  validation. It never sits held.

## 3. Model reliability

Shipped: native-call policy, text-markup detection, serialized-argument
repair, strict JSON-schema sampling, malformed-call rotation, and empty-run and
rejected-run guards.

Remaining:

- Add a bounded live tool-call probe during catalogue refresh or selection. Use
  one harmless tool and require a native call. Record pass/fail and latency.
- Mark failing models unreliable for tool-using roles and re-probe later. Do
  not trust metadata alone.
- Add curated overrides for known text-only or malformed models.
- Cover provider routing: one model can pass on one backend and fail on
  another.
- Extend the detector for JSON tool calls, ReAct `Action:` blocks, and other
  XML variants.
- Set the per-tier failure policy: fail fast, use a funded model, or use a
  strict text parser for a named model family.

Acceptance: a model that emits text markup never completes a run. The event log
records the failure, the model cools, and the run fails clearly when no model
remains. A probe-passing model completes a real tool-using run.

## 4. Context and map quality

- Derive each semantic module description only from that module's own files.
  Current defects: `src/plan` includes "artifact usage events"; `data/` reads as
  the reference-index layer.
- Rank `data/`, `.machine_code/`, and `docs/` by concept so model configs,
  policy, skills, and the manual Task lifecycle surface.
- Add regression tests for attribution and ranking.
- Acceptance: descriptions are module-local, the three concept queries return
  the expected files, and map and semantic tests stay green.

## 5. Deferred — do not start without a reason

- GitHub write/PR integration test. The checked-in test is read-only and the
  full write/PR flow passed manually. Add an opt-in test with a disposable
  repository when the manual flow next breaks.
- Plan audit trail. Record each accepted `mc:plan` revision as an issue
  comment. Do this after §2.1 fixes the marker's final shape.
- Compatibility cleanup. `--direct-exec` is live for delegated child runs
  (`src/cli.ts:1382`) and the `delegate` config still exists in
  `src/agents/config.ts`. Revisit at a breaking release.
