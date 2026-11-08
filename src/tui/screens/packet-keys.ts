/**
 * machine_code — work-item detail keys.
 *
 * `n` starts the next run for the item's lifecycle (research for ideas,
 * planner when there is no contract, build when ready), `p` plans, `e` edits
 * the contract or plan file, `o` orchestrates the batch, and gate/build/
 * approve/delete act on the contract when it exists.
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { readPacketFile, writePacketFile } from "../../plan/packets.js";
import { planItems } from "../../plan/items.js";
import { commitPlanningFiles } from "../../tasks/packet.js";
import { layout } from "../../paths.js";
import type { TuiState } from "../state.js";
import type { KeyServices } from "./keys.js";

export function handlePacketKeys(s: TuiState, ctx: KeyServices, data: string): boolean {
  const slug = s.selectedPacketSlug;
  const l = layout(ctx.repoRoot);
  const packet = slug ? readPacketFile(l, slug) : null;
  const item = slug ? planItems(l).find((entry) => entry.slug === slug) : undefined;
  const spawnCli = (args: string[], note: string): void => {
    const cliPath = fileURLToPath(new URL("../../cli.js", import.meta.url));
    spawn(process.execPath, [cliPath, ...args], { detached: true, stdio: "ignore" }).unref();
    ctx.notify(note);
    ctx.draw();
  };
  const startForItem = (): void => {
    if (!slug) return;
    if (!packet) {
      ctx.startNewRun(undefined, l.repoRoot, {
        agent: item?.kind === "idea" ? "research" : "planner",
        item: slug,
        ...(item ? { plan: item.plan } : {}),
        prompt:
          item?.kind === "idea"
            ? `Research "${item.title}" in ${item.plan} and propose concrete features or bugs to add to that plan.`
            : item
              ? `Turn the ${item.kind} "${item.title}" in ${item.plan} into a build contract.`
              : `Plan ${slug}.`,
        ...(item?.kind === "idea" ? { skills: ["plan-curation"] } : {}),
      });
      return;
    }
    ctx.startNewRun(packet.slug, l.repoRoot, { agent: "build", item: packet.slug });
  };
  if (data === "\x1b" || data === "q") { s.screen = "list"; ctx.draw(); return true; }
  if (data === "\x1b[A" || data === "k") { s.packetScroll = Math.max(0, s.packetScroll - 1); ctx.draw(); return true; }
  if (data === "\x1b[B" || data === "j") { s.packetScroll += 1; ctx.draw(); return true; }
  if (data === "n") { startForItem(); ctx.draw(); return true; }
  if (data === "p" && slug) {
    ctx.startNewRun(undefined, l.repoRoot, {
      agent: "planner",
      item: slug,
      ...(item ? { plan: item.plan } : {}),
      prompt: item
        ? `Turn the ${item.kind} "${item.title}" in ${item.plan} into a build contract.`
        : `Plan ${slug}.`,
    });
    ctx.draw();
    return true;
  }
  if (data === "e" && slug) {
    ctx.openEditor(packet ? join(l.repoRoot, "packets", `${slug}.md`) : item ? join(l.repoRoot, item.plan) : null);
    return true;
  }
  if (data === "g" && slug && packet) {
    const order = ["gates", "agent", "human"] as const;
    const idx = order.indexOf((packet.review ?? "gates") as (typeof order)[number]);
    packet.review = order[(idx + 1) % order.length]!;
    writePacketFile(l, packet);
    void commitPlanningFiles(l, `plans: gate ${slug}`);
    ctx.notify(`${slug} gate → ${packet.review}`);
    ctx.draw();
    return true;
  }
  if (data === "o") { spawnCli(["batch"], "orchestration started (batch)"); return true; }
  if (data === "b" && slug && packet) { spawnCli(["build", slug], `build ${slug} started`); return true; }
  if (data === "a" && slug && packet) { spawnCli(["approve", slug], `approve ${slug} queued`); return true; }
  if (data === "d" && slug && packet) { spawnCli(["delete", slug], `delete ${slug} queued`); return true; }
  ctx.draw();
  return true;
}
