/**
 * machine_code — agent configuration: defaults plus overrides.
 *
 * Each agent role declares its own defaults (approval, ambiguity) in its TOML
 * file. Machine config, repo policy, and run flags layer on top.
 * Only two config fields exist: approval (human|agent) and ambiguity
 * (strict|precise|adaptive|autonomous).
 */
import type { AgentConfigOverrides } from "../config.js";
import {
  AGENT_NAMES,
  agentDef,
  hasModePrompt,
  roleDefaultMode,
  roleDefaults as roleDefaultsData,
  roleModes,
  type AgentDef,
  type AgentName,
} from "../agents.js";
import type { Layout } from "../paths.js";
import { hasRepoScript } from "../plan/issues.js";
import type { CoreToolName } from "../tools/index.js";
import { capabilitiesFor, type Capability } from "../policy/capabilities.js";

export type ApprovalMode = "human" | "agent";
export type AmbiguityMode = "strict" | "precise" | "adaptive" | "autonomous";

export interface AgentConfig {
  approval: ApprovalMode;
  ambiguity: AmbiguityMode;
}

const AMBIGUITIES: readonly AmbiguityMode[] = ["strict", "precise", "adaptive", "autonomous"];

function roleDefaults(name: AgentName): AgentConfig {
  const raw = roleDefaultsData(name);
  return {
    approval: raw.approval === "agent" ? "agent" : "human",
    ambiguity: (AMBIGUITIES as readonly string[]).includes(raw.ambiguity)
      ? (raw.ambiguity as AmbiguityMode)
      : "precise",
  };
}

export interface ResolveInput {
  role: AgentName;
  /** Machine config [agents.<role>] overrides. */
  machineOverrides?: AgentConfigOverrides;
  /** Run-level explicit overrides (CLI flags). */
  runOverrides?: Partial<AgentConfig>;
}

/**
 * Precedence: run flag → repo policy → machine config → role default.
 */
export function resolveAgentConfig(input: ResolveInput): AgentConfig {
  const config: AgentConfig = { ...roleDefaults(input.role) };

  const layers: Array<AgentConfigOverrides | undefined> = [
    machineOverridesToConfig(input.machineOverrides),
  ];
  for (const layer of layers) {
    if (!layer) continue;
    if (layer.approval === "human" || layer.approval === "agent") config.approval = layer.approval as ApprovalMode;
    const a = layer.ambiguity as AmbiguityMode | undefined;
    if (a && (AMBIGUITIES as readonly string[]).includes(a)) config.ambiguity = a;
  }

  // Run-level overrides win over everything.
  if (input.runOverrides) {
    if (input.runOverrides.approval !== undefined) config.approval = input.runOverrides.approval;
    if (input.runOverrides.ambiguity !== undefined) config.ambiguity = input.runOverrides.ambiguity;
  }
  return config;
}

function machineOverridesToConfig(o: AgentConfigOverrides | undefined): AgentConfigOverrides | undefined {
  if (!o) return undefined;
  const hasAny = Object.values(o).some((v) => v !== undefined);
  return hasAny ? { ...o } : undefined;
}

/* ------------------------------------------------------------ ambiguity */

const AMBIGUITY_PROMPTS: Record<AmbiguityMode, string> = {
  strict:
    "Ambiguity policy STRICT: read literally. Ask until every relevant ambiguity is resolved. Do not expand scope.",
  precise:
    "Ambiguity policy PRECISE: resolve low-impact gaps. Ask when a choice materially affects the work.",
  adaptive:
    "Ambiguity policy ADAPTIVE: use context and conventions. Ask on material risk; otherwise decide.",
  autonomous:
    "Ambiguity policy AUTONOMOUS: infer intent. Do not ask. If blocked, stop and report.",
};

const AMBIGUITY_PROMPTS_NO_ASK: Record<AmbiguityMode, string> = {
  strict:
    "Ambiguity policy STRICT: read literally. If a relevant ambiguity blocks the work, stop and report it. Do not expand scope.",
  precise:
    "Ambiguity policy PRECISE: resolve low-impact gaps. If a choice materially affects the work, stop and report the question.",
  adaptive:
    "Ambiguity policy ADAPTIVE: use context and conventions. If a material risk remains, stop and report it.",
  autonomous:
    "Ambiguity policy AUTONOMOUS: infer intent. Do not ask. If blocked, stop and report.",
};

export function ambiguityPrompt(mode: AmbiguityMode, askAvailable = true): string {
  return askAvailable ? AMBIGUITY_PROMPTS[mode] : AMBIGUITY_PROMPTS_NO_ASK[mode];
}

/** `ask` is available in strict/precise/adaptive — never in autonomous. */
export function askEnabled(config: AgentConfig): boolean {
  return config.ambiguity !== "autonomous";
}

/* ------------------------------------------------------ prompt composition */

export function composePrompt(
  def: AgentDef,
  config: AgentConfig,
  tools: readonly CoreToolName[],
): string {
  const ask = askEnabled(config);
  return [
    def.prompt,
    "",
    `Tools: ${tools.length > 0 ? tools.join(", ") : "(none)"}.`,
    ambiguityPrompt(config.ambiguity, ask),
  ].join("\n");
}

/** Resolved agent bundle for a run. */
export interface ResolvedAgent {
  def: AgentDef;
  config: AgentConfig;
  capabilities: string[];
  prompt: string;
}

/**
 * The test contract, branched by issue verification and repo reality. A
 * static guide line cannot branch, so the run injects the exact sentence:
 * direct runs get an unambiguous ban, verified runs get pointed at the skill
 * whose body the harness already inlined. The ban names the repo's test
 * situation outright, so the model never spends calls hunting test files.
 * Only the engineer role writes tests.
 */
export function testPromptLine(
  verification: "direct" | "verified" | undefined,
  hasTests: boolean,
): string | null {
  if (verification === undefined) return null;
  if (verification === "verified") {
    return "This issue is verified: use the verified-testing skill and practice TDD — write the tests with the change. Never run them yourself; the runner executes script:test after finish.";
  }
  return hasTests
    ? "Do not write tests for this issue — code only. Never run test commands; the runner owns verification."
    : "Do not write tests for this issue — code only. This repo has no test runner, so never hunt for test files or test commands; there is nothing to find.";
}

/** Per-tool capability requirements (null = no capability beyond the base allowlist). */
const TOOL_CAPABILITY: Record<CoreToolName, Capability | null> = {
  map: "code:read",
  inspect: "code:read",
  glob: "code:read",
  grep: "code:read",
  write: "code:write",
  edit: "code:write",
  command: null,
  context: null,
  ask: null, // gated by askEnabled(config)
  artifact: "artifact:provision",
  skill: null, // read-only skill bodies; exclusions are enforced inside the tool
  finish: null, // terminal action
};

/**
 * Resolve a role into a run-ready agent: config, capability matrix,
 * capability-gated tool list, and composed prompt.
 */
export function resolveAgent(
  layout: Layout,
  role: AgentName,
  opts: {
    machineOverrides?: AgentConfigOverrides;
    runOverrides?: Partial<AgentConfig>;
    verification?: "direct" | "verified";
    /** Explicit mode; defaults to the verification value when it names a
     * declared mode, else the role default. The mode selects the prompt
     * file: agents/<role>.<mode>.md wins over agents/<role>.md. */
    mode?: string;
    /** Run-level selection floors (CLI --min-fit/--min-capability/--min-axes).
     * Applied onto the role def so pick() and the TUI preview agree. */
    floors?: {
      minFit?: number;
      minCapability?: number;
      minAxes?: Partial<Record<import("../config.js").CapabilityAxis, number>>;
    };
  } = {},
): ResolvedAgent {
  const modes = roleModes(role);
  const mode =
    opts.mode && modes.includes(opts.mode)
      ? opts.mode
      : opts.verification && modes.includes(opts.verification)
        ? opts.verification
        : roleDefaultMode(role);
  const baseDef = agentDef(layout, role, mode);
  const def = opts.floors
    ? {
        ...baseDef,
        ...(opts.floors.minFit !== undefined ? { minFit: opts.floors.minFit } : {}),
        ...(opts.floors.minCapability !== undefined ? { minCapability: opts.floors.minCapability } : {}),
        ...(opts.floors.minAxes ? { minAxes: { ...(baseDef.minAxes ?? {}), ...opts.floors.minAxes } } : {}),
      }
    : baseDef;
  const config = resolveAgentConfig({
    role,
    machineOverrides: opts.machineOverrides,
    runOverrides: opts.runOverrides,
  });
  const capabilities = capabilitiesFor(role, config);
  const capSet = new Set<string>(capabilities);
  let tools = def.tools.filter((t) => {
    if (t === "ask") return askEnabled(config);
    if (t === "write") return capSet.has("code:write") || capSet.has("knowledge:write");
    const needed = TOOL_CAPABILITY[t];
    if (needed && !capSet.has(needed)) return false;
    return true;
  });
  // Read-only roles never hold mutating file tools regardless of capabilities.
  if (def.readonly) tools = tools.filter((t) => t !== "write" && t !== "edit");
  // The terminal action is harness-owned and must survive old role overrides.
  if (!tools.includes("finish")) tools = [...tools, "finish"];
  // A mode-specific prompt file owns its test contract, so the injected
  // line would only duplicate it — skip it and let the prompt speak once.
  const modeOwnsContract = role === "engineer" && mode !== undefined && hasModePrompt(role, mode);
  const testLine =
    modeOwnsContract
      ? null
      : role === "engineer"
        ? testPromptLine(opts.verification, hasRepoScript(layout, "test"))
        : hasRepoScript(layout, "test")
          ? null
          : "This repo has no test runner, so never hunt for test files or test commands.";
  const prompt = composePrompt(def, config, tools) + (testLine ? `\n${testLine}` : "");
  return { def: { ...def, prompt, tools }, config, capabilities, prompt };
}