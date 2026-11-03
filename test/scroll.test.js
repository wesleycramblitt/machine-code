/**
 * Cursor scrolling keeps the group/section heading above the first item
 * visible when the user scrolls back to the top.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { scrollLines, selectableLines } from "../dist/tui/scroll.js";

const lines = Array.from({ length: 50 }, (_, index) => `line ${index}`);

test("scrolling up to the first row reveals the heading above it", () => {
  const first = selectableLines(lines, 1, 30, 10);
  assert.equal(first.scroll, 0);
  assert.equal(first.lines[0], "line 0");
  assert.equal(first.lines[1], "line 1");
});

test("moving up from deep in a list shows one line of context above selection", () => {
  const window = selectableLines(lines, 18, 30, 10);
  assert.equal(window.scroll, 17);
  assert.equal(window.lines[0], "line 17");
  assert.equal(window.lines[1], "line 18");
});

test("moving down past the viewport keeps the selected row at the bottom", () => {
  const window = selectableLines(lines, 30, 0, 10);
  assert.equal(window.scroll, 21);
  assert.equal(window.lines.at(-1), "line 30");
});

test("selection and scroll are clamped at the end of the list", () => {
  const window = selectableLines(lines, 999, 49, 10);
  assert.equal(window.scroll, 40);
  assert.equal(window.lines.at(-1), "line 49");
});

test("free scrolling moves the viewport without a selected row", () => {
  const window = scrollLines(lines, 12, 10);
  assert.equal(window.scroll, 12);
  assert.equal(window.lines[0], "line 12");
  assert.equal(window.lines.at(-1), "line 21");

  const top = scrollLines(lines, -4, 10);
  assert.equal(top.scroll, 0);
  assert.equal(top.lines[0], "line 0");

  const end = scrollLines(lines, 999, 10);
  assert.equal(end.scroll, 40);
  assert.equal(end.lines.at(-1), "line 49");
});
