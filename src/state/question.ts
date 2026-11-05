/**
 * machine_code — run inbox: answers and follow-up messages for a run.
 *
 * `ask` suspends a run while it waits on inbox.jsonl; `machine_code respond`
 * (or the TUI) appends answers. One writer per entry — the run process only
 * reads the inbox; responders only append. Answers survive process death, so
 * a resumed run can attach them to the pending ask tool call.
 */
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface InboxEntry {
  seq: number;
  at: string;
  /** Present for answers to a specific question. */
  questionId?: string;
  kind: "answer" | "followup";
  text: string;
  source: string;
}

export function inboxPath(runDir: string): string {
  return join(runDir, "inbox.jsonl");
}

export function readInbox(runDir: string): InboxEntry[] {
  const file = inboxPath(runDir);
  if (!existsSync(file)) return [];
  const out: InboxEntry[] = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (line.trim().length === 0) continue;
    try {
      out.push(JSON.parse(line) as InboxEntry);
    } catch {
      // skip corrupt lines
    }
  }
  return out;
}

/** Append an entry; seq is the 1-based line number (writer-owned append). */
export function appendInbox(
  runDir: string,
  entry: { questionId?: string; kind: "answer" | "followup"; text: string; source: string },
): InboxEntry {
  const seq = readInbox(runDir).length + 1;
  const full: InboxEntry = { seq, at: new Date().toISOString(), ...entry };
  appendFileSync(inboxPath(runDir), JSON.stringify(full) + "\n", "utf8");
  return full;
}

/** Answer for a specific question id, if one exists. */
export function answerFor(runDir: string, questionId: string): InboxEntry | null {
  return readInbox(runDir).find((e) => e.kind === "answer" && e.questionId === questionId) ?? null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Wait for an answer to a question. Rejects when the signal aborts (interrupt,
 * pause, cancel) so the tool returns and the run can transition state.
 */
export async function waitForAnswer(
  runDir: string,
  questionId: string,
  signal?: AbortSignal,
  pollMs = 500,
): Promise<InboxEntry> {
  for (;;) {
    if (signal?.aborted) throw new Error("aborted while awaiting input");
    const found = answerFor(runDir, questionId);
    if (found) return found;
    await sleep(pollMs);
  }
}

export interface QuestionLike {
  questionId?: string;
  text?: string;
  options?: string[];
  t?: string;
}

export interface AnswerLike {
  questionId?: string;
}

/**
 * The latest question that has no answer yet, from an events list.
 * Used by the TUI/CLI to show what a run is waiting on.
 */
export function latestUnansweredQuestion<Q extends QuestionLike, A extends AnswerLike>(
  questions: Q[],
  answers: A[],
): Q | null {
  const answered = new Set(answers.map((a) => a.questionId).filter((v): v is string => typeof v === "string"));
  for (let i = questions.length - 1; i >= 0; i--) {
    const q = questions[i];
    if (q && q.questionId && !answered.has(q.questionId)) return q;
  }
  return null;
}
