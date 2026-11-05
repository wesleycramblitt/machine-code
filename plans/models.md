# Overview
Planning features for providers, models, and associated algorithms in machine_code

# Cooldowns
- Something weird happening with cooldowns. At any given time there are 20-30 listed free models, we'll often try 3 before defaulting to ollama. Ollama should be a final fallback. Is this just because of minimum capability? Cooldowns should reset on every run, doesn't take that long to just ping a model and see if it is up.



