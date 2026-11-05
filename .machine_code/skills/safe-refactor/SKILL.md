---
name: safe-refactor
description: Use when restructuring code without changing behavior. Keep gates green on every step, one small move at a time.
---

# Safe Refactor

Restructure code while behavior stays fixed. The runner's gates are the
definition of "behavior unchanged" — they stay green throughout, not just
at the end.

## The loop

1. Confirm gates are green before touching anything. If not green, stop:
   fix or report first, never refactor on red.
2. Make one small structural move: rename, extract, move, or split. One
   move per step, no behavior edits mixed in.
3. Re-run the focused gates. Green: continue. Red: revert the move, then
   decide — smaller move, or report the coupling you found.
4. Repeat until the structure goal is met or the area is cleaner than
   before. Leave the nearest meaningful boundary better even if the full
   cleanup is out of scope.

## Rules

- Never mix behavior changes with structural moves. A step that changes
  what code does is not a refactor step — split it out.
- Prefer moves the compiler or tests verify: renames, extractions, and
  moves over rewrites.
- Remove dead code you uncover, but keep each removal its own green step.
- If a move keeps failing gates, that is information: hidden coupling or
  missing coverage. Note it and pick a smaller move.

## Stop conditions

- Gates green on the final state, same set that was green at the start.
- No behavior change: acceptance outcomes identical before and after.
- End with the proving command and its outcome, plus a note on any
  coupling or coverage gaps found along the way.
