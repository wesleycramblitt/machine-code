/**
 * machine_code — composer keys.
 *
 * Model/packet picker overlays, insert-mode prompt editing, context-tab
 * navigation, agent/verify/worktree/ambiguity/min-fit/floor cycling, and
 * `:!` submit. The heaviest keymap; all composer state flows through `s`
 * with app services on the context. Returns true when consumed.
 */
import { CTRL_D, CTRL_U, HALF_PAGE, modelReasonText } from "../../format.js";
import { printable } from "../../format.js";
import { loadAvailability } from "../../../availability.js";
import { layout } from "../../../paths.js";
import { readPacketFile } from "../../../plan/packets.js";
import { NEW_RUN_CONTEXT_TABS } from "./types.js";
import type { SkillMode } from "../../../context/references.js";
import type { TuiState } from "../../state.js";
import type { KeyServices } from "../keys.js";

export function handleComposerKeys(s: TuiState, ctx: KeyServices, data: string): boolean {
  if (s.modelPick === "newrun") {
    const list = s.modelPickEntries;
    if (data === "\x1b") { s.modelPick = null; ctx.draw(); return true; }
    if (data === "\t") {
      s.modelPickSort = s.modelPickSort === "price" ? "fit" : "price";
      s.modelPickEntries = ctx.pickerModels();
      s.modelPickSel = 0;
      ctx.draw();
      return true;
    }
    if (data === "\x1b[A" || data === "k") { s.modelPickSel = Math.max(0, s.modelPickSel - 1); ctx.draw(); return true; }
    if (data === "\x1b[B" || data === "j") {
      s.modelPickSel = Math.min(list.length, s.modelPickSel + 1);
      ctx.draw();
      return true;
    }
    if (data === "\r" || data === "\n") {
      if (s.modelPickSel === 0) {
        s.newrun.model = undefined;
      } else {
        const entry = list[s.modelPickSel - 1];
        if (!entry) {
          ctx.draw();
          return true;
        }
        if (!entry.eligible) {
          ctx.notify(`model not eligible: ${modelReasonText(entry, loadAvailability(layout(ctx.repoRoot).home))}`);
          ctx.draw();
          return true;
        }
        s.newrun.model = entry.row.key;
      }
      s.modelPick = null;
      ctx.notify(s.newrun.model ? `model ${s.newrun.model}` : "model auto");
      ctx.draw();
      return true;
    }
    if (data === "\x7f" || data === "\b") {
      s.modelPickText = s.modelPickText.slice(0, -1);
      s.modelPickEntries = ctx.pickerModels();
      s.modelPickSel = 0;
      ctx.draw();
      return true;
    }
    if (!data.startsWith("\x1b")) {
      s.modelPickText += printable(data);
      s.modelPickEntries = ctx.pickerModels();
      s.modelPickSel = 0;
      ctx.draw();
      return true;
    }
    ctx.draw();
    return true;
  }
  if (s.packetPick === "newrun") {
    if (data === "\x1b") { s.packetPick = null; ctx.draw(); return true; }
    if (data === "\x1b[A" || data === "k") { s.packetPickSel = Math.max(0, s.packetPickSel - 1); ctx.draw(); return true; }
    if (data === "\x1b[B" || data === "j") { const list = ctx.pickerPackets(); s.packetPickSel = Math.min(Math.max(0, list.length - 1), s.packetPickSel + 1); ctx.draw(); return true; }
    if (data === "\r" || data === "\n") { const list = ctx.pickerPackets(); const picked = list[s.packetPickSel]; if (picked) ctx.choosePacket(picked); ctx.draw(); return true; }
    if (data === "\x7f" || data === "\b") { s.packetPickText = s.packetPickText.slice(0, -1); s.packetPickSel = 0; ctx.draw(); return true; }
    if (!data.startsWith("\x1b")) { s.packetPickText += printable(data); s.packetPickSel = 0; ctx.draw(); return true; }
    ctx.draw();
    return true;
  }
  if (s.newRunInsert) {
    if (data === "\x1b") { s.newRunInsert = false; ctx.draw(); return true; }
    if (data === "\r" || data === "\n") {
      s.newrun.prompt += "\n";
    } else if (data === "\x7f" || data === "\b") {
      s.newrun.prompt = s.newrun.prompt.slice(0, -1);
    } else if (!data.startsWith("\x1b")) {
      s.newrun.prompt += printable(data);
      if (s.newrun.prompt.length > 12_000) s.newrun.prompt = s.newrun.prompt.slice(0, 12_000);
    }
    ctx.draw();
    return true;
  }
  if (s.newRunColon) {
    s.newRunColon = false;
    if (data === "!") ctx.submitNewRun();
    ctx.draw();
    return true;
  }
  if (data === ":") { s.newRunColon = true; ctx.draw(); return true; }
  if (s.newRunContextFiltering) {
    if (data === "\x1b") { s.newRunContextFiltering = false; s.newRunContextFilter = ""; s.newRunContextItem = 0; ctx.draw(); return true; }
    if (data === "\r" || data === "\n") { s.newRunContextFiltering = false; s.newRunContextItem = 0; ctx.draw(); return true; }
    if (data === "\x7f" || data === "\b") { s.newRunContextFilter = s.newRunContextFilter.slice(0, -1); s.newRunContextItem = 0; ctx.draw(); return true; }
    if (!data.startsWith("\x1b")) { s.newRunContextFilter += printable(data); s.newRunContextItem = 0; ctx.draw(); return true; }
    ctx.draw();
    return true;
  }
  if (data === "/") { s.newRunContextFiltering = true; ctx.draw(); return true; }
  if (data === "\x1b") { s.screen = "list"; ctx.draw(); return true; }
  if (data === "h" || data === "\x1b[D") {
    s.newRunContextTab = Math.max(0, s.newRunContextTab - 1);
    s.newRunContextItem = 0;
    ctx.draw();
    return true;
  }
  if (data === "l" || data === "\x1b[C") {
    s.newRunContextTab = Math.min(NEW_RUN_CONTEXT_TABS.length - 1, s.newRunContextTab + 1);
    s.newRunContextItem = 0;
    ctx.draw();
    return true;
  }
  if (data === "j") { s.newRunContextItem += 1; ctx.draw(); return true; }
  if (data === "k") { s.newRunContextItem = Math.max(0, s.newRunContextItem - 1); ctx.draw(); return true; }
  if (data === CTRL_U) { s.newRunContextItem = Math.max(0, s.newRunContextItem - 5); ctx.draw(); return true; }
  if (data === CTRL_D) { s.newRunContextItem += 5; ctx.draw(); return true; }
  if (data === " ") {
    const key = s.newRunContextItemKeys[s.newRunContextItem];
    const available = s.newRunContextItemAvailable[s.newRunContextItem] === true;
    if (key && key.startsWith("packet:")) {
      const slug = key.slice("packet:".length);
      const packet = readPacketFile(layout(ctx.repoRoot), slug);
      if (packet) ctx.choosePacket(packet);
      else ctx.notify(`packet ${slug} is missing`);
      ctx.draw();
      return true;
    }
    if (key && key.startsWith("skill:")) {
      // Three modes cycle: include (body inlined) → on-demand
      // (description only, pulled with the skill tool) → exclude.
      const name = key.slice("skill:".length);
      const current = s.newRunSkillShown.get(name) ?? "on-demand";
      const next: SkillMode = current === "include" ? "on-demand" : current === "on-demand" ? "exclude" : "include";
      if (next === "exclude" && ctx.lockedSkills().includes(name)) {
        ctx.notify("verified-testing is required by Verify; switch to Direct to exclude it");
        ctx.draw();
        return true;
      }
      s.newRunSkillModes.set(name, next);
      if (next === "exclude") s.newRunContextExcluded.add(key);
      else s.newRunContextExcluded.delete(key);
    } else if (key && available) {
      if (key.startsWith("file:") || key.startsWith("knowledge:") || key.startsWith("reference:") || key.startsWith("plan:") || key.startsWith("issue:")) {
        if (s.newRunContextIncluded.has(key)) s.newRunContextIncluded.delete(key);
        else {
          s.newRunContextIncluded.add(key);
          s.newRunContextExcluded.delete(key);
        }
      }
    } else if (key && !key.startsWith("core-tool:") && !key.startsWith("prompt:")) {
      if (s.newRunContextExcluded.has(key)) s.newRunContextExcluded.delete(key);
      else {
        s.newRunContextExcluded.add(key);
        s.newRunContextIncluded.delete(key);
      }
    }
    ctx.draw();
    return true;
  }
  if (data === "x") {
    if (s.newRunContextSectionKey) {
      if (s.newRunContextExcluded.has(s.newRunContextSectionKey)) s.newRunContextExcluded.delete(s.newRunContextSectionKey);
      else s.newRunContextExcluded.add(s.newRunContextSectionKey);
    }
    ctx.draw();
    return true;
  }
  if (data === "a") { ctx.cycleAgent(); ctx.draw(); return true; }
  if (data === "t") { s.newrun.tier = s.newrun.tier === "paid" ? "free" : "paid"; ctx.draw(); return true; }
  if (data === "v") {
    if (!ctx.agentIsolates(s.newrun.agent)) { ctx.notify("verify is build-only"); ctx.draw(); return true; }
    ctx.cycleVerify(); ctx.draw(); return true;
  }
  if (data === "w") {
    if (!ctx.agentIsolates(s.newrun.agent)) { ctx.notify("worktree is build-only"); ctx.draw(); return true; }
    s.newrun.worktree = !s.newrun.worktree; ctx.draw(); return true;
  }
  if (data === "g") { ctx.cycleAmbiguity(); ctx.draw(); return true; }
  if (data === "f") { ctx.cycleMinFit(); ctx.draw(); return true; }
  if (data === "F") { ctx.cycleFloors(); ctx.draw(); return true; }
  if (data === "i" && s.newRunContextSectionKey === "section:packets") { ctx.startPacketPicker(); ctx.draw(); return true; }
  if (data === "m") { ctx.startModelPicker(); ctx.draw(); return true; }
  if (data === "e" || data === "p") { s.newRunInsert = true; ctx.draw(); return true; }
  if (data === "X" && s.newrun.packet) { s.newrun.packet = undefined; ctx.draw(); return true; }
  ctx.draw();
  return true;}
