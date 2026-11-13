/**
 * machine_code — key-handler services contract.
 *
 * Screen key handlers are pure-ish routers: `(s, ctx, data) => handled`.
 * They mutate the shared {@link TuiState} and call back into app services
 * owned by the TUI root (spawning, editing, run lifecycle). Returning true
 * means the key was consumed; the root redraws and stops dispatching.
 */
import type { RunSummary } from "../../state/runs.js";
import type { Issue } from "../../plan/issues.js";
import type { ModelPickerEntry } from "../format.js";
import type { NewRunSeed, RunDetail } from "../state.js";
import type { RunRow } from "../runs.js";

export interface KeyServices {
  draw: () => void;
  notify: (message: string) => void;
  launch: (args: string[], repoRoot?: string) => boolean;
  openEditor: (file: string | null | undefined) => void;
  startNewRun: (itemSlug?: string, repoRoot?: string, seed?: NewRunSeed) => void;
  forkRun: (detail: RunDetail) => void;
  answerRun: (run: RunRow | RunSummary | undefined) => void;
  interrupt: (summary: RunSummary | undefined) => void;
  startCorrect: (summary: RunSummary | undefined) => void;
  submitCorrection: () => void;
  runDetailData: () => RunDetail | null;
  pendingForRun: (run: RunSummary | undefined) => unknown;
  cycleAgent: () => void;
  cycleAmbiguity: () => void;
  cycleMinFit: () => void;
  cycleFloors: () => void;
  cycleTier: () => void;
  startIssuePicker: () => void;
  pickerIssues: () => Issue[];
  chooseIssue: (issue: Issue) => void;
  pickerModels: () => ModelPickerEntry[];
  startModelPicker: () => void;
  buildNewRunArgs: () => string[] | null;
  submitNewRun: () => void;
  /** Open the issue composer for a new issue. */
  startNewIssue: (repoRoot?: string) => void;
  /** Create the issue, commit, and push. */
  submitNewIssue: () => void;
  agentIsolates: (agent: string) => boolean;
  searchSeed: () => string;
  repoRoot: string;
}
