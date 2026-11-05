# Overview
This file details upgrades or issues to be planned for the TUI

# New Run Page
- When starting a new run from Feature #0 or Task #0, the prompt should be blank. The default "Implement ..." prompt isn't useful in this case.
- The Context subtabs should be in this order:  Issues, Plans, Knowledge, Skills, Scripts, Tools, Codebase, References, Agent Prompt, Files
- The prompt box should have vim keybindings and a cursor (vim like).
- When a run is started, we should go to a blank run details page with partial information filled in until the run starts (then fill the rest in). Currently it goes to the runs page for a moment, confusing.
- When changing mode of a skill, they move in a confusing way. There should also we a symbol for each mode: on-demand could use a yellow symbol?
- The Prompt sub tab should be "Agent Prompt", and shouldn't have green checkmarks or a space key command. Mostly informational, just scroll it and see total context.
- Several sub tabs say "0 tok" at the top instead of summing up tokens
- Probably need somewhere we can see the repo map and semantic index visually?

# Runs Page
- Color encodings for epic vs feature vs task would help a lot for visiblity. Maybe on the issue number?
- Now that we have f for cwd vs all, overall status as a group is redundant

# Orchestration

# Run details Page


# Models Page
- Can't see the selected item when hovering a major category (like a provider)

# Spend Page


# Settings Page
