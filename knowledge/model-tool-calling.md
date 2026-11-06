# Model tool-call reliability

Status: 2026-11-03. Scope: native tool calls, text markup, model selection.

## Decision

Tool-using roles require native structured tool calls. A text-only response that
contains tool-call markup is malformed. It must not complete a run. Cool the
model, rotate to another model, or fail the run when no model remains.

## How tool calls work

Tool calls are part of the model API request and response, not a separate API.

- OpenAI Chat Completions: request `tools`; response `message.tool_calls[]`
  with `function.name` and JSON `function.arguments`; finish reason
  `tool_calls`.
- OpenAI Responses: response `function_call` output items.
- Anthropic Messages: request `tools`; response content block
  `{ type: "tool_use", name, input }`; stop reason `tool_use`.
- Gemini: response `functionCall` parts.

The client executes the tool, then sends the result back as a `tool`,
`tool_result`, or `functionResponse` message in the next request.

Text tool-call formats exist for models without native support. They are a
separate protocol. Do not mix them with native tool calling silently.

## Observed failure

Run `20261103-191201-1ukv` was a `general` run on the free tier.

1. `opencode/deepseek-v4.1-flash-free` returned a 429 FreeUsageLimitError.
2. The loop retried with `openrouter/xingchen-agi/xing4.0-29b-a4b:free`.
3. That model returned `stopReason: stop` with text containing
   `<tool_call>` and `<param_key>` markup.
4. The response had no native `toolCall` blocks and no `tool_call_start`
   events.
5. The loop treated the text-only stop as a final answer and marked the run
   `completed` after 2 turns.

The run was still in the orient phase. It had no plan and no issue writes.

## Observed failure 2026-11-05: serialized arguments

Run `20261105-041811-ew9u` used `opencode-go/beam-free`. The model emitted a
native tool call, but serialized the fields as attribute text inside one value:

```json
{ "action": "note\">\nkind: next\">\nInvestigate run ..." }
```

The schema rejected it. The model repeated the same malformed call, then ended
with "I used malformed XML. Need correct." The harness marked the run
`completed` because the final text had no markup.

Fix in this revision:

- Core tools now set `constrainedSampling: { type: "json_schema", strict:
  "prefer" }`. The OpenCode Go metadata marks Beam Free as
  `supportsStrictMode: true`; without this field the request sent
  `strict: false`, so the model had no constrained decoding. OpenCode sends the
  strict form, which matches the behavior the user observed there.
- Schema conversion keeps unions/enums, so strict mode constrains `context`
  actions, note kinds, and `search` modes to their allowed values.
- Providers that do not support strict mode, or schemas that strict mode cannot
  encode, fall back to the plain schema. The `command` tool uses
  `patternProperties`, so it intentionally falls back.
- Optional fields become `null` under strict mode. Tool code treats `null` as
  absent.
- `src/tools/args.ts` repairs the one-value attribute form before schema
  validation. The repaired object still must pass the real schema.
- A repaired call is logged as `tool_args_repaired` and may continue.
- An unrepaired serialized argument now counts as a malformed response. The
  loop cools the model and rotates instead of completing.

## Why the catalogue can be wrong

OpenRouter catalogue rows infer tool support from endpoint metadata:

```ts
toolCall: params.has("tools") || params.has("tool_choice")
```

That means the endpoint accepts the parameters. It does not prove that the
model emits native tool calls. A model may ignore the tools, use a different
text format, or be routed to a backend that does not implement tools.

The selector only checks the catalogue flag (`src/select.ts`,
`no-tool-support`). It does not probe behavior.

## Required behavior

1. Prefer native tool calls for every tool-using role.
2. Detect text-only responses that contain tool-call markup.
3. Treat that response as malformed. Do not treat it as a final answer.
4. Record the failure. Cool the model and rotate to the next eligible model.
5. If no eligible model remains, fail the run with a clear error.
6. Keep the event visible in the timeline and run detail.
7. Add a bounded model probe or curated override when a model is unreliable.
8. Add a text protocol only as an explicit, per-model fallback with a strict
   parser. Never auto-complete on unparsed markup.

## Current guard

- `src/state/tool-call-text.ts` detects `<tool_call>`, `<tool_use>`,
  `<function_call>`, and `<invoke>` markup. It requires two tags, or one tag
  plus `<param_key>`. It also detects provider envelopes (`</rfl:parameter>`,
  `<|start|>`, `<|end|>`, `<|channel|>`, `<|constrain|>`, `<|message|>`).
- `src/tools/index.ts` requests JSON-schema constrained sampling for core
  tools. Models with `compat.supportsStrictMode` get `strict: true`; others get
  the plain schema.
- `src/tools/args.ts` repairs one-value attribute serialization before
  validation. A repaired call emits `tool_args_repaired`.
- `src/loop.ts` checks the last assistant message after the agent goes idle. If
  it has no native `toolCall` block and contains markup, a native tool call has
  provider markup inside its arguments, or a serialized argument was not
  repaired, the loop records `malformed_tool_call`, classifies the response as
  malformed, cools the model, and retries.
- A run that ends with no final text is `blocked`, not `completed`. A run with
  repeated tool errors and no substantive success is also `blocked`.
- `src/tui/timeline.ts` and the run detail show `malformed tool call`.
- `test/tool-call-text.test.js` and `test/tool-args.test.js` cover the detector
  and the repair.

## Remaining hardening

- Add a small live tool-call smoke test during catalogue refresh or selection.
  Use one harmless tool, require a native call, and store the result.
- Mark models that fail the probe as unreliable. Do not select them for
  tool-using roles until a later probe passes.
- Add curated overrides for known text-only models, even when metadata says
  `tools` is supported.
- Decide the fallback policy: fail fast, use a funded model, or add a strict
  text parser. Do not add an open-ended parser without per-model tests.
- Add a repair prompt for a malformed call only when the model can recover.
  Otherwise rotate.
- Cover provider routing. A model that works on one OpenRouter backend may fail
  on another.

## Verification checklist

- Native tool call: one `tool_call_start`, tool runs, run continues.
- Text markup: `malformed_tool_call`, model cooled, retry occurs.
- Single prose mention of `<tool_call>`: not flagged.
- No tool call and a valid final answer: run completes.
- No tool call and no valid final answer: run does not claim success.
- All eligible models malformed: run status is `failed`, not `completed`.
- Timeline shows the malformed event and the retry.

## Where to look

- `src/loop.ts` — turn loop, final status, retry guard.
- `src/state/tool-call-text.ts` — text-markup detector.
- `src/catalogue/openrouter.ts` — metadata inference.
- `src/select.ts` — tool-support rejection.
- `test/tool-call-text.test.js` — detector tests.

## Observed failure 2026-11-05: flat graph arguments

Run `20261105-234951-h566` used local `qwen3.8` after four free-model failures.
The model understood the planning task but called the issue graph with
`epic`, `features`, and `tasks` at the top level. The old `issue` schema nested
them under `graph`, and `graph` was optional, so validation accepted the call
and the handler returned only `graph action requires graph`. The model repeated
the same call four times.

Fix in this revision:

- `issue_graph` is a separate tool with flat top-level `epic`, `features`, and
  `tasks`. `issue` no longer exposes the `graph` action.
- `issue_graph` `prepareArguments` parses JSON-string fields, wraps single
  objects in arrays, and accepts a nested legacy `graph` object.
- `issue prepareArguments` accepts `status: "open"` as the `tree`/`list` state
  filter. `plan_status` is the clear name for the plan action; `status` remains
  a legacy alias.
- Repairs emit `tool_call_repaired` so we can measure how often fallback
  models need help.
- The loop stops after the same tool error in three turns, not only after twenty
  stale evidence actions.
- The planner prompt uses `issue_graph` with top-level fields, tells the model
  to research first, and limits one graph call to three features and eight
  tasks.

Design rule: if a tool has an object or array parameter, say that explicitly
in both the tool description and the parameter description. Do not rely on a
weak model to infer nesting from a schema.

## Observed failure 2026-11-06: false loop on a parallel batch

Run `20261106-004546-su91` was a planner run on local `qwen3.8`. It read
`plans/tui.md`, created the Epic and three Features, then sent eleven Task
creates in one assistant turn. Every body used:

```markdown
## Acceptance criteria
1. ...
2. ...
```

`parseAcceptance` only accepted `-` bullets, so every Task looked like it was
missing acceptance criteria. The new three-error guard then counted three of
the parallel failures as three strikes and terminated the batch. The model was
not looping; one bad validation rule rejected a valid body shape, and the guard
mistook parallel calls for repeated turns.

Fix in this revision:

- `parseAcceptance` accepts bullets, numbered items, and checkbox prefixes.
- `issueContextErrors` distinguishes a missing acceptance section from an
  empty one whose items are not bullets or numbers.
- The error guard counts at most one strike per model turn. Parallel calls in
  one assistant turn are one bad decision; the run stops only after the same
  error appears in three turns.

Design rule: a batch of independent calls is one model decision. Never turn
per-call failures inside that batch into a turn-level loop verdict.
