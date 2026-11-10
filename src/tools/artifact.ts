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
import { join, relative } from "node:path";
import type { Layout } from "../paths.js";
import { layout } from "../paths.js";
import { runProc } from "../proc.js";
import { COMMAND_CAP_BYTES, capText } from "./safety.js";
import {
  artifactPath,
  artifactSummary,
  listArtifacts,
  resolveArtifact,
  type ArtifactDef,
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
  args: Type.Optional(Type.Array(Type.String(), { description: "Arguments for run." })),
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
  const description = params.description ?? existing?.description ?? name;
  if (scriptKind) {
    if (!params.script) return fail("creating a script requires script content");
    // Scripts are repo-root commands. The file is the configuration; there is
    // no tool manifest and no TOML.
    const scriptPath = join(ctx.layout.repoRoot, "scripts", `${name}.${lang}`);
    if (action === "create" && existsSync(scriptPath) && !params.force) {
      return fail(`script already exists: ${scriptPath} (pass force=true to replace)`);
    }
    const body = params.script;
    const lines = body.split("\n");
    const first = lines[0]?.startsWith("#!") ? lines[1] : lines[0];
    const documented = /^\s*#/.test(first ?? "");
    mkdirSync(join(ctx.layout.repoRoot, "scripts"), { recursive: true });
    const withDescription = documented
      ? body
      : body.startsWith("#!")
        ? `${body.slice(0, body.indexOf("\n") + 1)}# ${description}\n${body.slice(body.indexOf("\n") + 1)}`
        : `# ${description}\n${body}`;
    writeFileSync(scriptPath, withDescription, { encoding: "utf8", mode: 0o755 });
    const rel = relative(ctx.layout.repoRoot, scriptPath).split("\\").join("/");
    ctx.recorder.event("artifact_provisioned", { artifact: name, action, kind: "script", path: rel });
    recordUsage(ctx, {
      artifact: name,
      kind: "script",
      scope: "task",
      runId: ctx.recorder.id,
      role: ctx.recorder.current.agent,
      at: new Date().toISOString(),
      success: true,
      action,
    } as ArtifactUsage);
    return ok(`${action}d script ${rel}`);
  }
  const file = join(ctx.layout.repoDir, "tools", `${name}.toml`);
  if (action === "create" && existsSync(file) && !params.force) {
    return fail(`tool manifest already exists: ${file} (pass force=true to replace)`);
  }
  const tags = params.tags ?? existing?.tags ?? [];
  const command = params.command ?? existing?.command;
  const kind = "tool";
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
    runId: ctx.recorder.id,
    role: ctx.recorder.current.agent,
    at: new Date().toISOString(),
    success: true,
    action,
  } as ArtifactUsage);
  return ok(`${action}d tool manifest ${file}`);
}

function scriptInvocation(path: string, extra: readonly string[]): { binary: string; args: string[] } {
  const ext = path.toLowerCase().split(".").pop() ?? "";
  if (ext === "sh" || ext === "bash") return { binary: "bash", args: [path, ...extra] };
  if (ext === "py") return { binary: "python3", args: [path, ...extra] };
  if (ext === "js" || ext === "mjs" || ext === "cjs") return { binary: "node", args: [path, ...extra] };
  return { binary: path, args: [...extra] };
}

/** Resolve an artifact to an argv: interpreter for scripts, command vector for tools. */
function runInvocation(
  layout: Layout,
  artifact: ArtifactDef,
  extra: readonly string[],
): { binary: string; args: string[] } | null {
  let path = artifactPath(layout, artifact);
  // Older provisioned manifests used "scripts/..." relative to .machine_code.
  if (path && !existsSync(path) && artifact.origin === "repo" && artifact.path) {
    const nested = join(layout.repoDir, artifact.path);
    if (existsSync(nested)) path = nested;
  }
  if (path && existsSync(path) && /\.(sh|bash|py|js|mjs|cjs)$/i.test(path)) {
    return scriptInvocation(path, [...artifact.args, ...extra]);
  }
  const parts = (artifact.command ?? artifact.path ?? "").trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return null;
  return { binary: parts[0]!, args: [...parts.slice(1), ...artifact.args, ...extra] };
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

/** Drop the placeholder fields weak models fill for every schema slot. */
function cleanArtifactArgs(args: unknown): unknown {
  if (!args || typeof args !== "object" || Array.isArray(args)) return args;
  const out = { ...(args as Record<string, unknown>) };
  for (const [key, value] of Object.entries(out)) {
    if (key === "action") continue;
    if (value === null || value === undefined) {
      delete out[key];
      continue;
    }
    if (typeof value === "string" && /^(?:null|undefined|none|n\/a|<empty>)$/i.test(value.trim())) {
      delete out[key];
      continue;
    }
    if (key === "args" && typeof value === "string" && value.trim() !== "") {
      out.args = [value];
      continue;
    }
    if (key === "tags" && typeof value === "string" && value.trim() !== "") {
      out.tags = [value];
    }
  }
  return out;
}

export function artifactTool(ctx: ArtifactToolContext): AgentTool<typeof ArtifactParams> {
  return {
    name: "artifact",
    label: "artifact",
    description:
      "Inspect reusable tools and scripts: list, show, usage, run, create, or update. " +
      "Provisioning needs artifact:provision; new executable scripts also need artifact_scripts. " +
      "run executes the artifact in the worktree and returns bounded output.",
    parameters: ArtifactParams,
    prepareArguments: (args) => cleanArtifactArgs(args) as Static<typeof ArtifactParams>,
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
