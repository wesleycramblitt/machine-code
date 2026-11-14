priority: low
tags: models, timeouts, local
files: src/loop.ts, src/cli/run.ts, src/cli/common.ts, src/tui.ts, src/config.ts
keywords: first token timeout, firstTokenTimeoutMs, ollamaFirstTokenTimeoutMs, local model timeout, model call timeout, no timeout local
acceptance: script:build

# Local model calls must not time out waiting for the first token

The user's ask (issues/ideas/models.md item 3): during runs, local (ollama) model calls must not be abandoned on a first-token timeout. Local models can legitimately take minutes to produce their first token when queued behind other requests on the GPU (model loading, long generations). A bounded timeout kills those calls mid-queue, cools the model, and rotates to another — the run fails or degrades for a reason that is not a provider fault.

Current state:

- The config side exists: `DEFAULT_FIRST_TOKEN_TIMEOUT_MS = 60_000` (src/config.ts:44-48) and `DEFAULT_OLLAMA_FIRST_TOKEN_TIMEOUT_MS = 300_000` (src/config.ts:50-55), parsed from `[selection] first_token_timeout_ms` / `ollama_first_token_timeout_ms` into `MachineConfig.selection.firstTokenTimeoutMs` / `.ollamaFirstTokenTimeoutMs` (src/config.ts:287-292). The ollama default is already 5 minutes — an acknowledgment of queueing — but it is still a hard abandon.
- The application side is missing: nothing in `src/` reads `firstTokenTimeoutMs` or `ollamaFirstTokenTimeoutMs` (grep over src returns zero hits outside config.ts). `runLoop` (src/loop.ts:292) and the provider-call path never reference them. Find where the first-token/stream timeout is actually enforced (likely inside the pi-ai API layer or a fetch wrapper the loop calls — `convertToLlm` at src/loop.ts:173 is the adapter boundary) and wire the config through, or confirm the config is dead and make it live.

Deliverable:

1. Trace the model-call path from `runLoop` (src/loop.ts:292) to the provider SDK and find where a no-stream-event timeout (or equivalent) is applied. If it lives in pi-ai, pass the timeout through our adapter (`convertToLlm` / wherever the call options are assembled) so the config value actually controls it.
2. For local (ollama) calls during runs: no first-token timeout. The call waits indefinitely for the first token (the run's own turn/call caps and the user's Ctrl-C remain the bounds). Keep the `ollama_first_token_timeout_ms` config key working for users who want a finite bound, but the default behavior for ollama becomes "no timeout" — a queue wait is not an error.
3. Remote providers keep the existing default (60s) and the `first_token_timeout_ms` override.
4. The availability classifier treats "timeout" as a model-coolable error (src/availability.ts:283-287); make sure a user-cancelled or unbounded-wait local call is not misclassified as a provider stall. If the no-timeout path means the error never fires, no classifier change is needed — just verify.
5. Surface the effective behavior in config docs/comments: update the `DEFAULT_OLLAMA_FIRST_TOKEN_TIMEOUT_MS` comment (src/config.ts:50-55) and the `[selection]` docs to say local calls are unbounded by default.

Behavior after it lands: a run whose selected local model sits queued behind another GPU request for 10+ minutes still completes instead of cooling the model and rotating; a remote provider call that stalls past the first-token timeout still abandons and rotates as today.

Verification: `script:build`; grep confirms `ollamaFirstTokenTimeoutMs`/`firstTokenTimeoutMs` flow from config into the call site; a run against a slow/queued local model (or a stub provider endpoint that delays the first stream event beyond 60s) no longer logs a timeout cooldown for ollama while a stalled remote call still does.
