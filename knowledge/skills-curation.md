# Skills curation

Status: 2026-11-02. Scope: which third-party agent skills to adopt for
machine_code, and in what form.

## Decision

Keep three skills: `reference` (existing), `requirements` (new), and
`systematic-debugging` (new).

The other seven skills from the ranked list are one of these:

- a rule for the shared base prompt,
- a mechanism the harness already owns,
- or a capability that needs a profile command, not instructions.

Do not install the third-party repositories. Rewrite the useful procedure for
these tools.

## How skills load in this repo

1. **Description discovery.** Every `.machine_code/skills/*/SKILL.md` and
   `~/.machine_code/skills/*/SKILL.md` is parsed for `name` and `description`.
   All descriptions render into one context block (`src/context/assemble.ts`,
   `skillMetas` and the skill block).
2. **Body loading.** A skill body enters the prompt only when an issue declares
   it in `mc:context` (`{"skills":["..."]}`). The body is included whole
   (`src/context/assemble.ts`, `skillBody`; `src/context/references.ts`).
3. **No skill scripts.** Commands are typed manifests from profiles and run
   with `execFile` (`src/commands/registry.ts`). There is no shell. A vendored
   skill that ships scripts cannot run here.
4. **Worktrees include skills.** `.machine_code/skills` is present in a run
   worktree. An agent can read a named skill path if a packet tells it to.
5. **Prompt budget is tight.** The prompt plan is a shared base of at most
   1,500 chars plus role deltas of at most 300 chars. Its rule: add a rule only
   when an eval failure justifies it.

Consequences:

| Need | Home |
|---|---|
| Behavior that applies on every run | shared base prompt |
| Conditional, stage-specific procedure | skill |
| New tool capability | typed profile command |
| Already enforced by the runner | neither |

## Decision table

| Rank | Skill | Decision | Home | Reason |
|---:|---|---|---|---|
| 1 | `brainstorming` | Merge | `requirements` skill + base prompt | Explore alternatives only when ambiguity is high. An always-on version costs prompt tokens on every request. |
| 2 | `writing-plans` | Drop | Packet schema | The packet is the plan: goal, context, constraints, acceptance (`src/packet.ts`). `runGates` executes acceptance. A second plan invites Build to re-plan. |
| 3 | `systematic-debugging` | Keep as skill | `.machine_code/skills/systematic-debugging` | Conditional and behavior-changing. No current prompt requires reproduce-first or one-hypothesis-at-a-time. |
| 4 | `test-driven-development` | Drop | Build mode + gates | Verified and redundant modes already require focused tests per acceptance criterion (`data/agents/build.toml`). Gates make test passage objective. Test-first order is not worth a rule until an eval shows overfitting. |
| 5 | `verification-before-completion` | Base prompt | Shared base | Universal. `runGates` already stops model self-certification. The missing piece is the agent's own "done" claim; the planned `Evidence: <command and outcome>` field covers it in one line. A skill would not load on every run. |
| 6 | `grill-me` | Merge | `requirements` skill | One-question-at-a-time is the core of that skill. The base already has the compressed rule. |
| 7 | `grill-with-docs` | Drop | `reference` skill + Build prompt | `reference` already covers source gathering and indexing. Keep at most one line: check installed types or official docs for an unfamiliar API. |
| 8 | `improve-codebase-architecture` | Defer | Architect, only for a refactor issue | Useful for architecture, dangerous for a packet-bound Build. Revisit when a refactor issue has behavior invariants and a review gate. |
| 9 | `agent-browser` | Not a skill | Future profile command | This is a capability. `reference:browser` fetches text only. Add a Playwright profile command if runtime UI proof becomes required. Never import browser skill scripts. |
| 10 | `requesting-code-review` | Drop | Review role + `pr` tool | The harness owns review: the `review` role, `[mode.redundant] review = true`, and `pr request-review`. A skill duplicates the role prompt. |

## Kept registry

| Skill | Stage | Load when | Size |
|---|---|---|---|
| `reference` | Architect | Gathering or indexing sources | existing |
| `requirements` | Architect | Request is large or ambiguous | about 1.2 KiB |
| `systematic-debugging` | Build, Sudo | A gate, test, or bug fails | about 1.4 KiB |
| `clean-code` | Build, Planner | Every coding/planning run (mode default) | about 5.7 KiB |
| `verified-testing` | Build | Verification verified or higher (mode default) | about 2.0 KiB |
| `safe-refactor` | Build | Refactor issue declares it in `mc:context` | about 1.6 KiB |
| `knowledge-curation` | Build, Planner | Issue declares it in `mc:context` | about 1.8 KiB |
| `plan-curation` | Build, Planner | Issue declares it in `mc:context` | about 1.8 KiB |

The eight descriptions use about 950 chars. The whole description block must
stay under 1 KiB.

## How an agent gets a kept skill

1. Mode defaults: `defaultSkillsFor` (`src/context/references.ts`) resolves
   `clean-code` on every build/planner/general/sudo run plus
   `verified-testing` on verified or higher. Bodies load like declared
   skills, lose ties to them, and honor `section:skills` / `skill:name`
   exclusions (`src/context/assemble.ts`, `src/context/preview.ts`).
2. Preferred for conditional skills: the issue adds
   `{"skills":["systematic-debugging"]}` (or `["safe-refactor"]`,
   `["knowledge-curation"]`, `["plan-curation"]`) to its `mc:context`
   block. The body is then injected for that issue and its descendants.
3. If the issue has no block: the Architect names the exact path in the packet
   constraints. Build reads it once.
4. Do not add a skill to every issue. A large body pushes out task and packet
   context. Mode defaults are the only always-on bodies.

## Update 2026-11-05: mode default skills

Surveyed obra/superpowers (15 skills), mattpocock/skills (tdd, code-review,
implement, to-tickets, improve-codebase-architecture), ramziddin/solid-skills
(1 TS-centric skill, ~88 KiB bundle), and the myskills.tools directory.
Kept the rewrite-don't-vendor rule with one exception: `clean-code`
(upstream body kept verbatim, description shortened to fit the parser and
the 1 KiB description budget).

- Added `verified-testing`: distills mattpocock/tdd seams and anti-patterns
  (implementation-coupled, tautological, horizontal slicing) against packet
  acceptance instead of user-confirmed seams. Partially revisits the rank-4
  TDD drop: test-first ordering is now the verified-mode default, with an
  explicit escape hatch. Revisit if "blocked on test-first" reports recur.
- Added `safe-refactor`: gated green-to-green loop for behavior-preserving
  restructures. `improve-codebase-architecture` stays deferred for
  structural (shallow-to-deep) refactors with behavior invariants.
- Dropped everything else: packets/issues own planning and tickets
  (writing-plans, to-tickets, implement), the harness owns worktrees,
  dispatch, gates, and review (executing-plans, subagent-driven-development,
  using-git-worktrees, requesting-code-review, code-review), scripts cannot
  run here (brainstorming server, plan scripts), and solid-skills overlaps
  clean-code at ~88 KiB.

## Proposed prompt lines, not applied

Other agents are editing prompts. Treat these as proposals:

- Shared base, required: `Do not report complete until the proving command ran.`
- Shared base, already planned: `Ask one precise question only when a wrong change is likely.`
- Build, optional: `Check an unfamiliar API against installed types or official docs for the pinned version.`
- Architect, optional: `Reference requirements for large or ambiguous issues. Reference systematic-debugging for bug issues.`

Add no more until an eval failure shows the need.

## Authoring rules

- One agent stage per skill.
- Description starts with `Use when`, states the trigger, and is 140 chars or less.
- Body is 1.5 KiB or less. Use 5 to 9 steps and one stop condition.
- No tool counts, JSON examples, or hardcoded turn limits.
- Do not repeat what the runner or the tool schema enforces.
- Do not vendor third-party `SKILL.md` files. Rewrite the procedure for these tools.
- Keep executable scripts out. If a step needs a tool, add a typed profile command.

## Revisit triggers

- `test-driven-development`: add it if tests pass while behavior is still wrong.
- Architecture skill: add it when a refactor epic has behavior invariants and a
  review gate.
- Browser skill: add it when a Playwright or text-browser profile exists and a
  UI issue needs runtime proof.
- Any skill: remove it if no issue references it across a release cycle.

## Sources

- obra/superpowers: `brainstorming`, `writing-plans`, `systematic-debugging`,
  `test-driven-development`, `verification-before-completion`,
  `requesting-code-review`.
- mattpocock/skills: `grill-me`, `grill-with-docs`,
  `improve-codebase-architecture`.
- vercel-labs/agent-browser.
- Ranked list supplied by the user on 2026-11-02.
