/**
 * mc:plan schema, marker rendering, and deterministic graph validation.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  isReadyPlan,
  parsePlanMarker,
  renderPlanMarker,
} from "../dist/plan/schema.js";
import { validatePlanGraph, validatePlanIssue } from "../dist/plan/validate.js";

const marker = (value) => `<!-- mc:plan\n${JSON.stringify(value)}\n-->`;

function issue(number, body, extra = {}) {
  return {
    ref: { provider: "github", repo: "o/r", number },
    title: `Issue ${number}`,
    body,
    state: "open",
    kind: "task",
    labels: [],
    children: [],
    blockedBy: [],
    blocking: [],
    acceptance: ["gate passes"],
    ...extra,
  };
}

const valid = {
  v: 1,
  status: "ready",
  role: "build",
  verification: "verified",
  worktree: "required",
  retries_before_replan: 2,
  plan_review: "agent",
  result_review: "human",
};

test("parses a complete marker and round-trips it", () => {
  const parsed = parsePlanMarker(marker(valid));
  assert.equal(parsed.present, true);
  assert.equal(parsed.error, undefined);
  assert.equal(parsed.plan.status, "ready");
  assert.equal(parsed.plan.verification, "verified");
  assert.equal(parsed.plan.retriesBeforeReplan, 2);
  assert.equal(parsed.plan.resultReview, "human");
  assert.equal(isReadyPlan(parsed.plan), true);

  const rendered = renderPlanMarker(parsed.plan);
  const again = parsePlanMarker(rendered);
  assert.deepEqual(again.plan, parsed.plan);
});

test("missing marker is distinct from an invalid marker", () => {
  assert.deepEqual(parsePlanMarker("no marker"), { present: false });
  const invalid = parsePlanMarker(marker({ ...valid, v: 2 }));
  assert.equal(invalid.present, true);
  assert.match(invalid.error, /v must be 1/);
});

test("marker defaults and invalid fields", () => {
  const defaults = parsePlanMarker(marker({ v: 1 }));
  assert.equal(defaults.plan.status, "draft");
  assert.equal(defaults.plan.role, "build");
  assert.equal(defaults.plan.verification, "verified");
  assert.equal(defaults.plan.worktree, "required");
  assert.equal(defaults.plan.retriesBeforeReplan, 2);
  assert.equal(defaults.plan.planReview, "agent");
  assert.equal(defaults.plan.resultReview, "agent");

  const invalid = parsePlanMarker(
    marker({
      v: 1,
      status: "later",
      role: "plan",
      verification: "fast",
      worktree: "never",
      retries_before_replan: -1,
      plan_review: "bot",
      result_review: "bot",
    }),
  );
  assert.equal(invalid.present, true);
  for (const text of ["status", "role", "verification", "worktree", "retries_before_replan", "plan_review", "result_review"]) {
    assert.match(invalid.error, new RegExp(text));
  }
});

test("plan issue validation checks task shape, readiness, and dependencies", () => {
  const task = issue(10, marker(valid), {
    blockedBy: [{ provider: "github", repo: "o/r", number: 9 }],
  });
  assert.equal(validatePlanIssue(task, { requireReady: true }).ok, true);

  const draft = issue(11, marker({ ...valid, status: "draft" }));
  assert.equal(validatePlanIssue(draft).ok, true);
  const notReady = validatePlanIssue(draft, { requireReady: true });
  assert.equal(notReady.ok, false);
  assert.match(notReady.errors.join("\n"), /draft/);

  const missing = validatePlanIssue(issue(12, ""));
  assert.equal(missing.ok, false);
  assert.match(missing.errors.join("\n"), /missing mc:plan/);

  const nonTask = validatePlanIssue(issue(13, marker(valid), { kind: "feature" }));
  assert.match(nonTask.errors.join("\n"), /Task issues/);

  const reserved = validatePlanIssue(issue(14, marker(valid), { reserved: { kind: "feature-pr" } }));
  assert.match(reserved.errors.join("\n"), /reserved/);

  const noAcceptance = validatePlanIssue(issue(15, marker(valid), { acceptance: [] }));
  assert.match(noAcceptance.errors.join("\n"), /acceptance/);

  const crossRepo = validatePlanIssue(
    issue(16, marker(valid), {
      blockedBy: [{ provider: "github", repo: "other/repo", number: 1 }],
    }),
  );
  assert.match(crossRepo.errors.join("\n"), /another repository/);

  const self = validatePlanIssue(
    issue(17, marker(valid), {
      blockedBy: [{ provider: "github", repo: "o/r", number: 17 }],
    }),
  );
  assert.match(self.errors.join("\n"), /cannot block itself/);
});

test("plan graph detects dependency cycles", () => {
  const a = issue(20, marker(valid), {
    blockedBy: [{ provider: "github", repo: "o/r", number: 21 }],
  });
  const b = issue(21, marker(valid), {
    blockedBy: [{ provider: "github", repo: "o/r", number: 20 }],
  });
  const result = validatePlanGraph([a, b], { requireReady: true });
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /dependency cycle/);
});


test("ready plan validation checks mc:context references", () => {
  const root = mkdtempSync(join(tmpdir(), "mc-plan-ctx-"));
  try {
    const layout = {
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
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "present.ts"), "export const x = 1;\n", "utf8");
    const body = `${marker(valid)}\n<!-- mc:context {"files":["src/present.ts","src/missing.ts"],"skills":["reference"]} -->`;
    const result = validatePlanIssue(issue(20, body), { layout, requireReady: true });
    assert.equal(result.ok, false);
    assert.match(result.errors.join("\n"), /src\/missing\.ts/);
    assert.match(result.errors.join("\n"), /skill reference/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
