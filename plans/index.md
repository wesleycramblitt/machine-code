# Plans (legacy)

Older plan files are kept as a read-only bridge while work moves to
`issues/` (see `plans/index.md`). New work belongs in the issues tree:

```
issues/
  ideas/needs-research|researched|archived/
  features/needs-planning|ready|in-progress|done|archived/
  bugs/needs-planning|ready|in-progress|done|archived/
```

Each issue is YAML front-matter (`priority`, `prompt`, `depends`, `tags`,
`review`) plus markdown. Status is a directory; move work with
`machine_code issue move <slug> <status>`. `machine_code plan` renders the
tree; the Runs page shows the same hierarchy.
