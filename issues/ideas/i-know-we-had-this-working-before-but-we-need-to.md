id: 1820a6
branch: mc/i-know-we-had-this-working-before-but-we-need-to-1820a6
acceptance: research:verify

Auto-created from run.

I know we had this working before, but we need to add another tier called "Free", making the 3 tiers:   Paid, Free, Local.  At the provider level, only some providers free models work in this setup. Opencode, for example, only allows free usage on their platform. openrouter does work.  We should also remove the cooldown feature. What should happen instead, if free mode is on, try the best free models for the job (for providers that have free models enabled), have an intelligent system, if the provider has a hard rate limit error on all models, switch to a different provider, if none are available, block the run. Careful with the errors, as some are per model rate limits, some of networking bandwith errors. Create detailed issues planning this out. ask if anything is unclear or needs planning.
