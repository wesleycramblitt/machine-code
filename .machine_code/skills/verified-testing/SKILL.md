---
name: verified-testing
description: Use when the issue is verified. Write tests with the change; the runner runs the test gate.
---

# Verified testing

This issue runs in **verified** mode: the runner will execute `script:test`
after you finish.

- Express the issue's behavior in tests before or alongside the implementation.
- Use the project's existing test framework, file layout, and naming.
- Do not add a new test framework unless the issue explicitly asks for one.
- Test behavior, edge cases, and failure paths; avoid tests that mirror the
  implementation line by line.
- Keep tests deterministic: no network, wall clock, random values, or ordering
  assumptions.
- Do not run the test command yourself. The runner runs `script:test`; if it
  fails, the failure log comes back and you fix the cause.
- Keep the change scoped to the issue. Do not add tests for unrelated code.
