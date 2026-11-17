id: 487cd4
branch: mc/when-orchestrating-when-a-run-becomes-blocked-on-487cd4
commit: 0337be96a3c3a62f09561c185979066ce7a710aa
acceptance: research:verify

Auto-created from run.

When orchestrating, when a run becomes blocked on an issue, we shouldn't keep spamming runs on that issue. I propose a feature that would help with that and also other use cases. In hte same way "depends" can block an issue, there should be a blocked flag we can add, either manually on the issue or when a run on it is blocked. The orchestrator doesn't pick up blocked issues until they are unblocked.  This terminalology should be clean. Honestly, I just realized we should probably put this issue and other's that are blocked by dependencies into a "blocked" status. Would make it much easier to read on the runs page. Lets play with ideas for naming this and how it function. Use the ask tool a lot.
