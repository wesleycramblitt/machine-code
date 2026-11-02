/**
 * Phase 2 tests: transcript checkpoints/pruning/repair, the question inbox,
 * the ask tool, fork lineage, and run reopening (resume).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  saveTranscript,
  loadTranscript,
  pruneTranscript,
  repairResumeTail,
  transcriptChars,
} from "../dist/state/transcript.js";
import { appendInbox, readInbox, latestUnansweredQuestion, waitForAnswer } from "../dist/state/question.js";
import { askTool } from "../dist/tools/ask.js";
import { RunRecorder, sendControl, readRun } from "../dist/state/runs.js";

function fakeLayout(root) {
  return {
    home: join(root, "home"),
    machineConfig: "",
    curation: "",
    catalogueFile: "",
    repoRoot: root,
    repoDir: join(root, ".machine_code"),
    localDir: join(root, ".machine_code", "local"),
    policyFile: "",
    runsDir: join(root, ".machine_code", "local", "runs"),
  };
}

function tempDir(prefix) {
  return mkdtempSync(join(tmpdir(), `mc-lc-${prefix}-`));
}

const user = (text) => ({ role: "user", content: text, timestamp: 1 });
const assistant = (text) => ({ role: "assistant", content: [{ type: "text", text }], timestamp: 2, stopReason: "stop" });
const toolCallMsg = (id, name, args) => ({
  role: "assistant",
  content: [{ type: "toolCall", id, name, arguments: args }],
  timestamp: 3,
  stopReason: "toolUse",
});
const toolResult = (id, name, text, isError = false) => ({
  role: "toolResult",
  toolCallId: id,
  toolName: name,
  content: [{ type: "text", text }],
  isError,
  timestamp: 4,
});

/* ----------------------------------------------------------- transcript */

test("transcript save/load round-trips atomically", () => {
  const dir = tempDir("tr");
  try {
    const messages = [{ role: "system", content: "sys" }, user("hello"), assistant("hi")];
    saveTranscript(dir, { agent: "general", request: "hello", messages });
    const loaded = loadTranscript(dir);
    assert.ok(loaded);
    assert.equal(loaded.agent, "general");
    assert.equal(loaded.request, "hello");
    assert.equal(loaded.messages.length, 3);
    assert.ok(!readdirHasTmp(dir));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function readdirHasTmp(dir) {
  for (const name of readdirSync(dir)) if (name.endsWith(".tmp")) return true;
  return false;
}

test("pruneTranscript drops oldest whole turns and inserts a deterministic summary", () => {
  const messages = [
    { role: "system", content: "system prompt" },
    user("original request"),
    assistant("first answer"),
    user("turn two " + "x".repeat(1500)),
    assistant("second answer " + "y".repeat(1500)),
    user("turn three " + "z".repeat(1500)),
    assistant("final answer"),
  ];
  const { messages: pruned, droppedTurns } = pruneTranscript(messages, 2000);
  assert.ok(droppedTurns > 0);
  // Leading system + first user survive.
  assert.equal(pruned[0].role, "system");
  assert.equal(pruned[1].role, "user");
  assert.equal(pruned[1].content, "original request");
  // A summary system message follows the kept head.
  const summary = pruned.find((m) => m.role === "system" && String(m.content).startsWith("[transcript summary]"));
  assert.ok(summary, "summary message inserted");
  assert.ok(String(summary.content).includes("user: turn two"));
  // The newest turn survives.
  assert.equal(pruned[pruned.length - 1].content[0].text, "final answer");
  // Under budget: unchanged.
  const same = pruneTranscript(messages, 1_000_000);
  assert.equal(same.droppedTurns, 0);
  assert.equal(same.messages, messages);
});

test("repairResumeTail answers pending ask calls and marks interrupted tools", () => {
  // ask tool call with a recorded answer
  const withAsk = [user("q"), toolCallMsg("t1", "ask", { question: "which solver?" })];
  const r1 = repairResumeTail(withAsk, (q) => (q === "which solver?" ? "use leapfrog" : null));
  assert.equal(r1.repaired.length, 1);
  assert.equal(r1.repaired[0].answered, true);
  const result1 = r1.messages[r1.messages.length - 1];
  assert.equal(result1.role, "toolResult");
  assert.equal(result1.toolCallId, "t1");
  assert.equal(result1.isError, false);
  assert.equal(result1.content[0].text, "use leapfrog");

  // ask without an answer -> error result
  const r2 = repairResumeTail(withAsk, () => null);
  assert.equal(r2.messages[r2.messages.length - 1].isError, true);

  // non-ask tool call -> explicit interruption error
  const withTool = [user("q"), toolCallMsg("t2", "command", { name: "core:status" })];
  const r3 = repairResumeTail(withTool, () => null);
  const result3 = r3.messages[r3.messages.length - 1];
  assert.equal(result3.isError, true);
  assert.match(result3.content[0].text, /interrupted before this tool result/);

  // terminal assistant text -> resume prompt appended
  const r4 = repairResumeTail([user("q"), assistant("partial work")], () => null);
  assert.equal(r4.appendedResumePrompt, true);
  assert.equal(r4.messages[r4.messages.length - 1].role, "user");

  // aborted ask: an error result gets the real answer reattached
  const aborted = [
    user("q"),
    toolCallMsg("t9", "ask", { question: "which?" }),
    toolResult("t9", "ask", "awaiting input ended: aborted while awaiting input", true),
    { role: "assistant", content: [], timestamp: 5 },
  ];
  const r6 = repairResumeTail(aborted, (q) => (q === "which?" ? "the answer" : null));
  const reattached = r6.messages.find((m) => m.role === "toolResult" && m.toolCallId === "t9");
  assert.equal(reattached.isError, false);
  assert.equal(reattached.content[0].text, "the answer");
  // the empty assistant shell after it is dropped, tail stays continuable
  assert.equal(r6.messages[r6.messages.length - 1].role, "toolResult");
  assert.equal(r6.appendedResumePrompt, false);

  // repeated resumes do not stack resume prompts: empty assistant shells are
  // dropped, and a continuable tail (user) needs no prompt at all
  const once = repairResumeTail([user("q"), { role: "assistant", content: [], timestamp: 5 }], () => null);
  assert.equal(once.appendedResumePrompt, false, "empty shell dropped; user tail is continuable");
  assert.equal(once.messages.length, 1);
  const twice = repairResumeTail(once.messages, () => null);
  assert.equal(twice.appendedResumePrompt, false, "no duplicate resume prompt");
  assert.equal(
    twice.messages.filter((m) => m.role === "user" && m.content === "The run was interrupted. Pick up exactly where you left off and finish the work.").length,
    0,
  );

  // toolResult tail -> nothing to do
  const r5 = repairResumeTail([user("q"), toolCallMsg("t3", "read", { path: "a" }), toolResult("t3", "read", "x")], () => null);
  assert.equal(r5.repaired.length, 0);
  assert.equal(r5.appendedResumePrompt, false);
  assert.equal(r5.messages.length, 3);
});

/* -------------------------------------------------------------- question */

test("inbox: append/read/seq and latestUnansweredQuestion", () => {
  const dir = tempDir("inbox");
  try {
    assert.deepEqual(readInbox(dir), []);
    const a = appendInbox(dir, { questionId: "q1", kind: "answer", text: "first", source: "cli" });
    const b = appendInbox(dir, { questionId: "q2", kind: "answer", text: "second", source: "tui" });
    assert.equal(a.seq, 1);
    assert.equal(b.seq, 2);
    const all = readInbox(dir);
    assert.equal(all.length, 2);
    assert.equal(all[1].text, "second");

    const pending = latestUnansweredQuestion(
      [{ questionId: "q1" }, { questionId: "q2" }, { questionId: "q3" }],
      all,
    );
    assert.equal(pending.questionId, "q3");
    assert.equal(latestUnansweredQuestion([{ questionId: "q1" }], all), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("waitForAnswer resolves when the answer lands and rejects on abort", async () => {
  const dir = tempDir("wait");
  try {
    const pending = waitForAnswer(dir, "q9");
    appendInbox(dir, { questionId: "q9", kind: "answer", text: "42", source: "cli" });
    const answer = await pending;
    assert.equal(answer.text, "42");

    const controller = new AbortController();
    const waiting = waitForAnswer(dir, "q10", controller.signal, 20);
    setTimeout(() => controller.abort(), 50);
    await assert.rejects(waiting, /aborted/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------- ask tool */

test("askTool suspends, records the question, and returns the inbox answer", async () => {
  const root = tempDir("ask");
  const layout = fakeLayout(root);
  const recorder = new RunRecorder(layout, { agent: "general", mode: "", request: "r", repoRoot: root });
  let questionId = null;
  try {
    // The loop provides the suspension hook; it checkpoints the transcript
    // with the pending ask tool call as the tail.
    const pendingTail = [toolCallMsg("t-ask", "ask", { question: "Which format?" })];
    const tool = askTool({
      runDir: recorder.dir,
      recorder,
      suspend: () => saveTranscript(recorder.dir, { agent: "general", request: "r", messages: pendingTail }),
    });
    const execution = tool.execute("call-1", { question: "Which format?" });

    // The run flips to awaiting_input and the question event lands.
    await new Promise((r) => setTimeout(r, 120));
    assert.equal(recorder.current.status, "awaiting_input");
    const events = readFileSync(join(recorder.dir, "events.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const question = events.find((e) => e.type === "question");
    assert.ok(question);
    assert.equal(question.text, "Which format?");
    questionId = question.questionId;
    // The suspension checkpoint exists with the pending ask as the tail.
    const tr = loadTranscript(recorder.dir);
    assert.ok(tr, "suspension checkpoint saved");
    assert.equal(tr.messages[tr.messages.length - 1].content[0].name, "ask");

    appendInbox(recorder.dir, { questionId, kind: "answer", text: "JSON", source: "cli" });
    const result = await execution;
    assert.equal(result.isError, undefined);
    assert.equal(result.content[0].text, "JSON");
    assert.equal(recorder.current.status, "running");
  } finally {
    // Never leave the poll loop alive: answer or fail it.
    if (questionId) {
      appendInbox(recorder.dir, { questionId, kind: "answer", text: "(test cleanup)", source: "cli" });
    }
    recorder.finalize("completed");
    rmSync(root, { recursive: true, force: true });
  }
});

test("askTool returns an error result when the wait is aborted", async () => {
  const root = tempDir("ask-abort");
  const layout = fakeLayout(root);
  const recorder = new RunRecorder(layout, { agent: "general", mode: "", request: "r", repoRoot: root });
  try {
    const controller = new AbortController();
    const tool = askTool({ runDir: recorder.dir, recorder });
    const execution = tool.execute("call-1", { question: "hello?" }, controller.signal);
    await new Promise((r) => setTimeout(r, 80));
    controller.abort();
    const result = await execution;
    assert.equal(result.isError, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/* -------------------------------------------------- fork lineage + reopen */

test("RunRecorder records fork lineage and can be reopened for resume", () => {
  const root = tempDir("lineage");
  const layout = fakeLayout(root);
  try {
    const parent = new RunRecorder(layout, { agent: "architect", mode: "", request: "parent", repoRoot: root });
    parent.finalize("completed");

    const child = new RunRecorder(layout, {
      agent: "build",
      mode: "verified",
      request: "child objective",
      repoRoot: root,
      parentRunId: parent.id,
      rootRunId: parent.id,
      forkReason: "manual",
    });
    assert.equal(child.current.parentRunId, parent.id);
    assert.equal(child.current.rootRunId, parent.id);
    assert.equal(child.current.forkReason, "manual");
    child.finalize("completed");

    const reopened = RunRecorder.reopen(layout, child.current);
    assert.equal(reopened.id, child.id);
    reopened.setStatus("running", "resume");
    assert.equal(reopened.current.status, "running");
    reopened.finalize("completed");
    const reread = readRun(layout, child.id);
    assert.equal(reread.summary.status, "completed");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("sendControl writes a sequenced request and bumps from the ack", () => {
  const root = tempDir("control");
  const layout = fakeLayout(root);
  const recorder = new RunRecorder(layout, { agent: "general", mode: "", request: "r", repoRoot: root });
  try {
    const seq1 = sendControl(root, recorder.id, "pause");
    assert.equal(seq1, 1);
    const control = JSON.parse(readFileSync(join(recorder.dir, "control"), "utf8"));
    assert.equal(control.action, "pause");
    assert.equal(control.seq, 1);
    // Simulate the owner acking.
    writeFileSync(join(recorder.dir, "control.ack"), JSON.stringify({ seq: 1, acked: true }), "utf8");
    const seq2 = sendControl(root, recorder.id, "cancel");
    assert.equal(seq2, 2);
  } finally {
    recorder.finalize("completed");
    rmSync(root, { recursive: true, force: true });
  }
});

test("contextUsage prefers recorded values and falls back to events", async () => {
  const { contextUsage } = await import("../dist/report/run.js");
  const events = [
    { type: "model_request", chars: 4_000 },
    { type: "model_call_end", usage: { input: 900, cacheRead: 100 } },
    { type: "model_request", chars: 8_000 },
    { type: "model_call_end", usage: { input: 0, cacheRead: 0 } },
  ];
  const fallback = contextUsage({}, events);
  assert.equal(fallback.chars, 8_000);
  assert.equal(fallback.tokens, 1_000);
  assert.equal(fallback.peakTokens, 2_000);
  const recorded = contextUsage(
    { contextChars: 6_000, contextTokens: 1_500, peakContextTokens: 2_500 },
    events,
  );
  assert.equal(recorded.chars, 6_000);
  assert.equal(recorded.tokens, 1_500);
  assert.equal(recorded.peakTokens, 2_500);
});
