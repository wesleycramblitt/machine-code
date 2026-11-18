id: 918ef9
branch: mc/orchestration-is-having-a-lot-of-issues-review-t-918ef9
acceptance: script:build

Auto-created from run.

Orchestration is having a lot of issues. Review the code and make it clean and robust, don't just patch it:

1.) I'll often have 4 processes, and 5 issues ready to start, only 2 will start. This is while processes in the orchestration settings is set to 4
2.) Sometimes when I only have one issue that becomes available, 2 runs start in it at once, and one gets blocked.
