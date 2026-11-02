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
   All descriptions render into one context block capped at 1 KiB
   (`src/context/assemble.ts`, `skillMetas` and the skill block).
2. **Body loading.** A skill body enters the prompt only when an issue declares
   it in `mc:context` (`{"skills":["..."]}`). The cap is 4 KiB
   (`src/context/assemble.ts`, `skillBody`; `src/context/references.ts`).
3. **No skill scripts.** Commands are typed manifests from profiles and run
   with `execFile` (`src/commands/registry.ts`). There is no shell. A vendored
   skill that ships scripts cannot run here.
4. **Worktrees include skills.** `.machine_code/skills` is present in a run
   worktree. An agent can read a named skill path if a packet tells it to.
5. **Prompt budget is tight.** The prompt plan is a shared base of at most
   1,500 chars plus role deltas of at most 300 chars
   (`plans/context-and-map-plan.md` §10). Its rule: add a rule only when an eval
   failure justifies it.

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

The three descriptions use about 330 chars. The whole description block must
stay under 1 KiB.

## How an agent gets a kept skill

1. Preferred: the issue adds `{"skills":["systematic-debugging"]}` to its
   `mc:context` block. The body is then injected for that issue and its
   descendants.
2. If the issue has no block: the Architect names the exact path in the packet
   constraints. Build reads it once.
3. Do not add a skill to every issue. A 4 KiB body pushes out task and packet
   context.

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
