/**
 * machine_code — packet screen keys.
 *
 * `g` cycles the merge gate, `o` orchestrates the batch, `b` builds just
 * this packet, `a` approves it, `d` deletes it. Builds/approvals run
 * detached through the CLI. Returns true when the key was consumed.
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readPacketFile, writePacketFile } from "../../plan/packets.js";
import { commitPlanningFiles } from "../../tasks/packet.js";
import { layout } from "../../paths.js";
import type { TuiState } from "../state.js";
import type { KeyServices } from "./keys.js";

export function handlePacketKeys(s: TuiState, ctx: KeyServices, data: string): boolean {
  const slug = s.selectedPacketSlug;
  const spawnCli = (args: string[], note: string): void => {
    const cliPath = fileURLToPath(new URL("../../cli.js", import.meta.url));
    spawn(process.execPath, [cliPath, ...args], { detached: true, stdio: "ignore" }).unref();
    ctx.notify(note);
    ctx.draw();
  };
  if (data === "\x1b" || data === "q") { s.screen = "list"; ctx.draw(); return true; }
  if (data === "\x1b[A" || data === "k") { s.packetScroll = Math.max(0, s.packetScroll - 1); ctx.draw(); return true; }
  if (data === "\x1b[B" || data === "j") { s.packetScroll += 1; ctx.draw(); return true; }
  if (data === "g" && slug) {
    const packet = readPacketFile(layout(ctx.repoRoot), slug);
    if (packet) {
      const order = ["gates", "agent", "human"] as const;
      const idx = order.indexOf((packet.review ?? "gates") as (typeof order)[number]);
      packet.review = order[(idx + 1) % order.length]!;
      writePacketFile(layout(ctx.repoRoot), packet);
      void commitPlanningFiles(layout(ctx.repoRoot), `plans: gate ${slug}`);
      ctx.notify(`${slug} gate → ${packet.review}`);
    }
    ctx.draw();
    return true;
  }
  if (data === "o") { spawnCli(["batch"], "orchestration started (batch)"); return true; }
  if (data === "b" && slug) { spawnCli(["build", slug], `build ${slug} started`); return true; }
  if (data === "a" && slug) { spawnCli(["approve", slug], `approve ${slug} queued`); return true; }
  if (data === "d" && slug) { spawnCli(["delete", slug], `delete ${slug} queued`); return true; }
  ctx.draw();
  return true;
}
