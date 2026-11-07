/**
 * machine_code — tool-definition accounting.
 *
 * Tool definitions are sent with every provider request: name, description,
 * and the JSON schema for the arguments. They are input tokens even though
 * they are not conversation context. Keep one estimator so model selection,
 * the event log, and the TUI agree on their cost.
 */
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { coreTools, type CoreToolName, type ToolContext } from "./index.js";

/**
 * Tool construction does not read context fields; only `execute` does. A
 * throwaway context lets us build the exact schemas without touching disk,
 * the network, or a run.
 */
const SCHEMA_CONTEXT = {
  root: "",
  commands: new Map(),
  ask: {},
  task: {},
  artifacts: {},
  prs: {},
} as unknown as ToolContext;

/** Approximate the provider's per-tool JSON envelope. */
function toolWireChars(tool: AgentTool): number {
  return JSON.stringify({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      strict: false,
    },
  }).length;
}

function builtTools(names: readonly CoreToolName[]): AgentTool[] {
  return coreTools(SCHEMA_CONTEXT, names).filter((tool): tool is AgentTool => Boolean(tool));
}

export function toolDefinitionChars(tools: readonly AgentTool[]): number {
  return tools.filter((tool): tool is AgentTool => Boolean(tool)).reduce((sum, tool) => sum + toolWireChars(tool), 0);
}

/** Schema characters for the core tools a run will send. */
export function toolSchemaChars(names: readonly CoreToolName[]): number {
  return toolDefinitionChars(builtTools(names));
}

/** Per-tool schema characters, keyed by tool name. */
export function toolSchemaCharsByName(names: readonly CoreToolName[]): Map<string, number> {
  return new Map(builtTools(names).map((tool) => [tool.name, toolWireChars(tool)]));
}
