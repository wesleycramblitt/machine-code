---
name: verified-testing
description: Use when verification is verified or higher. Encode each acceptance criterion as a failing test first, then implement.
---

# Verified Testing

Prove packet acceptance criteria with tests. Each criterion gets a failing
test before implementation, then just enough code to pass it.

## Seams: where tests go

A seam is the public boundary you observe behavior through — the packet's
acceptance commands and the interfaces they exercise. Test at seams, never
against internals. One criterion maps to one seam; if a criterion has no
clear seam, say so instead of testing internals.

## The loop

1. Pick the next uncovered acceptance criterion.
2. Write one minimal test that fails against current code (red). Confirm it
   fails for the right reason — a test that fails by accident proves nothing.
3. Implement only enough to pass (green). No speculative features.
4. Re-run the full focused set. Keep everything green before the next slice.
5. Refactor while green, then let the runner's gates judge.

Work in vertical slices: one test, one implementation, repeat. Never write
all tests first then all code — bulk tests verify imagined behavior and go
insensitive to real changes.

## Anti-patterns

- **Implementation-coupled**: mocks internal collaborators or tests private
  methods. The tell: the test breaks on refactor with no behavior change.
- **Tautological**: the assertion recomputes the expected value the way the
  code does, so it passes by construction. Expected values come from the
  packet acceptance or a worked example, never from the code under test.
- **Mirroring gates**: a test that only replays the gate command's exit code
  adds nothing. Test the behavior the gate checks, at the seam.

## Stop conditions

- Every acceptance criterion has a red-then-green test, or an explicit note
  why one is untestable (exploratory work, missing harness).
- Runner gates still decide completion. Tests are your evidence, not your
  verdict: end with the proving command and its outcome.
