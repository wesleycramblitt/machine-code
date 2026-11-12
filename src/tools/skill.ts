/**
 * machine_code — the `skill` tool.
 *
 * On-demand skill bodies: every run sees all skill descriptions up front, and
 * skills in on-demand mode load their SKILL.md body only when the agent
 * decides it needs one. Excluded skills are invisible here, mirroring the
 * composer and the assembled context.
 */
import { Type, type Static } from "typebox";
import { existsSync, readFileSync } from "node:fs";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { join } from "node:path";
import type { Layout } from "../paths.js";
import { packageDataDir } from "../data.js";
import type { RunRecorder } from "../state/runs.js";
import { skillMetas } from "../context/references.js";

export interface SkillToolContext {
  layout: Layout;
  recorder: RunRecorder;
  /** Composer-excluded plus preset-excluded skill names. */
  excluded: ReadonlySet<string>;
}

const SkillParams = Type.Object({
  action: Type.Union([Type.Literal("list"), Type.Literal("show")], {
    description: "list available skills, or show one skill's full body.",
  }),
  name: Type.Optional(Type.String({ description: "Skill name for show." })),
});

function ok(text: string): AgentToolResult<undefined> {
  return { content: [{ type: "text", text }], details: undefined };
}

function fail(text: string): AgentToolResult<undefined> {
  return { content: [{ type: "text", text }], details: undefined, isError: true };
}

function skillBody(layout: Layout, name: string): string | null {
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(name)) return null;
  const dir = join(packageDataDir(), "skills", name);
  const file = join(dir, "SKILL.md");
  if (!existsSync(file)) return null;
  try {
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

const SHOW_CAP = 8 * 1024;

export function skillTool(ctx: SkillToolContext): AgentTool<typeof SkillParams> {
  return {
    name: "skill",
    label: "skill",
    description:
      "Read skill bodies on demand: list shows available skills with descriptions, " +
      "show returns one skill's full instructions. Skill descriptions are already " +
      "in context; call show before following one that needs its body.",
    parameters: SkillParams,
    async execute(_id, params: Static<typeof SkillParams>) {
      try {
        if (params.action === "list") {
          const skills = skillMetas(ctx.layout).filter((skill) => !ctx.excluded.has(skill.name));
          if (skills.length === 0) return ok("no skills available in this run");
          return ok(skills.map((skill) => `${skill.name}: ${skill.description}`).join("\n"));
        }
        const name = params.name?.trim() ?? "";
        if (!name) return fail("show requires a skill name");
        if (ctx.excluded.has(name)) return fail(`skill "${name}" is not available in this run`);
        const body = skillBody(ctx.layout, name);
        if (!body) return fail(`skill not found: ${name}`);
        const text = body.length > SHOW_CAP ? `${body.slice(0, SHOW_CAP)}\n… ${body.length - SHOW_CAP} chars omitted` : body;
        ctx.recorder.event("skill_read", { name });
        return ok(text);
      } catch (error) {
        return fail(error instanceof Error ? error.message : String(error));
      }
    },
  };
}
