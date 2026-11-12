acceptance: script:build
todo:
  - [ ] Locate the change
  - [ ] Make the smallest edit
  - [ ] Finish

Auto-created from run.

I removed the review agent. We need to remove any references to it, and also the agent review mode for tasks. It should now be no review or human review. And, on that note, human review can be completed from teh TUI on the issue after a task is completed. (I noticed that I can't approve an issue that needs human review from the TUI, it blocks me when I hit "a" for approve).

## Gate failure
Attempt: 1

$ script:build
script:build exited 2: npm notice run machine_code@0.0.0 build
npm notice run tsc && chmod +x dist/cli.js
src/cli/issues.ts(135,7): error TS2322: Type '"agent" | "human" | "none"' is not assignable to type 'ReviewMode | undefined'.
  Type '"agent"' is not assignable to type 'ReviewMode | undefined'.
src/cli/issues.ts(327,76): error TS2367: This comparison appears to be unintentional because the types 'ReviewMode' and '"agent"' have no overlap.
src/cli/issues.ts(349,77): error TS2345: Argument of type '"failed-agent-review"' is not assignable to parameter of type 'IssueStatus'.
src/cli/run.ts(257,41): error TS2367: This comparison appears to be unintentional because the types 'ReviewMode' and '"agent"' have no overlap.
src/cli/run.ts(1081,32): error TS2345: Argument of type '"failed-agent-review"' is not assignable to parameter of type 'IssueStatus'.
src/cli/run.ts(1170,22): error TS2367: This comparison appears to be unintentional because the types '"human"' and '"agent"' have no overlap.
src/cli/run.ts(1171,38): error TS2345: Argument of type '"needs-agent-review"' is not assignable to parameter of type 'IssueStatus'.
src/cli/run.ts(1546,26): error TS2367: This comparison appears to be unintentional because the types '"human"' and '"agent"' have no overlap.
src/cli/run.ts(1547,43): error TS2345: Argument of type '"needs-agent-review"' is not assignable to parameter of type 'IssueStatus'.
src/cli/run.ts(1591,33): error TS2345: Argument of type '"failed-agent-review"' is not assignable to parameter of type 'IssueStatus'.
src/orchestrate.ts(453,36): error TS2345: Argument of type '"failed-agent-review"' is not assignable to parameter of type 'IssueStatus'.
src/plan/issues.ts(66,3): error TS2820: Type '"failed-agent-review"' is not assignable to type '"blocked" | "done" | "todo" | "needs-human-review" | "failed-gates" | "failed-human-review"'. Did you mean '"failed-human-review"'?
src/tui/screens/composer/composer.ts(134,63): error TS2367: This comparison appears to be unintentional because the types 'ReviewMode' and '"agent"' have no overlap.
src/tui/screens/issue-keys.ts(37,37): error TS2367: This comparison appears to be unintentional because the types '"blocked" | "needs-research" | "researched" | "todo" | "needs-human-review" | "failed-gates" | "failed-human-review" | undefined' and '"needs-agent-review"' have no overlap.
src/tui/screens/issue-keys.ts(57,56): error TS2367: This comparison appears to be unintentional because the types '"human"' and '"agent"' have no overlap.
src/tui/screens/issue-keys.ts(58,34): error TS2345: Argument of type '"agent" | "human" | "none"' is not assignable to parameter of type 'ReviewMode'.
  Type '"agent"' is not assignable to type 'ReviewMode'.
src/tui/screens/tones.ts(19,3): error TS2353: Object literal may only specify known properties, and '"needs-agent-review"' does not exist in type 'Record<DisplayStatus, { tone: string; glyph: string; }>'.
