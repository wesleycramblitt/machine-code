/**
 * machine_code — answer screen (reply to a run's pending question).
 *
 * Pure render of the question, its options, and the answer input box.
 * The caller resolves the pending question (inbox IO); this lays out the
 * shrunken box so the question keeps as much room as possible.
 */
import { B, C, D, G, GR, M, R, W, Y, command, fit, joinCommands, wrapText } from "../format.js";
import { scrollLines } from "../scroll.js";
import { clipLines } from "./types.js";

export interface AnswerProps {
  cols: number;
  bodyH: number;
  question: string;
  options: string[];
  answerText: string;
  scroll: number;
}

export interface AnswerFrame {
  body: string[];
  actions: string;
  secondary: string;
  scroll: number;
  page: number;
  overflow: boolean;
}

export function renderAnswer(props: AnswerProps): AnswerFrame {
  const { cols, bodyH, question, options, answerText } = props;
  const width = Math.max(20, cols - 8);
  const questionLines = wrapText(question, width);
  const top: string[] = [];
  questionLines.forEach((line, index) => {
    top.push(index === 0 ? ` ${Y}?${R} ${W}${line}${R}` : `   ${W}${line}${R}`);
  });
  top.push("");
  if (options.length > 0) {
    top.push(` ${B}${C}Options${R}`);
    for (let i = 0; i < options.length && i < 9; i++) {
      const optionLines = wrapText(options[i]!, width - 4);
      optionLines.forEach((line, index) => {
        top.push(index === 0
          ? ` ${B}${M}${i + 1}${R} ${W}${line}${R}`
          : `   ${W}${line}${R}`);
      });
    }
    top.push("");
  }
  // Give the question/options as much room as possible. Shrink the answer
  // box before hiding question lines.
  const inputLinesFor = (height: number) => 3 + height;
  let boxHeight = Math.max(1, Math.min(8, bodyH - 6));
  let availableTop = Math.max(1, bodyH - inputLinesFor(boxHeight));
  if (top.length > availableTop) {
    const needed = bodyH - top.length - 3;
    boxHeight = Math.max(1, Math.min(boxHeight, needed));
    availableTop = Math.max(1, bodyH - inputLinesFor(boxHeight));
  }
  const wrapped = wrapText(answerText || "(type the answer, then press Enter)", width - 2);
  const inputLines = [
    ` ${B}${C}Answer${R}`,
    ` ${D}┌${"─".repeat(width)}┐${R}`,
    ...Array.from({ length: boxHeight }, (_, i) =>
      ` ${D}│${R} ${W}${fit(wrapped[i] ?? "", width - 2)}${R} ${D}│${R}`),
    ` ${D}└${"─".repeat(width)}┘${R}`,
  ];
  const view = scrollLines(top, props.scroll, availableTop);
  return {
    body: clipLines([...view.lines, ...inputLines], bodyH),
    actions: joinCommands([
      ...(options.length > 0 ? [command("1-9", "Choose", undefined, M)] : []),
      ...(top.length > availableTop ? [command("^D/^U", "Scroll", undefined, M)] : []),
      command("Enter", "Send", undefined, G),
      command("Esc", "Cancel", undefined, GR),
    ]),
    secondary: `${D}answers are appended to the run inbox and picked up without replaying the transcript${R}`,
    scroll: view.scroll,
    page: Math.max(1, availableTop - 1),
    overflow: top.length > availableTop,
  };
}
