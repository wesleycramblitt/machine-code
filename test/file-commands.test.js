/**
 * Typed filesystem commands: mkdir/move/copy/delete without a shell.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CORE_COMMANDS, runCommand } from "../dist/commands/registry.js";
import { commandTool } from "../dist/tools/index.js";

const run = (name, args, root) => runCommand(name, args, { root, commands: CORE_COMMANDS });

test("core:mkdir creates nested directories and is idempotent", async () => {
  const root = mkdtempSync(join(tmpdir(), "mc-fs-mkdir-"));
  try {
    const first = await run("core:mkdir", { path: "src/deep/nested" }, root);
    assert.equal(first.isError, false);
    assert.ok(existsSync(join(root, "src/deep/nested")));
    const again = await run("core:mkdir", { path: "src/deep/nested" }, root);
    assert.equal(again.isError, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("core:move and core:copy preserve contents and require force for overwrite", async () => {
  const root = mkdtempSync(join(tmpdir(), "mc-fs-move-"));
  try {
    writeFileSync(join(root, "a.txt"), "alpha\n", "utf8");
    const moved = await run("core:move", { from: "a.txt", to: "nested/b.txt" }, root);
    assert.equal(moved.isError, false);
    assert.equal(readFileSync(join(root, "nested/b.txt"), "utf8"), "alpha\n");
    assert.ok(!existsSync(join(root, "a.txt")));

    const copied = await run("core:copy", { from: "nested/b.txt", to: "c.txt" }, root);
    assert.equal(copied.isError, false);
    assert.equal(readFileSync(join(root, "c.txt"), "utf8"), "alpha\n");

    writeFileSync(join(root, "c.txt"), "other\n", "utf8");
    const blocked = await run("core:move", { from: "nested/b.txt", to: "c.txt" }, root);
    assert.equal(blocked.isError, true);
    assert.match(blocked.text, /destination exists/);
    const forced = await run("core:move", { from: "nested/b.txt", to: "c.txt", force: true }, root);
    assert.equal(forced.isError, false);
    assert.equal(readFileSync(join(root, "c.txt"), "utf8"), "alpha\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("core:copy and core:delete require recursive for directories", async () => {
  const root = mkdtempSync(join(tmpdir(), "mc-fs-dir-"));
  try {
    mkdirSync(join(root, "tree/sub"), { recursive: true });
    writeFileSync(join(root, "tree/sub/x.txt"), "x\n", "utf8");

    const refusedCopy = await run("core:copy", { from: "tree", to: "clone" }, root);
    assert.equal(refusedCopy.isError, true);
    assert.match(refusedCopy.text, /requires recursive=true/);

    const copied = await run("core:copy", { from: "tree", to: "clone", recursive: true }, root);
    assert.equal(copied.isError, false);
    assert.equal(readFileSync(join(root, "clone/sub/x.txt"), "utf8"), "x\n");

    const refusedDelete = await run("core:delete", { path: "clone" }, root);
    assert.equal(refusedDelete.isError, true);
    assert.match(refusedDelete.text, /requires recursive=true/);

    const deleted = await run("core:delete", { path: "clone", recursive: true }, root);
    assert.equal(deleted.isError, false);
    assert.ok(!existsSync(join(root, "clone")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("read-only roles cannot run mutating typed commands", async () => {
  const root = mkdtempSync(join(tmpdir(), "mc-fs-ro-"));
  try {
    const tool = commandTool({ root, commands: CORE_COMMANDS, allowMutations: false });
    const result = await tool.execute("id", { action: "run", name: "core:mkdir", args: { path: "new-dir" } });
    assert.equal(result.isError, true);
    assert.match(result.content.map((c) => c.text ?? "").join("\n"), /read-only/);
    assert.ok(!existsSync(join(root, "new-dir")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("filesystem commands refuse the root, .git, runtime state, and secrets", async () => {
  const root = mkdtempSync(join(tmpdir(), "mc-fs-safe-"));
  try {
    mkdirSync(join(root, ".git"), { recursive: true });
    mkdirSync(join(root, ".machine_code/local"), { recursive: true });
    writeFileSync(join(root, ".env"), "TOKEN=x\n", "utf8");
    for (const name of ["core:mkdir", "core:delete"]) {
      for (const path of [".", ".git", ".machine_code/local", ".env"]) {
        const result = await run(name, { path, recursive: true }, root);
        assert.equal(result.isError, true, `${name} ${path}`);
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
