/**
 * Ask-answer auto-ingest tests.
 *
 * Answered scope questions must survive the 2-turn transcript window even
 * when the model never writes the note the skill asks for (observed: 6
 * answers, 0 notes, the same question asked 3 times). ingestTurn records
 * every answered ask as a decision fact, so later state blocks show what
 * was already decided and the model stops re-asking.
 *
 * No network or provider calls. Run with: npm test
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { ingestTurn } from "../dist/context/ingest.js";

function fakeHost() {
  return {
    decisions: [],
    symbols: { addSeen() {}, addSymbol() {}, entries: new Map() },
    addReadFact() {},
    addSearchFact() {},
    addCommandFact() {},
    addChangeFact() {},
    addDecisionFact(text, turn) {
      this.decisions.push({ text, turn });
    },
    setPhase() {},
    appendTurn() {},
    activeFacts() { return 0; },
    event() {},
    save() {},
  };
}

function askMessages(question, answer, id = "call-1", isError = false) {
  return [
    {
      role: "assistant",
      content: [{ type: "toolCall", id, name: "ask", arguments: { question } }],
    },
    {
      role: "toolResult",
      toolCallId: id,
      toolName: "ask",
      content: [{ type: "text", text: answer }],
      isError,
      timestamp: 1,
    },
  ];
}

describe("ingestTurn ask answers", () => {
  it("records answered questions as decision facts", () => {
    const host = fakeHost();
    ingestTurn(
      host,
      askMessages("Batch identity together?", "Batch full identity together"),
      7,
    );
    assert.equal(host.decisions.length, 1);
    assert.match(host.decisions[0].text, /Batch identity together\?/);
    assert.match(host.decisions[0].text, /Batch full identity together/);
    assert.equal(host.decisions[0].turn, 7);
  });

  it("skips errored and empty answers", () => {
    const host = fakeHost();
    ingestTurn(host, askMessages("Q?", "no", "c1", true), 7);
    ingestTurn(host, askMessages("Q?", "   ", "c2", false), 8);
    ingestTurn(host, askMessages("", "yes", "c3", false), 9);
    assert.equal(host.decisions.length, 0);
  });
});
