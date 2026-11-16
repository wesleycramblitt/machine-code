id: e9cee3
branch: mc/when-orchestrating-every-time-a-new-run-starts-t-e9cee3
commit: 29e934626098ff10ec4fe7a40f1e339ff2c5267f
acceptance: script:build

Auto-created from run.

When orchestrating, every time a new run starts, the screen jumps to that run. This is problematic, at times I can be writing a prompt in a new issue or run when this happens, discarding my changes. For orchestration specifically, don't jump to new runs when they start, That feature can stay for new runs that are started directly.
