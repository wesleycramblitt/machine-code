priority: low
tags: models

# Models:
1.) Keep models up to date per provider. How do we do this currently and what would make it more effective?
For example, a lot of models are temporary or change ids and suddenly don't work.  

2.) Setting for free cloud models enabled:  False/True. (doesn't affect local models) We already have this off now, but I wanted to make it less hacky. A true setting of enabling/disabling free models across all providers.

3.) During runs: Local models shouldn't have timeouts on model calls (can take a long time if queued behind other calls on the GPU)

