# Overview
This file details upgrades or issues to be planned for the TUI

# New Run Page
## Context body
- The Context subtabs should be in this order:  Issues, Plans, Knowledge, Skills, Scripts, Tools, Codebase, References, Agent Prompt, Files
- The context skills subtab needs more visual color and icon encodings for skill statuses.
- When changing mode of a skill, they move in a confusing way. There should also be a symbol for each mode: on-demand could use a yellow symbol?
- The context tools subtab needs a "required" indicator remove "space ..." from the bottom if you can't edit their availability
- The Prompt sub tab should be "Agent Prompt", and shouldn't have green checkmarks or a space key command. Mostly informational, just scroll it and see total context.
- Several sub tabs say "0 tok" at the top instead of summing up tokens


- The prompt box should have vim keybindings and a cursor (vim like), and a key binding for clearing it. (we don't need the key commands listed in this case).
- Can move the Prompt[p] key command into the actual prompt like this: "Prompt[p] Press p to type a new prompt"
- When a run is started, we should go to a blank run details page with partial information filled in until the run starts (then fill the rest in). Currently it goes to the runs page for a moment, confusing.
- Probably need somewhere we can see the repo map and semantic index visually?

- [ ] Feature #164: Runs page hierarchy colors, branch/orchestration visibility, cwd default, PR removal

# Orchestration


# Run details Page


# Models Page
- Can't see the selected item (hover color or indicator) when hovering a major category (like a provider)

# Spend Page


