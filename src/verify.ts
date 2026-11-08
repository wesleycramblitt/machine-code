/**
 * machine_code — acceptance gates (runner-owned).
 *
 * Resolved from the issue plus repo defaults; executed by the runner after
 * Build (or after a Sudo mutation). Model assertions never complete a task.
 * Commands are named, typed manifests dispatched through the command registry
 * — never shell strings.
 */
import { runCommand, type CommandContext } from "./commands/registry.js";
import type { TaskPacket } from "./packet.js";

export interface GateResult {
  command: string;
  args: Record<string, unknown>;
  passed: boolean;
  output: string;
  durationMs: number;
}

export interface GateResolution {
  gates: GateSpec[];
  reason: string;
}

export interface GateSpec {
  command: string;
  args: Record<string, unknown>;
  required: boolean;
}

/** Last-resort gate when the repo has no compile/test profile loaded. */
const STATUS_GATE: GateSpec = { command: "core:status", args: {}, required: false };

const COMPILE_GATES = [
  "typescript:typecheck",
  "typescript:lint",
  "typescript:build",
  "python:typecheck",
  "rust:check",
  "go:build",
] as const;
const TEST_GATES = ["typescript:test", "python:test", "rust:test", "go:test"] as const;

/**
 * Resolve the gate set from the issue's declared `verify` commands. An empty
 * list means the repo defaults: one compile check and one test command when
 * the loaded profiles provide them.
 */
export function resolveGates(
  packet: TaskPacket,
  commands?: ReadonlyMap<string, unknown>,
): GateSpec[] {
  const gates: GateSpec[] = [];
  for (const a of packet.acceptance) {
    gates.push({ command: a.command, args: a.args ?? {}, required: true });
  }
  if (gates.length > 0) return gates;
  if (commands) {
    const compile = COMPILE_GATES.find((name) => commands.has(name));
    const test = TEST_GATES.find((name) => commands.has(name));
    if (compile) gates.push({ command: compile, args: {}, required: true });
    if (test) gates.push({ command: test, args: {}, required: true });
  }
  if (gates.length === 0) gates.push(STATUS_GATE);
  return gates;
}

export async function runGates(
  gates: GateSpec[],
  ctx: CommandContext,
): Promise<{ results: GateResult[]; passed: boolean }> {
  const results: GateResult[] = [];
  for (const gate of gates) {
    const start = Date.now();
    let output = "";
    let isError = true;
    try {
      const result = await runCommand(gate.command, gate.args, ctx);
      output = result.text;
      isError = result.isError;
    } catch (error) {
      output = (error as Error).message;
    }
    results.push({
      command: gate.command,
      args: gate.args,
      passed: !isError,
      output,
      durationMs: Date.now() - start,
    });
  }
  return { results, passed: results.every((r) => r.passed) };
}
