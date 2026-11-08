# Models
Planning features for providers, models, and associated algorithms in machine_code

# Cooldowns
- Something weird happening with cooldowns. At any given time there are 20-30 listed free models, we'll often try 3 before defaulting to ollama. Ollama should be a final fallback. Is this just because of minimum capability? Cooldowns should reset on every run, doesn't take that long to just ping a model and see if it is up.

# Ollama
- Need a tier specific for local models. Remove local models from free tier as well. Free is free cloud. 
- Local models should know about VRAM, and adjust context accordingly. I have 24GB of VRAM on a 4090, 262k context isn't going to work with a larger 27b model, but would work with smaller 9b models if my math is right? Should be somewhat dynamic.



