> Historical design note. Item grammar now lives in plan files as typed
> checklist lines; see `plans/index.md`. The packet and build rules below
> still apply.

# Plan-file work model (files as truth)

Drop GitHub issues as ground truth for local work. Promote `plans/` to the single
source of truth: one index file (the "semantic map") plus one packet file per
buildable work item, keyed by human-readable slugs. GitHub becomes an optional
publish/sync projection, never the source of truth.

## Principles

1. **One source of truth** — everything lives under `plans/`, so work is
   git-versioned, diffable, offline, and grep-able with no API dependency.
2. **Slugs, not numbers** — a work item is `login-token-refresh`, not `#42`.
   The slug derives the branch (`mc/<slug>`) and worktree (`.worktrees/<slug>`),
   so nothing is stored in two places.
3. **Cheapest capture wins.** A bare line in the index is a valid plan/idea. A
   packet file appears only when the item is ready to build.
4. **"Done" is deterministic, not declarative.** A packet is done when its
   `Verify` passed and an edit landed — enforced by the harness, not a status
   field the model gets to set.
5. **Parallelism is a scheduler property, not ceremony.** Ready leaves fan out
   into worktrees up to `max-parallel`; dependencies are edges in packet
   front-matter.

## Layout

```
plans/
  plan.md          # index: headings = categories, lines = work items
  <slug>.md        # packet: the bounded contract for ONE buildable unit
```

Branch `mc/<slug>`, worktree `.worktrees/<slug>`. Derived; never hand-edited.

## Packet grammar

`plans/login-token-refresh.md`:

```markdown
---
status = "todo"               # todo | in-progress | blocked
deps = []                     # slugs this waits on
blocked = ""                  # reason, only meaningful when status = blocked
---
# login-token-refresh

## Deliverable
Repair the token-refresh race in src/auth/session.ts.

## Files
- src/auth/session.ts
- src/auth/token.ts
- test/auth/session.test.ts

## Acceptance
- AuthSuite.timeouts is stable across 100 runs
- no new flake markers

## Verify
npm test -- auth
```

Rules:

- **Required to be buildable:** `## Deliverable` and at least one `## Verify`
  line. The slug is the filename; it is not repeated as data.
- **Optional:** `## Files` (build self-locates against the deterministic map when
  absent), `## Acceptance`, and the front-matter fields.
- The front-matter is TOML (`---`-delimited), parsed by the existing `smol-toml`
  dependency, consistent with `data/agents/*.toml` and `config.toml`.

## Index grammar

`plans/plan.md`:

```markdown
# Plan

## Features
- [ ] rate-limiter — add public API rate limiting → plans/rate-limiter.md
- [x] thermal-model

## Bugs
- [ ] login-token-refresh — auth flaky timeout → plans/login-token-refresh.md
- [ ] payments — (blocked: waiting on vendor API key)

## Ideas
- [ ] investigate moving to esbuild          # no packet yet

## Done
- [x] foo — merged 2026-11-03
```

An item is just a line. When a packet exists the line links to it; when it
doesn't, it's a plan/idea. A `blocked` item carries an inline reason.

## Status & lifecycle

Statuses on a **live** packet: `todo → in-progress → blocked ⇄ in-progress`.
`done` never persists on a live packet — completion *removes* it (below).

1. **Capture** — add a line under a heading. Cheapest unit; no packet.
2. **Ready** — write `plans/<slug>.md` with `## Deliverable` + `## Verify`.
   Authored by you, or by a `planner` run for open-ended work (which also fills
   `deps`).
3. **Build** — the orchestrator or `build` dispatches a ready packet, creates
   `mc/<slug>` branch + worktree, sets `in-progress`, runs localize→patch→verify.
4. **Approve/merge** — merge branch to main, then complete (next section).

## Dispatch, dependencies, parallelism

- **Ready** = `deps` all resolved (every listed slug is done).
- The scheduler topo-sorts over `plans/*.md`, then fans out *ready leaves* into
  worktrees up to `max-parallel`. Tasks sharing source files are serialized —
  authors declare this by listing `deps`, and the existing
  serialize-within-scope safety net stays as a backstop.
- `blocked` packets are skipped; they surface under "awaiting input."

## Build: bounded vs open-ended (one loop)

- `build <slug>` — bounded: the packet exists; build reads it, patches, verifies.
- `build "<goal>"` — open: no packet; build **self-scopes first** (3-line plan +
  files + a gate, gated by the existing `plan-required` guard), then patches and
  verifies. If it finds the work multi-file/decomposition-worthy, it stops with
  `needs_planning` and hands off instead of barreling through.
- `plan "<goal>"` — a planner run reads the map + knowledge and *writes* the
  index lines + packet files + `deps`.

All three run the same localize→patch→verify loop. The only difference is who
authored the packet (you, the builder in-run, or the planner) and how many
packets (1 vs N with edges). No `solo` role.

## Merge & delete (seamless)

`approve <slug>` performs, idempotently and with tombstone reconciliation:

1. Merge `mc/<slug>` into main (local `git merge`; no PR).
2. Move the index line to `## Done`, checked, with a merge-date suffix.
3. `git rm plans/<slug>.md` (commit on main, like the existing
   `commitPlanFile`).
4. Remove `.worktrees/<slug>`.

Git history is the record of deleted packets. `delete <slug>` removes an
incomplete item (line + packet + branch + worktree), with the same cascade-
confirmation semantics the issue tool has today.

## CLI surface

```
machine_code plan                 # render the plan tree (human view)
machine_code packet <slug>        # show / create / edit a packet
machine_code build <slug|goal>    # bounded packet, or open self-scoped run
machine_code approve <slug>       # merge + done + delete, seamless
machine_code delete <slug>        # remove an incomplete item
machine_code orchestrate          # fan ready packets out across worktrees
```

## TUI changes

- **Plan view** (`plan` page) replaces the issue tree as the primary work view:
  the index rendered as a tree — categories → items — with status badges
  (`◦ todo`, `● in-progress`, `⏸ blocked`, `✓ done`), a branch/worktree badge
  when live, dep edges (indent/arrow), and any in-flight run for the slug.
  Keys: `j/k` navigate, `/` filter by slug/text/status, `r` refresh, `Enter`
  open packet, `space` toggle category collapse.
- **Packet detail** (`Enter`): `## Deliverable/Files/Acceptance/Verify`, status,
  deps, branch/worktree, and the slug's run history (reuses the existing run
  Overview/context/events detail).
- **Actions:** `b` build, `p` plan (decompose), `x` open run, `s` set status
  (block with reason / reopen), `a` approve+merge, `d` delete.
- **Work queues:** the existing "needs a human / in flight" filter (`!`) maps
  onto `blocked` and `in-progress` packets; a "ready to build" and "awaiting
  input" grouping sits at the top of the Plan view.
- **New Run composer:** the issue/packet target becomes a slug field —
  `run --agent build --packet login-token-refresh` or a free-form goal. The
  composer previews exactly the packet, files, and gates the run will inherit,
  same as it does for `mc:context` today.

## Migration (from the current issue + plan-mirror)

Reuse, don't rebuild — most of the machinery exists:

- `src/plan/tracking.ts` already has line append/replace/remove, heading-safe
  replace, slice-commit-on-main (`commitPlanFile`). Generalize the `#n` regex to
  slug lines/links.
- `src/plan/schema.ts` `mc:plan` JSON marker becomes packet front-matter
  (`status`, `deps`, `blocked`); `verification`/`worktree`/`review` policy moves
  to defaults, with optional overrides, instead of per-issue markers.
- Retire: the issue/issue_graph tools, reserved Feature 0/Task 0 anchors, and the
  `## Context/Goal/Scope/Success measures` body-section enforcement. Keep the
  issue tool as an optional adapter only if a `gh publish`-style projection is
  wanted later.

## Open decisions (before implementation)

1. **Index filename** — `plans/plan.md` as the single canonical index (my rec),
   or fold the existing `plans/index.md` in as-is.
2. **Done handling** — move the line to a `## Done` heading on approve (my rec,
   visible history without clutter), vs. delete the line outright.
3. **`gh` escape hatch** — add a thin optional publish/sync command now
   (recommended), or postpone until a second human or cross-machine need appears.
