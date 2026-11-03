/**
 * Deterministic Planner fixtures. These exercise the plan validator without a
 * model call; the cases mirror the Planner eval matrix in the roadmap.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { parsePlanMarker } from "../dist/plan/schema.js";
import { validatePlanGraph, validatePlanIssue } from "../dist/plan/validate.js";

const marker = (value) => `<!-- mc:plan\n${JSON.stringify(value)}\n-->`;
const base = {
  v: 1,
  status: "ready",
  role: "build",
  verification: "verified",
  worktree: "required",
  retries_before_replan: 2,
  plan_review: "agent",
  result_review: "agent",
};

function issue(number, extra = {}) {
  return {
    ref: { provider: "github", repo: "o/r", number },
    title: `Task ${number}`,
    body: marker(base),
    state: "open",
    kind: "task",
    labels: [],
    children: [],
    blockedBy: [],
    blocking: [],
    acceptance: ["typescript:test"],
    ...extra,
  };
}

function layout(root) {
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

test("planner fixture matrix", () => {
  const root = mkdtempSync(join(tmpdir(), "mc-planner-fixtures-"));
  try {
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "present.ts"), "export const present = true;\n", "utf8");

    // greenfield extension: a clean ready task
    assert.equal(validatePlanIssue(issue(1), { requireReady: true }).ok, true);

    // extension: a draft is structurally valid but not dispatchable
    const draft = issue(2, { body: marker({ ...base, status: "draft" }) });
    assert.equal(validatePlanIssue(draft).ok, true);
    assert.match(validatePlanIssue(draft, { requireReady: true }).errors.join("\n"), /draft/);

    // missing artifact: context references are validated before writing
    const missing = issue(3, {
      body: `${marker(base)}\n<!-- mc:context {"files":["src/missing.ts"]} -->`,
    });
    assert.match(validatePlanIssue(missing, { layout: layout(root) }).errors.join("\n"), /src\/missing\.ts/);

    // dependency cycle
    const a = issue(4, { blockedBy: [{ provider: "github", repo: "o/r", number: 5 }] });
    const b = issue(5, { blockedBy: [{ provider: "github", repo: "o/r", number: 4 }] });
    assert.match(validatePlanGraph([a, b], { requireReady: true }).errors.join("\n"), /dependency cycle/);

    // replan budget out of range is rejected by the marker parser
    assert.match(parsePlanMarker(marker({ ...base, retries_before_replan: 21 })).error, /retries_before_replan/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
