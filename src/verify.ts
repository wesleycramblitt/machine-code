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
  /** Stop the gate sequence when this gate fails (later gates would run on a
   * tree that is not ready, e.g. build after an unresolved sync conflict). */
  stopOnFailure?: boolean;
}

/** Runner-owned gate that merges the base branch into the worktree before
 * build/test. It is injected by the run paths, not declared in the issue. */
export const SYNC_GATE: GateSpec = {
  command: "vcs:sync",
  args: {},
  required: true,
  stopOnFailure: true,
};

/** Put the sync gate first: build/test must run on the tree that will land. */
export function withSyncGate(gates: readonly GateSpec[], baseBranch?: string): GateSpec[] {
  return [{ ...SYNC_GATE, args: baseBranch ? { base: baseBranch } : {} }, ...gates];
}

/**
 * Resolve the gate set from the issue's declared acceptance commands.
 * Only the issue's explicit acceptance list is used. No implicit gates.
 * If the issue has no acceptance, the change completes directly.
 */
export function resolveGates(
  packet: TaskPacket,
  _commands?: ReadonlyMap<string, CommandSpec>,
): GateSpec[] {
  return packet.acceptance.map((a) => ({ command: a.command, args: a.args ?? {}, required: true }));
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
    if (isError && gate.stopOnFailure) break;
  }
  return { results, passed: results.every((r) => r.passed) };
}
