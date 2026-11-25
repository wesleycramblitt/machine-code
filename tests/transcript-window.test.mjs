/**
 * Transcript window: recent steps stay whole, older prose survives on a budget.
 *
 * Old tool traffic must not be kept (evidence re-serves reads, fresher from
 * disk), but the conversation — narration, questions, answers — is worth more
 * than two steps, so it is retained while it fits its share.
 *
 * No network or provider calls. Run with: npm test
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { renderPromptMessages, keptToolCallIds } from "../dist/context/render.js";

function assistantText(text) {
  return { role: "assistant", content: [{ type: "text", text }], timestamp: 1 };
}
function assistantCall(id, name = "inspect", args = { query: "a.ts" }) {
  return { role: "assistant", content: [{ type: "toolCall", id, name, arguments: args }], timestamp: 1 };
}
function toolResult(id, text) {
  return { role: "toolResult", toolCallId: id, toolName: "inspect", content: [{ type: "text", text }], timestamp: 1 };
}
function user(text) {
  return { role: "user", content: [{ type: "text", text }], timestamp: 1 };
}

/** Minimal state stub: the renderer only asks for the blocks it prints. */
const state = {
  renderSymbols: () => "",
  renderWorkspace: () => "",
  renderBlock: () => "",
};

function transcriptOf(messages, transcriptMaxChars) {
  const rendered = renderPromptMessages(
    messages,
    state,
    undefined,
    undefined,
    undefined,
    undefined,
    0,
    0,
    undefined,
    undefined,
    transcriptMaxChars,
  );
  return rendered.messages;
}

describe("transcript window", () => {
  it("keeps recent tool steps whole and drops older ones", () => {
    const messages = [
      user("the task"),
      assistantCall("c1"),
      toolResult("c1", "old body"),
      assistantText("old narration"),
      assistantCall("c2"),
      toolResult("c2", "recent body"),
    ];
    const out = transcriptOf(messages, 10_000);
    const text = JSON.stringify(out);
    assert.match(text, /recent body/);
    assert.doesNotMatch(text, /old body/);
  });

  it("retains older prose while it fits, and keeps tool pairs consistent", () => {
    const messages = [
      user("the task"),
      assistantText("first conclusion from the survey"),
      assistantText("second conclusion from the survey"),
      assistantCall("c1"),
      toolResult("c1", "recent body"),
    ];
    const out = transcriptOf(messages, 10_000);
    const text = JSON.stringify(out);
    assert.match(text, /first conclusion/);
    assert.match(text, /second conclusion/);
    // No orphan call/result: the kept window's ids match what evidence skips.
    const kept = keptToolCallIds(messages, 10_000);
    assert.ok(kept.has("c1"));
  });

  it("stops at the prose budget and at the first older tool step", () => {
    const longProse = "x".repeat(4_000);
    const messages = [
      user("the task"),
      assistantText(longProse),
      assistantText(longProse),
      assistantCall("c1"),
      toolResult("c1", "recent body"),
      assistantCall("c2"),
      toolResult("c2", "latest body"),
    ];
    const out = transcriptOf(messages, 1_000);
    const text = JSON.stringify(out);
    assert.doesNotMatch(text, /x{100}/);
    assert.match(text, /recent body/);
  });
});
