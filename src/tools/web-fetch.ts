/**
 * machine_code — the `webFetch` tool.
 *
 * A controlled, read-only window to the web for architect agents. It fetches
 * one URL and returns its text, capped at 12 KiB. It is capability-gated:
 * the `web:fetch` capability must be present (on by default for architect,
 * off for engineer), so turning the tool on/off is a data-only change in the
 * role TOML.
 *
 * The tool reuses the same fetch contract as the `reference:browser`
 * command (30 s timeout, machine_code user agent, 12 KiB cap), so behavior
 * is consistent across the two surfaces.
 */
import { Type, type Static } from "typebox";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ToolContext } from "./index.js";

/** Capability guard for the `webFetch` tool. */
export const WEB_FETCH_CAPABILITY = "web:fetch";

/** Cap, in characters, for a fetched body. Matches reference:browser. */
export const WEB_FETCH_CAP_CHARS = 12_000;
/** Fetch timeout, in milliseconds. Matches reference:browser. */
const WEB_FETCH_TIMEOUT_MS = 30_000;

const WebFetchParams = Type.Object({
  url: Type.String({ description: "URL to fetch." }),
});

function ok(text: string): AgentToolResult<undefined> {
  return { content: [{ type: "text", text }], details: undefined };
}

function fail(text: string): AgentToolResult<undefined> {
  return { content: [{ type: "text", text }], details: undefined, isError: true };
}

export function webFetchTool(ctx: ToolContext): AgentTool<typeof WebFetchParams> {
  return {
    name: "webFetch",
    label: "webFetch",
    description:
      "Fetch a URL and return its text content (capped at 12 KiB). " +
      "Read-only: never mutates the worktree or the web.",
    parameters: WebFetchParams,
    async execute(_id, params: Static<typeof WebFetchParams>) {
      try {
        if (!(ctx.capabilities ?? []).includes(WEB_FETCH_CAPABILITY)) {
          return fail(`webFetch requires the "${WEB_FETCH_CAPABILITY}" capability`);
        }
        const url = params.url.trim();
        if (!url) return fail("webFetch requires url");
        const r = await fetch(url, {
          signal: AbortSignal.timeout(WEB_FETCH_TIMEOUT_MS),
          headers: { "user-agent": "machine_code/0.0.0" },
        });
        if (!r.ok) return fail(`fetch failed: HTTP ${r.status}`);
        const text = await r.text();
        const capped =
          text.length > WEB_FETCH_CAP_CHARS
            ? `${text.slice(0, WEB_FETCH_CAP_CHARS)}\n[truncated]`
            : text;
        return ok(capped);
      } catch (error) {
        return fail(`fetch failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  };
}