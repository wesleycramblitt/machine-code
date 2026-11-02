/**
 * machine_code — settings index.
 *
 * Every setting is surfaced with the file that owns it, so the TUI and CLI can
 * always answer "what do I edit?" instead of hiding state behind a form that
 * only writes a subset of the schema.
 */
import type { Layout } from "../paths.js";
import type { MachineConfig, Policy } from "../config.js";
import { AGENT_META, AGENT_NAMES } from "../agents.js";
import { CAPABILITY_AXES, DEFAULT_THEME } from "../config.js";
import { axisWeights } from "../select.js";
import { listArtifacts } from "../artifacts/registry.js";

export interface SettingRow {
  id: string;
  section: "selection" | "providers" | "agents" | "context" | "map" | "theme" | "artifacts" | "paths" | "environment";
  label: string;
  value: string;
  file?: string;
  detail?: string;
  editable: boolean;
  /** Suggested next value when the TUI cycles a simple setting. */
  choices?: string[];
}

function bool(value: boolean | undefined): string {
  return value === undefined ? "default" : value ? "on" : "off";
}

export function buildSettings(
  layout: Layout,
  machine: MachineConfig | undefined,
  policy: Policy | undefined,
): SettingRow[] {
  const rows: SettingRow[] = [];
  const configFile = layout.machineConfig;
  const policyFile = layout.policyFile;

  if (machine) {
    rows.push({
      id: "selection.tier",
      section: "selection",
      label: "Selection tier",
      value: machine.selection.tier,
      file: configFile,
      detail: "free admits only zero-price rows; paid admits free rows plus funded paid providers.",
      editable: true,
      choices: ["paid", "free"],
    });
    rows.push({
      id: "selection.defaultMode",
      section: "selection",
      label: "Default mode",
      value: machine.defaultMode ?? "(agent default)",
      file: configFile,
      editable: true,
      choices: ["direct", "verified", "redundant"],
    });
    rows.push({
      id: "selection.maxOutput",
      section: "selection",
      label: "Max output tokens",
      value: machine.maxOutputTokens ? String(machine.maxOutputTokens) : "(model max)",
      file: configFile,
      editable: false,
    });
    rows.push({
      id: "selection.priceCaps",
      section: "selection",
      label: "Price caps",
      value: `in $${machine.priceCaps.input ?? "-"}/M  out $${machine.priceCaps.output ?? "-"}/M`,
      file: configFile,
      editable: false,
    });
    for (const [id, provider] of Object.entries(machine.providers).sort(([a], [b]) => a.localeCompare(b))) {
      const bits = [
        provider.funded === undefined ? undefined : `funded ${bool(provider.funded)}`,
        provider.costMultiplier === undefined ? undefined : `×${provider.costMultiplier}`,
      ].filter(Boolean);
      rows.push({
        id: `provider.${id}`,
        section: "providers",
        label: id,
        value: bits.join("  ") || "defaults",
        file: configFile,
        editable: false,
      });
    }
    rows.push({
      id: "context.maxChars",
      section: "context",
      label: "Context budget",
      value: `${machine.context.maxChars.toLocaleString()} chars`,
      file: configFile,
      editable: false,
    });
    rows.push({
      id: "context.planFile",
      section: "context",
      label: "Plan file",
      value: machine.context.planFile ?? "(auto)",
      file: configFile,
      editable: false,
    });
    rows.push({
      id: "map.enabled",
      section: "map",
      label: "Repository map",
      value: bool(machine.map.enabled),
      file: configFile,
      detail: "Deterministic file and symbol map. Always generated when enabled.",
      editable: false,
    });
    rows.push({
      id: "map.semantic",
      section: "map",
      label: "Semantic map",
      value: bool(machine.map.semantic),
      file: configFile,
      detail: "One bounded annotation call on a stale or dirty map.",
      editable: false,
    });
    rows.push({
      id: "map.refresh",
      section: "map",
      label: "Semantic refresh",
      value: machine.map.refresh,
      file: configFile,
      editable: false,
    });
    rows.push({
      id: "map.semanticModel",
      section: "map",
      label: "Semantic model",
      value: machine.map.semanticModel ?? "(auto)",
      file: configFile,
      editable: false,
    });
    rows.push({
      id: "issues.policy",
      section: "context",
      label: "Issue policy",
      value: machine.issues.policy,
      file: configFile,
      detail: `provider ${machine.issues.provider}, cache ${machine.issues.cacheTtlSeconds}s`,
      editable: true,
      choices: ["optional", "required", "disabled"],
    });
    const themeKeys = [
      "header_bg",
      "header_fg",
      "footer_bg",
      "footer_fg",
      "sub_header_bg",
      "sub_header_fg",
      "back_bg",
      "back_fg",
      "section_bg",
      "section_fg",
      "section_active_bg",
      "section_active_fg",
      "tab_active_bg",
      "tab_active_fg",
    ] as const;
    for (const key of themeKeys) {
      rows.push({
        id: `theme.${key}`,
        section: "theme",
        label: key,
        value: machine.theme[key] ?? DEFAULT_THEME[key],
        file: configFile,
        detail: key.endsWith("_bg") ? "background (hex)" : "foreground (hex)",
        editable: true,
      });
    }
  } else {
    rows.push({
      id: "config.error",
      section: "selection",
      label: "Machine config",
      value: "unreadable",
      file: configFile,
      editable: true,
    });
  }

  if (policy) {
    for (const name of AGENT_NAMES) {
      const agent = policy.agents[name];
      if (!agent) continue;
      const weights = axisWeights(name, agent);
      const top = CAPABILITY_AXES.map((axis) => [axis, weights[axis]] as const)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([axis, value]) => `${axis} ${value.toFixed(2)}`)
        .join(", ");
      rows.push({
        id: `agent.${name}`,
        section: "agents",
        label: name,
        value: `fit≥${agent.minFit}  ctx≥${agent.minContext}  out≈${agent.expectedOutputTokens}`,
        file: policyFile,
        detail: `weights ${top} · modes ${(AGENT_META[name]?.modes ?? []).join(", ") || "single"}`,
        editable: true,
        choices: ["role policy"],
      });
    }
  }

  for (const artifact of listArtifacts(layout)) {
    rows.push({
      id: `artifact.${artifact.name}`,
      section: "artifacts",
      label: `${artifact.kind} ${artifact.name}`,
      value: artifact.description || artifact.command || artifact.path || "(no description)",
      file: artifact.origin === "repo" ? `${layout.repoRoot}/${artifact.source}` : artifact.source,
      detail: artifact.command ?? artifact.path,
      editable: true,
    });
  }

  rows.push(
    { id: "path.home", section: "paths", label: "Machine home", value: layout.home, file: layout.home, editable: false },
    { id: "path.repo", section: "paths", label: "Repository", value: layout.repoRoot, file: layout.repoRoot, editable: false },
    { id: "path.config", section: "paths", label: "Machine config", value: layout.machineConfig, file: layout.machineConfig, editable: true },
    { id: "path.policy", section: "paths", label: "Repo policy", value: layout.policyFile, file: layout.policyFile, editable: true },
    { id: "path.catalogue", section: "paths", label: "Catalogue", value: layout.catalogueFile, file: layout.catalogueFile, editable: false },
    { id: "path.tools", section: "paths", label: "Repo tools", value: `${layout.repoDir}/tools`, file: `${layout.repoDir}/tools`, editable: false },
    { id: "path.scripts", section: "paths", label: "Repo scripts", value: `${layout.repoDir}/scripts`, file: `${layout.repoDir}/scripts`, editable: false },
    { id: "path.spend", section: "paths", label: "Spend ledger", value: `${layout.home}/spend.jsonl`, file: `${layout.home}/spend.jsonl`, editable: false },
  );

  rows.push(
    {
      id: "env.openrouter",
      section: "environment",
      label: "OPENROUTER_API_KEY",
      value: process.env.OPENROUTER_API_KEY ? "set" : "unset",
      editable: false,
    },
    {
      id: "env.opencode",
      section: "environment",
      label: "OPENCODE_API_KEY",
      value: process.env.OPENCODE_API_KEY ? "set" : "unset",
      editable: false,
    },
    {
      id: "env.openai",
      section: "environment",
      label: "OPENAI_API_KEY",
      value: process.env.OPENAI_API_KEY ? "set" : "unset",
      editable: false,
    },
    {
      id: "env.anthropic",
      section: "environment",
      label: "ANTHROPIC_API_KEY",
      value: process.env.ANTHROPIC_API_KEY ? "set" : "unset",
      editable: false,
    },
  );

  return rows;
}

export function settingsFileFor(layout: Layout, row: SettingRow | undefined): string | null {
  if (!row) return null;
  if (row.file) return row.file;
  if (row.section === "agents") return layout.policyFile;
  return layout.machineConfig;
}
