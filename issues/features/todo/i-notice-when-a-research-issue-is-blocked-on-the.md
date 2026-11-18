id: 742a64
branch: mc/i-notice-when-a-research-issue-is-blocked-on-the-742a64
acceptance: script:build

Auto-created from run.

I notice when a research issue is blocked on the final merge into main, the issue switchesto "researched" even though main doesn't have the changes. I already merged the branch manually to fix this particular issue, but prevent that from happening in the future. The run will say "blocked" while the issue is listed as researched. I assume it probably also happens to features and bugs.
