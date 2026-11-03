/**
 * Opt-in real-GitHub smoke test. Default suite never touches the network.
 *
 * MACHINE_CODE_GITHUB_INTEGRATION=1
 * MACHINE_CODE_GITHUB_REPO=owner/repo
 * MACHINE_CODE_GITHUB_ISSUE=123
 * MACHINE_CODE_GITHUB_ROOT=/path/to/clone   # optional
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { GitHubIssueProvider } from "../dist/issues/github.js";

const enabled = process.env.MACHINE_CODE_GITHUB_INTEGRATION === "1";

test("real GitHub repository reads", { skip: enabled ? false : "set MACHINE_CODE_GITHUB_INTEGRATION=1" }, async () => {
  const repo = process.env.MACHINE_CODE_GITHUB_REPO;
  const issueNumber = Number(process.env.MACHINE_CODE_GITHUB_ISSUE);
  assert.ok(repo && repo.includes("/"), "MACHINE_CODE_GITHUB_REPO=owner/repo is required");
  assert.ok(Number.isInteger(issueNumber) && issueNumber > 0, "MACHINE_CODE_GITHUB_ISSUE is required");
  const provider = new GitHubIssueProvider({
    repo,
    repoRoot: process.env.MACHINE_CODE_GITHUB_ROOT || process.cwd(),
  });
  assert.equal(await provider.available(), true, "gh must be installed and authenticated");
  const ref = { provider: "github", repo, number: issueNumber };
  const issue = await provider.get(ref);
  assert.ok(issue, `issue #${issueNumber} must exist in ${repo}`);
  assert.equal(issue.ref.number, issueNumber);
  const listed = await provider.list({ state: "all", limit: 5 });
  assert.ok(Array.isArray(listed));
  assert.ok(Array.isArray(await provider.hierarchy(ref)));
  assert.ok(Array.isArray(await provider.blockers(ref)));
});
