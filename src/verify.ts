/**
 * machine_code — acceptance gates (runner-owned).
 *
 * Resolved from the packet plus repo defaults; executed by the runner after
 * Build (or after a Sudo mutation). Model assertions never complete a task.
 * Commands are named, typed manifests dispatched through the command registry
 * — never shell strings.
 */
import { runCommand, type CommandContext } from "./commands/registry.js";
import { readPacket, type TaskPacket } from "./packet.js";
import type { Layout } from "./paths.js";

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

/** Repo default gates when a packet supplies none. */
const DEFAULT_GATES: GateSpec[] = [
  { command: "core:status", args: {}, required: false },
];

export function resolveGates(packet: TaskPacket): GateSpec[] {
  const gates: GateSpec[] = [];
  for (const a of packet.acceptance) {
    gates.push({ command: a.command, args: a.args ?? {}, required: true });
  }
  if (gates.length === 0) gates.push(...DEFAULT_GATES);
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

export function loadPacket(layout: Layout, id: string): TaskPacket | null {
  return readPacket(layout, id);
}
