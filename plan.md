This repo will become a simple, highly efficient coding agent harness

Some early planned features that need to be hashed out:

- Highly simplified provider linking interface
- Plan to keep a catalogue of all available models capabilities, pricing, token limits, and so on
- Simple way to configure model selection, fallback, and so on
- Highly simplified tool call system:
    => Default to sending minimal tools for each task, potentially 0 when possible
    => Include repo specific tools for repetitive tasks
    => Select the base set of tools for maximal efficienc
        => standard methods for code edits, code reads, git management, and so on
    => Potentially having a tool decision model like jev or laya if efficient
- Configurable agent system
    => model selection protocols built in
    => Tool restriction
    => prompting 
    => context maximums
- compaction/context pruning protocol (hopefully make compaction unnecessary all together)
    => default to indexing and documenting in repo. 
    => each prompt unique, with agent access to repo, and surface level information sent to agent
    => index will be git itself, markdown documentation, potentially some sort of other clever index system if necessary
- mcps
    => ability to wire up various mcps
- loop system
    => ability to keep system running after tasks are completed
- remote control
    => email notifications on status updates
    => ability to control system from phone or other devices (sending prompts and so no)
- TUI
    => simple, easy to use TUI with statuses embedded, 
    => allow session to keep running in background or delete them easily
    => see all sessions from any TUI location easily or only project specific ones
    => see all subagents, shells, tool calls, etc easily as well
    => keep a history of tool calls, sessions and so on as a file with a size limit (pruned after size limit) that is easy to access if necessary

# things to figure out
## Agent/Tool call system (potentially experimental design to hash out)
- GOAL: maximum efficiency, reduce mistakes, save tokens, increase speed
- AGENTS: 
    => PLAN 
        => Parameters: 
        => high level planning, no task compilation
        => tools: reading files, web fetch, or looking at references
    => REFERENCE 
        => Parameters: 
        => Maintain reference database
        => Tools: web search, devtools mcp, read books, create references
    => ARCHITECT
        => Parameters: 
        => General reasoning, orchestration of subagents, task compilation
        => Tools: read all files, see indexes, see references, web fetch, see git history, compile tasks packets
    => BUILD
        => Parameters: 
            => testing on/off
                => on:  write thorough test cases and run them after code finished
                => off: Write no test cases, do a quick build and run test case
            => review on/off
                => on: review agent must indepently verify task
                => off: build agent says when task is done
        => Build compiled tasks with limited context and permissions
        => Tools: everything needed for reading, writing, and verifying code
    => REVIEW
        => Final sign off on tasks when enabled. 
        => tools: mostly reading code, compliing and running

- PROJECT SPECIFIC AGENTS:
    => The agents above can then be configured per project with:
        => specialize prompts (that add to or replace the core prompts)
        => specialized tool access (this is the true power):
            => repo specific tools for compiling, running or testing code or other use cases 
        => specialized knowledge specific to the repo
            => important knowledge for each agent, available as an index specific to the agent
- AGENT ORCHESTRATION MODES:
    => LET IT RIP: One agent, all permissions
    => DIRECT: ARCHITECT for planning and task compilation,  CODE for tool execution
    => VERIFIED: ARCHITECT, CODE (with test cases)
    => REDUNDANT: ARCHITECT, CODE (with test cases), REVIEW
- AGENT HARNESS SETTINGS: (determine model selection on each agent)
    => maximum token cost per 1M  (i.e.  $0.30/1M)  
    => free vs paid mode
    => Depending on mode, alsways select the best model for the job by: price, capability, context, inference speed 


# Reference coding agent open source code

Pi (Probably our best base, but you decide): https://github.com/earendil-works/pi
Goose: https://github.com/aaif-goose/goose
Software Agent SDK: https://github.com/OpenHands/software-agent-sdk

A study of current coding agent frameworks: https://github.com/SteveVitali/coding-agent-harness-study
