/**
 * machine_code — prompt screen (inject a prompt into an existing run).
 *
 * Pure render of the prompt input box plus an explanation of the delivery
 * path: running runs get the message via a control file (live budget),
 * interrupted/paused runs get it appended to the transcript (fires as the
 * next turn on resume).
 */
import { B, C, D, G, GR, R, W, command, fit, joinCommands, wrapText } from "../format.js";
import { clipLines } from "./types.js";

export interface PromptProps {
  cols: number;
  bodyH: number;
  promptText: string;
  /** Run id the prompt will be injected into. */
  runId: string;
  /** True when the run is still running; route via control vs transcript. */
  running: boolean;
}

export interface PromptFrame {
  body: string[];
  actions: string;
  secondary: string;
}

export function renderPrompt(props: PromptProps): PromptFrame {
  const { cols, bodyH, promptText, runId, running } = props;
  const width = Math.max(20, cols - 8);
  const hint = running
    ? "Injected live into the running process; it is added to the model context in flight."
    : "The run is stopped. The prompt fires as the instruction on the next resume.";
  const lines = [
    "",
    ` ${D}Add a prompt to run ${runId}:${R}`,
    ` ${D}${hint}${R}`,
    "",
    ` ${B}${C}Prompt${R}`,
    ` ${D}┌${"─".repeat(width)}┐${R}`,
  ];
  const wrapped = wrapText(promptText || "(type the instruction; Enter injects it)", width - 2);
  const boxHeight = Math.max(1, Math.min(bodyH - 10, 7));
  for (let i = 0; i < boxHeight; i++) lines.push(` ${D}│${R} ${W}${fit(wrapped[i] ?? "", width - 2)}${R} ${D}│${R}`);
  lines.push(` ${D}└${"─".repeat(width)}┘${R}`);
  return {
    body: clipLines(lines, bodyH),
    actions: joinCommands([
      command("Enter", "Inject", undefined, G),
      command("Esc", "Cancel", undefined, GR),
    ]),
    secondary: `${D}Esc returns to the run detail without injecting${R}`,
  };
}