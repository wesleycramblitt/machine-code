/**
 * Plan items: checklist lines across plan files, flexible typing from
 * headings or text, packet links, and done checkboxes.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { planItems } from "../dist/plan/items.js";

function fakeLayout(root) {
  return {
    home: join(root, "home"),
    machineConfig: "",
    curation: "",
    catalogueFile: "",
    repoRoot: root,
    repoDir: join(root, ".machine_code"),
    localDir: join(root, ".machine_code", "local"),
    policyFile: "",
    runsDir: join(root, ".machine_code", "local", "runs"),
  };
}

test("plan items derive type from headings, links, and checkboxes", () => {
  const root = mkdtempSync(join(tmpdir(), "mc-items-"));
  try {
    mkdirSync(join(root, "plans"), { recursive: true });
    writeFileSync(
      join(root, "plans", "tui.md"),
      [
        "# TUI work",
        "",
        "Prose is ignored.",
        "",
        "## Features",
        "- [ ] runs-hierarchy — Runs page hierarchy → packets/runs-hierarchy.md",
        "",
        "## Bugs",
        "- [x] cursor-blink — Fix the blinking cursor",
        "",
        "## Ideas",
        "- [ ] maybe-ollama — Explore a local Ollama provider",
        "- [~] old-idea — Settled long ago",
      ].join("\n"),
      "utf8",
    );
    writeFileSync(
      join(root, "plans", "models.md"),
      [
        "# Models",
        "",
        "- [ ] price-table — Add a price table",
        "- [ ] fix-cooldowns — Cooldown math is broken",
        "- [ ] consider-probes — Maybe probe providers on start",
      ].join("\n"),
      "utf8",
    );

    const items = planItems(fakeLayout(root));
    const bySlug = new Map(items.map((entry) => [entry.slug, entry]));

    assert.equal(bySlug.get("runs-hierarchy")?.kind, "feature");
    assert.equal(bySlug.get("runs-hierarchy")?.packet, "runs-hierarchy");
    assert.equal(bySlug.get("runs-hierarchy")?.planTitle, "TUI work");

    assert.equal(bySlug.get("cursor-blink")?.kind, "bug");
    assert.equal(bySlug.get("cursor-blink")?.done, true);

    assert.equal(bySlug.get("maybe-ollama")?.kind, "idea");
    assert.equal(bySlug.get("old-idea")?.archived, true);
    assert.equal(bySlug.get("old-idea")?.done, false);

    // With no matching heading, the line text decides.
    assert.equal(bySlug.get("price-table")?.kind, "feature");
    assert.equal(bySlug.get("fix-cooldowns")?.kind, "bug");
    assert.equal(bySlug.get("consider-probes")?.kind, "idea");
    assert.equal(bySlug.get("price-table")?.planTitle, "Models");
    assert.equal(bySlug.get("price-table")?.plan, "plans/models.md");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("items are marked done and removed in place across plan files", async () => {
  const { markItemDone, removeItemFromPlans } = await import("../dist/plan/items.js");
  const root = mkdtempSync(join(tmpdir(), "mc-items-done-"));
  try {
    mkdirSync(join(root, "plans"), { recursive: true });
    writeFileSync(
      join(root, "plans", "tui.md"),
      "# TUI\n\n## Features\n- [ ] a — First → packets/a.md\n- [ ] b — Second\n",
      "utf8",
    );
    const layout = fakeLayout(root);
    assert.deepEqual(markItemDone(layout, "a"), ["plans/tui.md"]);
    const after = readFileSync(join(root, "plans", "tui.md"), "utf8");
    assert.match(after, /- \[x\] a — First → packets\/a\.md/);
    assert.match(after, /- \[ \] b — Second/);
    // Done is a status: the line stays under Features.
    assert.ok(after.indexOf("## Features") < after.indexOf("- [x] a"));

    assert.deepEqual(removeItemFromPlans(layout, "b"), ["plans/tui.md"]);
    assert.doesNotMatch(readFileSync(join(root, "plans", "tui.md"), "utf8"), /- \[ \] b/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
