/**
 * machine_code — the `artifact` tool.
 *
 * Inventory for reusable tools and scripts. Tool manifests can be provisioned
 * with `artifact:provision`; executable scripts remain a human-approved CLI
 * operation.
 */
import { Type, type Static } from "typebox";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { join } from "node:path";
import type { Layout } from "../paths.js";
import { layout } from "../paths.js";
import {
  artifactPath,
  artifactSummary,
  listArtifacts,
  resolveArtifact,
} from "../artifacts/registry.js";
import { listAllRuns, type RunRecorder } from "../state/runs.js";
import type { ArtifactUsage } from "../plan/usage.js";

export interface ArtifactToolContext {
  layout: Layout;
  capabilities: readonly string[];
  recorder: RunRecorder;
}

const ArtifactParams = Type.Object({
  action: Type.Union(
    [Type.Literal("list"), Type.Literal("show"), Type.Literal("usage"), Type.Literal("create"), Type.Literal("update")],
    { description: "list, show, usage, or a provisioning request." },
  ),
  name: Type.Optional(Type.String({ description: "Artifact name or repo-relative path." })),
  kind: Type.Optional(Type.Union([Type.Literal("tool"), Type.Literal("script")])),
  description: Type.Optional(Type.String()),
  command: Type.Optional(Type.String()),
  tags: Type.Optional(Type.Array(Type.String())),
  force: Type.Optional(Type.Boolean({ description: "Replace an existing tool manifest (create/update)." })),
});

function ok(text: string): AgentToolResult<undefined> {
  return { content: [{ type: "text", text }], details: undefined };
}

function fail(text: string): AgentToolResult<undefined> {
  return { content: [{ type: "text", text }], details: undefined, isError: true };
}

function recordUsage(ctx: ArtifactToolContext, usage: ArtifactUsage): void {
  ctx.recorder.event("artifact_used", { ...usage });
}

function readHead(path: string, max = 4_000): string {
  try {
    const text = readFileSync(path, "utf8");
    return text.length <= max ? text : `${text.slice(0, max)}\n… ${text.length - max} chars omitted`;
  } catch {
    return "";
  }
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

type ArtifactParamsType = Static<typeof ArtifactParams>;

function provisionTool(ctx: ArtifactToolContext, params: ArtifactParamsType, action: "create" | "update"): AgentToolResult<undefined> {
  if (!ctx.capabilities.includes("artifact:provision")) {
    return fail("artifact provisioning requires artifact:provision");
  }
  if (params.kind === "script") {
    return fail("new executable scripts require human approval; use \"machine_code tools new\"");
  }
  const name = params.name?.trim();
  if (!name || !/^[a-z0-9][a-z0-9._-]*$/i.test(name)) {
    return fail("artifact name must match [a-z0-9][a-z0-9._-]*");
  }
  const existing = resolveArtifact(ctx.layout, name);
  if (action === "create" && existing && !params.force) {
    return fail(`artifact ${name} already exists (pass force=true to replace)`);
  }
  if (action === "update" && !existing) return fail(`artifact not found: ${name}`);
  if (existing && (existing.origin !== "repo" || existing.kind !== "tool")) {
    return fail(`artifact ${name} is not an editable repo tool`);
  }
  const file = join(ctx.layout.repoDir, "tools", `${name}.toml`);
  if (action === "create" && existsSync(file) && !params.force) {
    return fail(`tool manifest already exists: ${file} (pass force=true to replace)`);
  }
  const description = params.description ?? existing?.description ?? name;
  const command = params.command ?? existing?.command;
  const tags = params.tags ?? existing?.tags ?? [];
  mkdirSync(join(ctx.layout.repoDir, "tools"), { recursive: true });
  writeFileSync(
    file,
    [
      `name = ${tomlString(name)}`,
      'kind = "tool"',
      `description = ${tomlString(description)}`,
      ...(command ? [`command = ${tomlString(command)}`] : []),
      `tags = ${JSON.stringify(tags)}`,
      "readonly = true",
      "",
    ].join("\n"),
    "utf8",
  );
  ctx.recorder.event("artifact_provisioned", { artifact: name, action, path: file });
  recordUsage(ctx, {
    artifact: name,
    kind: "tool",
    scope: "task",
    issue: ctx.recorder.current.issue,
    runId: ctx.recorder.id,
    role: ctx.recorder.current.agent,
    at: new Date().toISOString(),
    success: true,
    action,
  } as ArtifactUsage);
  return ok(`${action}d tool manifest ${file}`);
}

function usageFor(ctx: ArtifactToolContext, name: string): string {
  const rows: string[] = [];
  for (const run of listAllRuns(ctx.layout.home)) {
    const file = join(layout(run.repoRoot).runsDir, run.id, "events.jsonl");
    let text = "";
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    let count = 0;
    let last = "";
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line) as Record<string, unknown>;
        if (event.type !== "artifact_used" || event.artifact !== name) continue;
        count += 1;
        last = String(event.at ?? event.t ?? "");
      } catch {
        // ignore a torn event line
      }
    }
    if (count > 0) rows.push(`${run.id}  ${count} use(s)${last ? `  last ${last}` : ""}`);
  }
  return rows.length > 0 ? rows.join("\n") : `no recorded usage for ${name}`;
}

export function artifactTool(ctx: ArtifactToolContext): AgentTool<typeof ArtifactParams> {
  return {
    name: "artifact",
    label: "artifact",
    description:
      "Inspect reusable tools and scripts: list, show a manifest/script, or show recorded usage. " +
      "Provisioning requires a human-approved tools command.",
    parameters: ArtifactParams,
    async execute(_id, params: Static<typeof ArtifactParams>) {
      try {
        if (params.action === "list") {
          const artifacts = listArtifacts(ctx.layout);
          if (artifacts.length === 0) return ok("no tools or scripts");
          return ok(
            artifacts
              .map((artifact) => `${artifact.kind.padEnd(6)} ${artifactSummary(artifact).replace(/\n/g, " · ")}`)
              .join("\n"),
          );
        }
        if (params.action === "create" || params.action === "update") {
          return provisionTool(ctx, params, params.action);
        }
        const name = params.name;
        if (!name) return fail(`${params.action} requires name`);
        const artifact = resolveArtifact(ctx.layout, name);
        if (!artifact) return fail(`artifact not found: ${name}`);
        if (params.action === "usage") {
          return ok(usageFor(ctx, artifact.name));
        }
        const path = artifactPath(ctx.layout, artifact);
        recordUsage(ctx, {
          artifact: artifact.name,
          kind: artifact.kind === "script" ? "script" : "tool",
          scope: "task",
          issue: ctx.recorder.current.issue,
          runId: ctx.recorder.id,
          role: ctx.recorder.current.agent,
          at: new Date().toISOString(),
          success: true,
          action: "show",
        } as ArtifactUsage);
        return ok(`${artifactSummary(artifact)}${path ? `\n\n${readHead(path)}` : ""}`);
      } catch (error) {
        return fail(error instanceof Error ? error.message : String(error));
      }
    },
  };
}
