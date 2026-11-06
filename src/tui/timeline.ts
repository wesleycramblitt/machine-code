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


/**
 * One-line human summary of tool args: paths, queries, and actions instead
 * of a raw JSON blob. Used for collapsed timeline previews and compact
 * one-line descriptions.
 */
export function describeToolArgs(tool: string, args: Record<string, unknown> | null | undefined): string {
  if (!args) return "";
  const str = (value: unknown): string | undefined =>
    typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
  const num = (value: unknown): number | undefined =>
    typeof value === "number" && Number.isFinite(value) ? value : undefined;
  switch (tool) {
    case "read": {
      const path = str(args.path) ?? "?";
      const target =
        str(args.symbol) ??
        (Array.isArray(args.symbols) ? args.symbols.map(String).join(",") : undefined) ??
        str(args.section) ??
        (num(args.around) !== undefined ? `around ${num(args.around)}` : undefined) ??
        (num(args.offset) !== undefined || num(args.limit) !== undefined
          ? `${num(args.offset) ?? 1}:${num(args.limit) ?? "…"}`
          : undefined);
      return target ? `${path}#${target}` : path;
    }
    case "write": {
      const bytes = typeof args.content === "string" ? args.content.length : 0;
      const size = bytes >= 1024 ? `${(bytes / 1024).toFixed(1)} KiB` : `${bytes}b`;
      return `${str(args.path) ?? "?"} (${size})`;
    }
    case "edit": {
      const hunks = Array.isArray(args.edits) ? args.edits.length : args.oldString !== undefined ? 1 : 0;
      return `${str(args.path) ?? "?"}${hunks > 1 ? ` · ${hunks} hunks` : ""}`;
    }
    case "search": {
      const bits = [
        str(args.pattern) ? `"${str(args.pattern)}"` : "",
        str(args.mode) && str(args.mode) !== "auto" ? str(args.mode)! : "",
        str(args.path) ?? "",
      ].filter(Boolean);
      return bits.join(" ") || "…";
    }
    case "command":
      return [str(args.action) ?? "run", str(args.name) ?? ""].filter(Boolean).join(" ");
    case "context":
      return [str(args.action) ?? "", str(args.text) ?? str(args.target) ?? str(args.id) ?? ""].filter(Boolean).join(" ");
    case "ask":
      return str(args.question) ?? "";
    case "issue":
      return [str(args.action) ?? "", str(args.issue) ?? str(args.kind) ?? ""].filter(Boolean).join(" ");
    case "artifact":
      return [str(args.action) ?? "", str(args.name) ?? str(args.kind) ?? ""].filter(Boolean).join(" ");
    case "skill":
      return [str(args.action) ?? "", str(args.name) ?? ""].filter(Boolean).join(" ");
    case "pr":
      return [str(args.action) ?? "", num(args.number) !== undefined ? `#${num(args.number)}` : str(args.title) ?? ""].filter(Boolean).join(" ");
    default: {
      const bits: string[] = [];
      for (const key of ["path", "name", "pattern", "query", "question", "command", "action", "target", "ref", "anchor", "file", "issue"]) {
        const value = args[key];
        if (typeof value === "string" && value.trim()) bits.push(value.trim());
        else if (typeof value === "number" && Number.isFinite(value)) bits.push(String(value));
        if (bits.join(" ").length > 80) break;
      }
      return bits.join(" ");
    }
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
    case "tool_call_start": {
      const human = describeToolArgs(text(event.tool), (event.args ?? (event as { call?: { args?: unknown } }).call?.args) as Record<string, unknown> | undefined);
      return human ? `${text(event.tool)} ${human}` : text(event.tool);
    }
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
      return event.reason === "no-progress"
        ? "loop blocked no progress"
        : event.reason === "next-required"
          ? "loop blocked no next action"
          : event.reason === "plan-required"
            ? "loop blocked no build plan"
            : `loop blocked ${text(event.tool)}`;
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

/** What an active run is currently waiting on, for the run-details header. */
export interface WaitingState {
  kind: "model" | "tool" | "process" | "child" | "input" | "paused" | "starting" | "working";
  /** Human noun: "model p/m", "tool search …", "process …", "working", … */
  label: string;
  /** ISO timestamp the wait started (the causing event, or last activity). */
  since: string;
  /** True when stream deltas arrived after the open request (tokens flowing). */
  streaming?: boolean;
}

const TERMINAL_RUN_STATUSES = new Set(["completed", "blocked", "failed", "cancelled"]);

function eventTime(value: unknown): string {
  return typeof value === "string" && value.length > 0 ? value : "";
}

/**
 * Derive what a run is waiting on from its status and event stream.
 *
 * Open markers win: the most recent uncompleted `model_request`,
 * `tool_call_start`, `process_started`, or `child_spawned` names the wait.
 * With no open marker a running run is still busy between steps
 * (`working`); terminal runs return null. Pass `hasPendingQuestion` from the
 * TUI's inbox check so an unanswered `ask` reads as waiting on the human.
 */
export function waitingForRun(
  summary: { status?: unknown; lastActivityAt?: unknown },
  events: readonly TimelineEventLike[],
  opts?: { hasPendingQuestion?: boolean },
): WaitingState | null {
  const status = String(summary.status ?? "");
  if (TERMINAL_RUN_STATUSES.has(status)) return null;
  const fallbackSince =
    eventTime(summary.lastActivityAt) ||
    eventTime(events.length > 0 ? events[events.length - 1]?.t : "") ||
    new Date().toISOString();

  if (opts?.hasPendingQuestion || status === "awaiting_input") {
    let since = "";
    for (let i = events.length - 1; i >= 0; i -= 1) {
      if (String(events[i]?.type) === "question") {
        since = eventTime(events[i]?.t);
        break;
      }
    }
    return { kind: "input", label: "your answer", since: since || fallbackSince };
  }
  if (status === "paused" || status === "interrupted") {
    return { kind: "paused", label: status, since: fallbackSince };
  }

  const completedTools = new Set<string>();
  const completedModels = new Set<string>();
  const exitedProcesses = new Set<string>();
  const completedChildren = new Set<string>();
  for (const event of events) {
    const type = String(event.type ?? "");
    if (type === "tool_call") {
      const id = event.toolCallId;
      if (typeof id === "string" && id) completedTools.add(id);
      else if (typeof id === "number") completedTools.add(String(id));
    } else if (type === "model_call_end") {
      const call = (event as { call?: unknown }).call;
      if (typeof call === "number" || typeof call === "string") completedModels.add(String(call));
    } else if (type === "process_exited" || type === "process_killed") {
      const id = (event as { processId?: unknown }).processId;
      if (typeof id === "string" && id) exitedProcesses.add(id);
      else if (typeof id === "number") exitedProcesses.add(String(id));
    } else if (type === "child_completed") {
      const id = (event as { childRunId?: unknown }).childRunId;
      if (typeof id === "string" && id) completedChildren.add(id);
    }
  }
  // Starts without an id still count as open when no completion of that
  // kind follows them.
  let toolCallAfter = false;
  const toolOpenFrom: boolean[] = new Array(events.length).fill(false);
  for (let i = events.length - 1; i >= 0; i -= 1) {
    if (String(events[i]?.type) === "tool_call") toolCallAfter = true;
    if (String(events[i]?.type) === "tool_call_start") toolOpenFrom[i] = !toolCallAfter;
  }

  const streamingCalls = new Set<string>();
  for (const event of events) {
    if (String(event.type ?? "") !== "model_delta") continue;
    const call = (event as { call?: unknown }).call;
    if (typeof call === "number" || typeof call === "string") {
      if (!completedModels.has(String(call))) streamingCalls.add(String(call));
    }
  }

  let open: { index: number; kind: WaitingState["kind"]; label: string; since: string; streaming?: boolean } | null = null;
  for (let i = 0; i < events.length; i += 1) {
    const event = events[i]!;
    const type = String(event.type ?? "");
    const t = eventTime(event.t) || fallbackSince;
    if (type === "tool_call_start") {
      const rawId = (event as { toolCallId?: unknown }).toolCallId;
      const id = typeof rawId === "string" ? rawId : typeof rawId === "number" ? String(rawId) : "";
      const isOpen = id ? !completedTools.has(id) : toolOpenFrom[i];
      if (!isOpen) continue;
      const tool = text(event.tool) || "tool";
      const args = (event.args ?? (event as { call?: { args?: unknown } }).call?.args) as Record<string, unknown> | undefined;
      const human = args ? describeToolArgs(tool, args) : "";
      const candidate = {
        index: i,
        kind: "tool" as const,
        label: human ? `tool ${tool} ${human}` : `tool ${tool}`,
        since: t,
      };
      if (!open || candidate.index > open.index) open = candidate;
    } else if (type === "model_request") {
      const call = (event as { call?: unknown }).call;
      const key = typeof call === "number" || typeof call === "string" ? String(call) : "";
      if (key && completedModels.has(key)) continue;
      const provider = text(event.provider);
      const model = text(event.model);
      const name = provider || model ? `${provider}${provider && model ? "/" : ""}${model}` : "model";
      const candidate = {
        index: i,
        kind: "model" as const,
        label: `model ${name}`,
        since: t,
        streaming: key ? streamingCalls.has(key) : undefined,
      };
      if (!open || candidate.index > open.index) open = candidate;
    } else if (type === "process_started") {
      const rawId = (event as { processId?: unknown }).processId;
      const id = typeof rawId === "string" ? rawId : typeof rawId === "number" ? String(rawId) : "";
      if (id && exitedProcesses.has(id)) continue;
      const name = text((event as { name?: unknown }).name) || (id ? `process ${id.slice(-8)}` : "process");
      const candidate = { index: i, kind: "process" as const, label: `process ${name}`, since: t };
      if (!open || candidate.index > open.index) open = candidate;
    } else if (type === "child_spawned") {
      const rawId = (event as { childRunId?: unknown }).childRunId;
      const id = typeof rawId === "string" ? rawId : "";
      if (id && completedChildren.has(id)) continue;
      const role = text((event as { role?: unknown }).role);
      const candidate = {
        index: i,
        kind: "child" as const,
        label: `child ${role ? `${role} ` : ""}${id ? id.slice(-8) : ""}`.trim(),
        since: t,
      };
      if (!open || candidate.index > open.index) open = candidate;
    }
  }
  if (open) return { kind: open.kind, label: open.label, since: open.since, streaming: open.streaming };

  if (events.length === 0 || status === "created") {
    return { kind: "starting", label: "starting", since: fallbackSince };
  }
  let last: TimelineEventLike | null = null;
  for (let i = events.length - 1; i >= 0; i -= 1) {
    if (isTimelineEvent(events[i], true)) {
      last = events[i]!;
      break;
    }
  }
  const since = (last && eventTime(last.t)) || fallbackSince;
  return { kind: "working", label: "working", since };
}
