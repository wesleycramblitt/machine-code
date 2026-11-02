---
name: systematic-debugging
description: Use when a test, gate, or bug fails. Reproduce, find the cause, fix the cause, and prove it.
---

# Systematic debugging skill

Use this skill when a gate fails, a test fails, or a bug needs a cause.
Do not guess a fix.

## Procedure

1. Reproduce the failure with one exact command. Record the command and the output.
2. Read the failing path. Name the smallest unit that can cause the failure.
3. State one hypothesis. Predict what a check will show if it is true.
4. Run the cheapest check that can disprove it. Change one variable.
5. If the hypothesis is disproved, record the result. Go to step 3. Stop when you can name the cause with evidence.
6. When the cause is known, find the failing test. Add one if none exists and the mode allows new tests.
7. Make the smallest fix at the cause, not at the symptom.
8. Run the failing check. Then run the packet acceptance commands.
9. Report the cause, the fix, and the evidence.

## Rules

- Use one hypothesis at a time. Do not change code and test together.
- In direct mode, do not add tests. Use an existing test or a read-only check.
- Do not edit a test to make a failure pass unless the test is wrong. State why it is wrong.
- Do not add retries, sleeps, or guards before you know the cause.
- Stop after three failed hypotheses. Report the evidence and the open question.
- Keep the failing command in the last step. It is the proof.
