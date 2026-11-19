id: d0d8f4
branch: mc/i-notice-that-the-orchestrator-doesn-t-start-tas-d0d8f4
acceptance: script:build

Auto-created from run.

I notice that the orchestrator doesn't start tasks when they free up from being blocked. This is a long standing issue. For example, if I have 4 tasks and 3 are blocked. once the 1 task finishes unblockin the others, they never start while the orchestrator is running.
