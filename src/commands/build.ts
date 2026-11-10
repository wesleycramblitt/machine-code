/**
 * machine_code — rebuild a merged main checkout.
 *
 * The running CLI/TUI is `dist/`, not the source. A source merge does not
 * update it. After a successful merge, run the repository's build script in
 * main so the next `machine_code` process uses the current code.
 */
import { runCommand } from "./registry.js";
import { scriptCommands } from "./scripts.js";

export async function runMainBuild(
  topRoot: string,
): Promise<{ ok: boolean; skipped?: boolean; text: string }> {
  const commands = scriptCommands(topRoot);
  if (!commands.has("script:build")) {
    return { ok: true, skipped: true, text: "no scripts/build script; main build skipped" };
  }
  const result = await runCommand("script:build", {}, { root: topRoot, commands });
  return { ok: !result.isError, text: result.text };
}
