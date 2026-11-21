---
name: requirements
description: Use when an issue or request is ambiguous. Clarify one decision at a time, then choose one scope.
---

# Requirements skill

Use this before you plan or scope work that is large or ambiguous.
Use it when an issue, request, or artifact cannot yet name the scope and how to verify it.
Do not use it for a small, clear request.

## Procedure

1. State the request in one sentence.
2. List the decisions that can change scope, files, or acceptance. Keep the list to three.
3. Challenge each assumption that the repository contradicts.
4. Ask one question for the decision with the largest impact. Give two or three options and a recommendation.
5. Wait for the answer. Restate the decision in one sentence.
6. Repeat only while an open decision can change the work.
7. Name two plausible options when a design choice remains. State the trade-off. Recommend one.
8. Stop when the work can name exact files and acceptance commands. For a doc, also name its audience, the question it answers, and the decisions it records.

## Rules

- Ask with the `ask` tool when it is available. Do not ask a question that the repository can answer.
- When `ask` is unavailable, decide from repository evidence and conventions, record the assumption, and continue. Stop only if no defensible choice exists.
- Ask for missing facts, not for approval of your plan.
- Ask one question at a time; never bundle decisions.
- Prefer the smallest scope that meets the request.
- Record each decision in the artifact you are writing, or as a `context` note when you are implementing.
- Stop when no open decision changes scope, files, or acceptance, or each remaining one is recorded as an assumption.
