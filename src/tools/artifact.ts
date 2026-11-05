/**
 * machine_code — the `artifact` tool.
 *
 * Inventory for reusable tools and scripts. Tool manifests can be provisioned
 * with `artifact:provision`; executable script creation additionally requires
 * the run's `artifact_scripts` setting (on for implement/unrestricted presets).
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
  /** Human opt-in for executable script creation. */
  allowScripts?: boolean;
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
  script: Type.Optional(Type.String({ description: "Executable script body (kind=script)." })),
  lang: Type.Optional(Type.String({ description: "Script extension, e.g. sh, py, js." })),
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
  const name = params.name?.trim();
  if (!name || !/^[a-z0-9][a-z0-9._-]*$/i.test(name)) {
    return fail("artifact name must match [a-z0-9][a-z0-9._-]*");
  }
  const existing = resolveArtifact(ctx.layout, name);
  if (action === "create" && existing && !params.force) {
    return fail(`artifact ${name} already exists (pass force=true to replace)`);
  }
  if (action === "update" && !existing) return fail(`artifact not found: ${name}`);
  if (existing && existing.origin !== "repo") {
    return fail(`artifact ${name} is not editable from this repository`);
  }
  if (existing && params.kind && existing.kind !== params.kind) {
    return fail(`artifact ${name} is a ${existing.kind}; it cannot be updated as a ${params.kind}`);
  }
  const scriptKind = (params.kind ?? existing?.kind) === "script";
  if (scriptKind && !ctx.allowScripts) {
    return fail("new executable scripts require explicit approval; restart the run with --allow-artifact-scripts");
  }
  const existingExt = existing?.path?.split(".").pop();
  const lang = (params.lang ?? existingExt ?? "sh").replace(/^\./, "");
  if (scriptKind && !/^[a-z0-9]+$/i.test(lang)) return fail("lang must be a simple extension, e.g. sh|py|js");
  const file = join(ctx.layout.repoDir, "tools", `${name}.toml`);
  if (action === "create" && existsSync(file) && !params.force) {
    return fail(`tool manifest already exists: ${file} (pass force=true to replace)`);
  }
  const description = params.description ?? existing?.description ?? name;
  const tags = params.tags ?? existing?.tags ?? [];
  let command = params.command ?? existing?.command;
  if (scriptKind) {
    if (!params.script) return fail("creating a script requires script content");
    const scriptPath = join(ctx.layout.repoDir, "scripts", `${name}.${lang}`);
    if (action === "create" && existsSync(scriptPath) && !params.force) {
      return fail(`script already exists: ${scriptPath} (pass force=true to replace)`);
    }
    mkdirSync(join(ctx.layout.repoDir, "scripts"), { recursive: true });
    writeFileSync(scriptPath, params.script, { encoding: "utf8", mode: 0o755 });
    command = `scripts/${name}.${lang}`;
  }
  const kind = scriptKind ? "script" : "tool";
  mkdirSync(join(ctx.layout.repoDir, "tools"), { recursive: true });
  writeFileSync(
    file,
    [
      `name = ${tomlString(name)}`,
      `kind = ${tomlString(kind)}`,
      `description = ${tomlString(description)}`,
      ...(command ? [`command = ${tomlString(command)}`] : []),
      `tags = ${JSON.stringify(tags)}`,
      "readonly = true",
      "",
    ].join("\n"),
    "utf8",
  );
  ctx.recorder.event("artifact_provisioned", { artifact: name, action, kind, path: file });
  recordUsage(ctx, {
    artifact: name,
    kind,
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
      "Inspect reusable tools and scripts: list, show, usage, create, or update. " +
      "Provisioning needs artifact:provision; new executable scripts also need artifact_scripts.",
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
