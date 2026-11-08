/**
 * machine_code — the internal task spec passed from an issue to the runner.
 *
 * This is a runtime shape, not a file format: issue files are the work tree,
 * and their `verify` list becomes `acceptance`.
 */
export type PacketMode = string;

export interface PacketAcceptance {
  command: string; // named command, e.g. typescript:test
  args?: Record<string, unknown>;
}

export interface TaskPacket {
  id: string;
  /** Omitted for a single-agent run. */
  mode?: PacketMode;
  agent?: "research" | "engineer" | "review";
  budget_tokens?: number;
  goal: string;
  context: string[];
  constraints: string[];
  acceptance: PacketAcceptance[];
}
