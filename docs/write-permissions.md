# Write Permissions

machine_code controls where agents can write and edit files through two
layers: **structural containment** (always-on, not configurable) and
**per-agent allowed paths** (configured in the agent's TOML file).

## Structural containment (always enforced)

These checks apply to every `write` and `edit` call regardless of agent
configuration. They cannot be disabled.

| Protection | Enforcement | Location |
|---|---|---|
| **Worktree isolation** | Mutating runs operate on a separate git worktree at `.machine_code/local/worktrees/<id>/`. The main repo is never mutated directly. | `src/worktree.ts` |
| **Path traversal** | `resolveWithin()` resolves every caller-supplied path against the worktree root and rejects `../` escapes, absolute paths outside the root, and symlink-based escapes that resolve outside the worktree. | `src/tools/safety.ts:57-86` |
| **Secret files** | `isSecretPath()` blocks writes to `.env`, `.env.*`, `*.pem`, `*.key`, `*.p12`, `id_rsa*`, `id_ed25519*`, `.npmrc`, `.netrc`, `.git-credentials`. | `src/tools/safety.ts:41-53, 226-228` |
| **Git/state boundaries** | Mutating typed commands refuse to operate on `.git`, `.machine_code/local`, and secret paths via `commandPath()`. | `src/commands/registry.ts:47-62` |

## Per-agent allowed paths (configurable)

Each agent TOML file can declare an `allowed_paths` list that restricts which
paths the `write` and `edit` tools may target. When set, every write or edit
path is checked against this list before execution. A path is allowed if it
matches any entry as an exact prefix (entry is a parent directory of the
target).

### Semantics

- **Undefined or empty** — all paths are allowed (default for `engineer`).
- **Non-empty list** — only paths under one of the listed prefixes are allowed.
  The match is a prefix check: `"docs/"` allows `"docs/readme.md"` but not
  `"src/docs.go"`.
- Trailing slash is optional: `"docs"` and `"docs/"` behave identically.
- Relative paths only; they are evaluated against the worktree root.

### Configuration chain

`allowed_paths` is part of the agent definition. It can be set in:

1. **Shipped agent defaults** — `data/agents/<name>.toml`
2. **Machine overrides** — `~/.machine_code/data/agents/<name>.toml`
3. **Repo policy overrides** — `.machine_code/agents/<name>.md` (prompt only,
   not config fields)

The agent TOML file from a higher-priority source replaces the lower one
wholesale (same as other agent fields).

### Example: research agent

```toml
# data/agents/research.toml
name = "research"
tools = ["context", "inspect", "map", "glob", "command", "ask", "skill", "write", "finish"]
capabilities = ["code:read", "context:inherit", "knowledge:write"]
allowed_paths = ["issues/", "docs/", ".machine_code/"]
```

The research agent can only write or edit files under `issues/`, `docs/`, and
`.machine_code/`. Trying to write to `src/main.ts` or the worktree root will
fail with:

```
write is restricted to: issues/, docs/, .machine_code/ for this role; got: src/main.ts
```

### Example: engineer agent (no restrictions)

```toml
# data/agents/engineer.toml
name = "engineer"
tools = ["context", "inspect", "write", "edit", "map", "glob", "command", "ask", "artifact", "skill", "finish"]
capabilities = ["code:read", "context:inherit", "code:write", "artifact:provision"]
# no allowed_paths — all paths are writable
```

## Read access

There is no per-agent read-path restriction. The `read`, `map`, `search`,
`glob` and `inspect` tools are controlled by capabilities (`code:read`), not by
path allowlists. An agent with `code:read` can read any file in the worktree
(except secrets). If you need read-scoped agents, add it.

## Implementation

The allowed-paths check lives in `src/tools/index.ts`:

- **`writeTool`** (line 698) — validates `params.path` against
  `ctx.allowedPaths` before resolving and writing.
- **`editTool`** (line 1272) — validates both the single-file `params.path` and
  each entry in `params.files[]` against `ctx.allowedPaths` before executing.
- **`ToolContext.allowedPaths`** (line 86) — passed from `AgentDef` through
  `loop.ts` into every tool's context.
