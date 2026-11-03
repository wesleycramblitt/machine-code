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
  plus `<param_key>`.
- `src/loop.ts` checks the last assistant message after the agent goes idle. If
  it has no native `toolCall` block and contains markup, the loop records
  `malformed_tool_call`, classifies the response as malformed, cools the
  model, and retries.
- `src/tui/timeline.ts` and the run detail show `malformed tool call`.
- `test/tool-call-text.test.js` covers the detector.

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
