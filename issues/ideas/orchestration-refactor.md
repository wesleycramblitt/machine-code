priority: medium
tags: orchestrator

# Orchestration 
Need to plan features carefully for a refactor of the orchestration system. Be clever with the TUI, reusing features where necessary and not overly cluttering ui/ux.

New Modes: All repos vs cwd. 
Start from runs page with confirmation page and settings. 
Tier: Paid, Free (if enabled), Local
Research: fit floors
Engineer: fit floors
Price caps: $-/M in and out
Total Budget: $10 (for the entire orchestration)

Orchestration mode now just starts working on the highest priority, unblocked issues with as many processes as it can. If in free mode, runs indefinitely, if paid, runs under a budget.
Blocked = dependent task not finished, human review needed, other issue level blocked statuses like merge failures.

No per issue orchestration mode since starting a run orchestrates anyway (we now just use acceptance gates for merging and looping)

We need the ability to view orchestration status, stop all orchestration processes, and so on. Probably in the same page as starting an orchestration.


