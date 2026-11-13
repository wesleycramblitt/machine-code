/**
 * machine_code — acceptance gates (runner-owned).
 *
 * Resolved from the issue plus repo defaults; executed by the runner after
 * Build (or after a Sudo mutation). Model assertions never complete a task.
 * Commands are named, typed manifests dispatched through the command registry
 * — never shell strings.
 */
import { runCommand, type CommandContext, type CommandSpec } from "./commands/registry.js";
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

/**
 * Resolve the gate set from the issue's declared acceptance commands.
 * No implicit gates — if the issue has no acceptance list, no gates run
 * and the change is accepted directly. Verified issues add script:test.
 */
export function resolveGates(
  packet: TaskPacket,
  commands?: ReadonlyMap<string, CommandSpec>,
): GateSpec[] {
  const gates: GateSpec[] = [];
  for (const a of packet.acceptance) {
    gates.push({ command: a.command, args: a.args ?? {}, required: true });
  }
  if (gates.length > 0) return gates;
  if (packet.verification === "verified" && commands?.has("script:test")) {
    gates.push({ command: "script:test", args: {}, required: true });
  }
  return gates;
}

/** Capped failure log for the repair pass. Exit code is the contract. */
export function gateFailureText(results: readonly GateResult[]): string {
  return results
    .filter((result) => !result.passed)
    .map((result) => `$ ${result.command}\n${result.output.trim().slice(-3_000) || "(no output)"}`)
    .join("\n\n");
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
