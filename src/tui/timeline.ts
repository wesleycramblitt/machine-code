/**
 * machine_code — timeline selection and compact event descriptions.
 *
 * Streaming deltas and routine internals are coalesced into the model call or
 * hidden by default, so the timeline shows decisions, tool calls, errors, and
 * outputs instead of every checkpoint. `verbose` restores the raw stream.
 */
export interface TimelineEventLike {
  type?: unknown;
  [key: string]: unknown;
}

/** Routine internals that do not help a human follow the run. */
const NOISE_TYPES = new Set([
  "model_delta",
  "context_ingested",
  "context_state",
  "checkpoint",
  "tools_registered",
  "map_built",
  "map_refresh",
  "map_refresh_scheduled",
  "map_semantic",
  "state_note",
  "state_focus",
  "process_started",
  "process_exited",
  "run_state",
]);

export function isTimelineEvent(event: TimelineEventLike | undefined, verbose = false): boolean {
  if (!event) return false;
  const type = String(event.type);
  if (type === "model_delta") return false;
  if (verbose) return true;
  if (NOISE_TYPES.has(type)) return false;
  // Routine per-call re-selection is noise; the first selection of each
  // attempt and any selection error stay visible.
  if (type === "model_select" && typeof event.call === "number" && event.call > 0 && !event.error) {
    return false;
  }
  return true;
}

export function stepTimelineSelection(
  events: readonly TimelineEventLike[],
  current: number,
  direction: -1 | 1,
  verbose = false,
): number {
  let next = current + direction;
  while (next >= 0 && next < events.length && !isTimelineEvent(events[next], verbose)) next += direction;
  return next >= 0 && next < events.length ? next : current;
}

export function lastTimelineIndex(events: readonly TimelineEventLike[], verbose = false): number {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (isTimelineEvent(events[index], verbose)) return index;
  }
  return -1;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function num(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

function clip(value: string, max: number): string {
  const clean = value.replace(/\s+/g, " ").trim();
  return clean.length <= max ? clean : `${clean.slice(0, Math.max(0, max - 1))}…`;
}

function argsOf(event: TimelineEventLike): string {
  const args = event.args ?? (event as { call?: { args?: unknown } }).call?.args;
  if (args === undefined || args === null) return "";
  try {
    return clip(JSON.stringify(args), 100);
  } catch {
    return "";
  }
}

/** One-line, ANSI-free description for the overview activity tail and CLI. */
export function describeTimelineEvent(event: TimelineEventLike): string {
  const type = String(event.type ?? "event");
  switch (type) {
    case "run_start":
      return `start ${text(event.agent)}${event.mode ? `/${text(event.mode)}` : ""}`;
    case "agent_config":
      return "agent config";
    case "context_assembled":
      return `context ${num(event.chars)} chars`;
    case "model_select":
      return event.error ? `select error ${text(event.error)}` : `select ${text(event.key)}`;
    case "model_request":
      return `input ${num(event.messages)} msg · ${num(event.chars)} chars`;
    case "model_call_end": {
      const usage = (event.usage ?? {}) as { totalTokens?: unknown };
      return `${text(event.provider)}/${text(event.model)} ${text(event.stopReason)} · ${num(usage.totalTokens)} tok`;
    }
    case "tool_call_start":
      return `${text(event.tool)} ${argsOf(event)}`.trim();
    case "tool_call":
      return `${text(event.tool)} ${event.isError ? "ERROR" : "ok"}`;
    case "issue_created":
      return `+ issue #${num(event.number)} ${text(event.kind)} ${text(event.title)}`.trim();
    case "issue_linked":
      return `link #${num(event.issue)} under #${num(event.parent)}`;
    case "plan_updated":
      return `plan #${num(event.issue)} ${text(event.status)}`;
    case "gates":
      return `gates ${event.passed ? "PASS" : "FAIL"}`;
    case "error_classified":
      return `error ${text(event.kind)}`;
    case "malformed_tool_call":
      return `malformed tool call ${text(event.model)}`;
    case "retry":
      return `retry ${text(event.failedModel)}`;
    case "control":
      return `control ${text(event.action)}`;
    case "run_end":
      return `end ${text(event.status)}`;
    case "run_summary":
      return `summary ${text(event.stopReason)}`;
    case "turn_cap":
      return `turn cap ${num(event.turns)}`;
    case "budget_exhausted":
      return `budget exhausted ${num(event.totalTokens)} tok`;
    case "loop_blocked":
      return `loop blocked ${text(event.tool)}`;
    case "child_spawned":
      return `child ${text(event.childRunId).slice(-8)} ${text(event.role)}`;
    case "child_completed":
      return `child ${text(event.childRunId).slice(-8)} ${text(event.status)}`;
    case "build_outcome":
      return `build ${text(event.outcome)}`;
    case "review_verdict":
      return `review ${text(event.verdict)}`;
    default:
      return type;
  }
}
