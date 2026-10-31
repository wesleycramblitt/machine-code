# machine_code
A simple, Linux-first coding-agent tool.

## Requirements
Node 22+ and the six-CLI base palette (`git`, `rg`, `ast-grep`, `jq`, `yq`, `sd`).
Provider keys come from environment variables only (e.g. `OPENROUTER_API_KEY`,
`OPENCODE_API_KEY`) — never from files machine_code writes.

## Setup
```
npm install && npm run build
node dist/cli.js install   # installs any missing base CLIs (pinned static binaries)
node dist/cli.js init      # checks CLIs, config, and repo layout
node dist/cli.js catalogue refresh
```

## M0 usage
```
node dist/cli.js run --mode solo --agent general "summarize README.md"
node dist/cli.js providers            # key sources and model counts (never values)
node dist/cli.js log <run-id>         # run summary + events
node dist/cli.js status               # recent runs
```

Design: [plan.md](plan.md).
