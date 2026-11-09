---
name: systematic-debugging
description: Use when a gate fails or a bug needs a cause. Reproduce, fix the cause, and prove it.
---

# Systematic debugging skill

Use this skill when a gate fails or a bug needs a cause.
Do not guess a fix.

## Procedure

1. Reproduce the failure with one exact command. Record the command and the output.
2. Read the failing path. Name the smallest unit that can cause the failure.
3. State one hypothesis. Predict what a check will show if it is true.
4. Run the cheapest check that can disprove it. Change one variable.
5. If the hypothesis is disproved, record the result. Go to step 3. Stop when you can name the cause with evidence.
6. When the cause is known, reproduce it with the smallest read-only probe. Do not add a harness the issue did not ask for.
7. Make the smallest fix at the cause, not at the symptom.
8. Run the failing check or the issue's acceptance command.
9. Report the cause, the fix, and the evidence.

## Rules

- Use one hypothesis at a time. Do not change code and the reproduction together.
- In direct mode, use an existing check or a read-only probe; do not add scaffolding.
- Do not change a check to make a failure pass unless the check is wrong. State why it is wrong.
- Do not add retries, sleeps, or guards before you know the cause.
- Stop after three failed hypotheses. Report the evidence and the open question.
- Keep the failing command in the last step. It is the proof.
