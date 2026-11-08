# Legacy plans (read-only)

Work moved to `issues/`:

```
issues/
  ideas/<slug>.md              # needs research
  ideas/.researched/<slug>.md  # researched
  features/{todo,blocked,done}/<slug>.md
  bugs/{todo,blocked,done}/<slug>.md
```

Use `machine_code issue move <slug> <todo|blocked|done|researched>` or
`git mv`. `machine_code plan` and the Runs page render the issues tree.
The files below are historical design notes and are not read by agents.
