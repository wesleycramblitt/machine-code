/**
 * machine_code — the `pr` tool: capability-gated pull-request access.
 *
 * Reads (list/status) need pr:read; creation/request-review need pr:create;
 * merge needs pr:merge AND the per-issue approval policy (human requests an
 * approval instead of merging). The normal Task/Feature publish pipeline is
 * runner-owned; this tool is for coordination and explicit merges.
 */
import { Type, type Static } from "typebox";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { PrError, type PullRequest, type PullRequestProvider } from "../pr/provider.js";
import type { RunRecorder } from "../state/runs.js";

export interface PrToolContext {
  provider: PullRequestProvider;
  capabilities: readonly string[];
  recorder: RunRecorder;
  defaultApproval: "human" | "agent";
}

const PrParams = Type.Object({
  action: Type.Union(
    [
      Type.Literal("list"),
      Type.Literal("status"),
      Type.Literal("create"),
      Type.Literal("merge"),
      Type.Literal("request-review"),
    ],
    { description: "PR operation." },
  ),
  number: Type.Optional(Type.Number({ description: "PR number (status/merge/request-review)." })),
  head: Type.Optional(Type.String({ description: "Head branch (create/list)." })),
  base: Type.Optional(Type.String({ description: "Base branch (create/list)." })),
  title: Type.Optional(Type.String()),
  body: Type.Optional(Type.String()),
  draft: Type.Optional(Type.Boolean()),
  state: Type.Optional(Type.Union([Type.Literal("open"), Type.Literal("closed"), Type.Literal("all")])),
});

function ok(text: string): AgentToolResult<undefined> {
  return { content: [{ type: "text", text }], details: undefined };
}

function fail(text: string): AgentToolResult<undefined> {
  return { content: [{ type: "text", text }], details: undefined, isError: true };
}

function line(pr: PullRequest): string {
  return `#${pr.number} ${pr.state}${pr.isDraft ? " draft" : ""} ${pr.head} → ${pr.base}  ${pr.title}${pr.url ? `  ${pr.url}` : ""}`;
}

export function prTool(ctx: PrToolContext): AgentTool<typeof PrParams> {
  const require = (cap: string): void => {
    if (!ctx.capabilities.includes(cap)) throw new PrError("capability_missing", `pr tool action requires ${cap}`);
  };

  return {
    name: "pr",
    label: "pr",
    description:
      "Pull requests: list/status read; create opens a PR (Task branches target their Feature branch, Feature branches target main); " +
      "merge follows the approval policy (human approval is requested instead of merging); request-review marks a PR ready.",
    parameters: PrParams,
    async execute(_id, params: Static<typeof PrParams>) {
      try {
        return await run(params);
      } catch (error) {
        if (error instanceof PrError) return fail(`${error.code}: ${error.message}`);
        return fail(error instanceof Error ? error.message : String(error));
      }
    },
  };

  async function run(params: Static<typeof PrParams>): Promise<AgentToolResult<undefined>> {
    switch (params.action) {
      case "list": {
        require("pr:read");
        const prs = await ctx.provider.list({ head: params.head, base: params.base, state: params.state ?? "all" });
        return ok(prs.length === 0 ? "no pull requests" : prs.map(line).join("\n"));
      }
      case "status": {
        require("pr:read");
        if (!params.number) return fail("status requires number");
        const pr = await ctx.provider.status(params.number);
        return pr ? ok(line(pr)) : fail(`pull request #${params.number} not found`);
      }
      case "create": {
        require("pr:create");
        if (!params.head || !params.base) return fail("create requires head and base");
        const taskToFeature = params.head.startsWith("mc/task/") && params.base.startsWith("mc/feature/");
        const featureToMain = params.head.startsWith("mc/feature/") && params.base === "main";
        if (!taskToFeature && !featureToMain) {
          return fail(
            `invalid PR direction: ${params.head} → ${params.base} (Task→Feature or Feature→main only; Task PRs never target main)`,
          );
        }
        const pr = await ctx.provider.create({
          head: params.head,
          base: params.base,
          title: params.title ?? `PR: ${params.head}`,
          body: params.body ?? "",
          draft: params.draft ?? false,
        });
        ctx.recorder.event("pr_opened", { pr: pr.number, url: pr.url, head: pr.head, base: pr.base });
        return ok(`opened ${line(pr)}`);
      }
      case "merge": {
        require("pr:merge");
        if (!params.number) return fail("merge requires number");
        if (ctx.defaultApproval === "human") {
          ctx.recorder.event("approval_requested", { action: "merge", pr: params.number });
          return ok(
            `merge approval requested for #${params.number}; a human must approve with "machine_code approve ${params.number}"`,
          );
        }
        await ctx.provider.merge(params.number, "squash");
        ctx.recorder.event("pr_merged", { pr: params.number, method: "squash" });
        return ok(`merged #${params.number} (squash)`);
      }
      case "request-review": {
        require("pr:create");
        if (!params.number) return fail("request-review requires number");
        const pr = await ctx.provider.status(params.number);
        if (!pr) return fail(`pull request #${params.number} not found`);
        return ok(`#${pr.number} is ready for review (${pr.url})`);
      }
      default:
        return fail(`unknown pr action: ${String((params as { action?: unknown }).action)}`);
    }
  }
}
