/**
 * machine_code — key-handler services contract.
 *
 * Screen key handlers are pure-ish routers: `(s, ctx, data) => handled`.
 * They mutate the shared {@link TuiState} and call back into app services
 * owned by the TUI root (spawning, editing, run lifecycle). Returning true
 * means the key was consumed; the root redraws and stops dispatching.
 */
import type { RunSummary } from "../../state/runs.js";
import type { PacketFile } from "../../plan/packets.js";
import type { ModelPickerEntry } from "../format.js";
import type { RunDetail } from "../state.js";
import type { RunRow } from "../runs.js";

export interface KeyServices {
  draw: () => void;
  notify: (message: string) => void;
  launch: (args: string[], repoRoot?: string) => boolean;
  openEditor: (file: string | null | undefined) => void;
  startNewRun: (packetSlug?: string, repoRoot?: string) => void;
  forkRun: (detail: RunDetail) => void;
  answerRun: (run: RunRow | RunSummary | undefined) => void;
  interrupt: (summary: RunSummary | undefined) => void;
  startCorrect: (summary: RunSummary | undefined) => void;
  submitCorrection: () => void;
  runDetailData: () => RunDetail | null;
  pendingForRun: (run: RunSummary | undefined) => unknown;
  cycleAgent: () => void;
  cycleVerify: () => void;
  cycleAmbiguity: () => void;
  cycleMinFit: () => void;
  cycleFloors: () => void;
  enforceLockedSkills: (announce: boolean) => void;
  startPacketPicker: () => void;
  pickerPackets: () => PacketFile[];
  choosePacket: (packet: PacketFile) => void;
  pickerModels: () => ModelPickerEntry[];
  startModelPicker: () => void;
  buildNewRunArgs: () => string[] | null;
  submitNewRun: () => void;
  searchSeed: () => string;
  repoRoot: string;
}
