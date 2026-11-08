#!/usr/bin/env node
/**
 * machine_code — CLI dispatcher.
 *
 * Each command group lives in `src/cli/*.ts`; shared setup (flags, runtime,
 * formatting, run lookup) lives in `src/cli/common.ts`. This file only maps
 * argv to a group and exits with its code. Behavior unchanged.
 */
import { loadEnvFiles } from "./env.js";
import { runTui } from "./tui.js";
import { fail, HELP, VERSION } from "./cli/common.js";
import { cmdInit, cmdInstall, cmdProviders, cmdPolicy, cmdConfig, cmdTools, cmdLsp, cmdMap } from "./cli/system.js";
import { cmdModels, cmdCatalogueSnapshot, cmdCatalogueRefresh, cmdProvider, cmdAvailability, cmdModel } from "./cli/models.js";
import { cmdRun, controlCommand, cmdRespond, cmdFork, cmdResume, cmdPrune, cmdWorktree, cmdCorrect } from "./cli/run.js";
import { cmdLog, cmdStatus, cmdRuns, cmdProcesses, cmdShow, cmdEval, cmdPack, cmdContext, cmdSpend, cmdPrompts } from "./cli/runs.js";
import { cmdApprove, cmdPlan, cmdPacket, cmdBuild, cmdBatch, cmdDelete, cmdIssue } from "./cli/packets.js";

async function main(): Promise<void> {
  loadEnvFiles();
  const [command, ...rest] = process.argv.slice(2);
  let code: number;
  switch (command) {
    case "run":
      code = await cmdRun(rest);
      break;
    case "init":
      code = cmdInit();
      break;
    case "install":
      code = await cmdInstall(rest);
      break;
    case "providers":
      code = cmdProviders();
      break;
    case "models":
      code = cmdModels(rest);
      break;
    case "policy":
      code = cmdPolicy(rest);
      break;
    case "catalogue":
      if (rest[0] === "refresh") {
        code = await cmdCatalogueRefresh(rest.includes("--snapshot"));
      } else if (rest[0] === "snapshot") {
        code = cmdCatalogueSnapshot(rest[1]);
      } else {
        fail("usage: machine_code catalogue refresh [--snapshot] | snapshot [path]");
      }
      break;
    case "runs":
      code = await cmdRuns(rest);
      break;
    case "show":
      code = cmdShow(rest);
      break;
    case "processes":
      code = await cmdProcesses(rest);
      break;
    case "context":
      code = cmdContext(rest);
      break;
    case "eval":
      code = await cmdEval(rest);
      break;
    case "pack":
      code = await cmdPack(rest);
      break;
    case "spend":
      code = cmdSpend(rest);
      break;
    case "prompts":
      code = cmdPrompts(rest);
      break;
    case "map":
      code = await cmdMap(rest);
      break;
    case "lsp":
      code = await cmdLsp(rest);
      break;
    case "tools":
      code = cmdTools(rest);
      break;
    case "config":
    case "settings":
      code = cmdConfig(rest);
      break;
    case "correct":
      code = await cmdCorrect(rest);
      break;
    case "log":
      code = cmdLog(rest[0]);
      break;
    case "status":
      code = await cmdStatus();
      break;
    case "resume":
      code = await cmdResume(rest[0], rest.slice(1));
      break;
    case "respond":
      code = cmdRespond(rest);
      break;
    case "pause":
      code = controlCommand("pause", rest);
      break;
    case "cancel":
      code = controlCommand("cancel", rest);
      break;
    case "fork":
      code = await cmdFork(rest);
      break;
    case "prune":
      code = await cmdPrune(rest);
      break;
    case "worktree":
      code = await cmdWorktree(rest);
      break;
    case "issue":
      code = await cmdIssue(rest);
      break;
    case "approve":
      code = await cmdApprove(rest);
      break;
    case "provider":
      code = await cmdProvider(rest);
      break;
    case "model":
      code = await cmdModel(rest);
      break;
    case "availability":
      code = await cmdAvailability(rest);
      break;
    case "plan":
      code = cmdPlan(rest);
      break;
    case "packet":
      code = await cmdPacket(rest);
      break;
    case "build":
      code = await cmdBuild(rest);
      break;
    case "batch":
      code = await cmdBatch(rest);
      break;
    case "delete":
      code = await cmdDelete(rest);
      break;
    case "version":
    case "--version":
      process.stdout.write(`${VERSION}\n`);
      code = 0;
      break;
    case "tui":
      await runTui();
      code = 0;
      break;
    case "help":
    case "--help":
    case "-h":
      process.stdout.write(HELP);
      code = 0;
      break;
    case undefined:
      await runTui();
      code = 0;
      break;
    default:
      process.stdout.write(HELP);
      fail(`unknown command: ${command}`);
  }
  process.exit(code);
}

main().catch((error: unknown) => {
  fail(error instanceof Error ? error.message : String(error));
});
