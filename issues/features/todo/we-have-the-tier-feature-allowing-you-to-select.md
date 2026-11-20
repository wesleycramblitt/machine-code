id: af1854
branch: mc/we-have-the-tier-feature-allowing-you-to-select-af1854
acceptance: script:build

Auto-created from run.

We have the Tier feature, allowing you to select Paid, Free, Local. For new runs and orchestrations, we also need a fallback tier. We could call it Tier2 of None, Free, local, Paid.  Tier 2 can't be the same as tier one. It hsould be configurable in the cli or TUI, and be None by default.  The point of it if if all models and provider options are exhausted by tier 1, tier 2 is activated. This is per run. If a run is resumed, the tier sequence happens again (first tier and fallback only if necessary).
