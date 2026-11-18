---
name: reference
description: Use when asked to gather, index, or read attributed reference bundles from the central store.
---

# Reference skill

You are gathering and indexing sources, not writing project code.

The store is `~/.machine_code/references/`. It uses the same bundle layout as
OpenCode:

```text
references/
├── index.md                 # generated catalog
├── topics.yaml              # generated topic -> citation map
└── <product>/<version>/
    ├── manifest.yaml        # provenance + status
    ├── index.md             # hand-authored topic map
    ├── api-index.md         # generated symbol -> citation map
    ├── content/*.md         # small cited topic files
    └── raw/                 # originals; never read
```

## Find and read

1. Run `reference:find` with a topic, symbol, product, or phrase. This scans
   the index layer only — never content or raw files.
2. Follow the returned citation with `reference:read` (`path#anchor`).
   `reference:read` takes `path=` only — the `bundle:`/`content:`/`code:`
   selectors belong on `reference:find`. When in doubt, describe the command
   first (`command` tool, `describe` action).
   Bundle-relative `content/…` citations resolve when unambiguous; anything
   ambiguous names its candidates instead of guessing.
3. Cite the exact `~/.machine_code/references/<product>/<version>/content/file.md#anchor`
   and version. Do not crawl `raw/` or guess anchors.
4. Go deeper inside one bundle (`bundle: '<product>/<version>'`, required for
   these tiers): `reference:find` with `content: true` greps `content/**`
   bodies, `code: true` greps non-index bundle files such as a vendored source
   repo (`regex: true` for raw patterns). `reference:read` on a bundle or
   content directory returns a capped listing for discovery, `outline: true`
   lists a file's headings with their `#anchors`, and `offset:`/`lines:` page
   long files. `.git/` and `raw/` are never searched, listed, or read.
5. If the index has no plausible match, search the web with `reference:search`,
   fetch a source with `reference:browser`, or extract a PDF with
   `reference:pdf-extract`.

## Create

1. Write the bundle manifest with `reference:write`
   (`<product>/<version>/manifest.yaml`).
2. Write each content file with front-matter (`topics`, `symbols`, `tokens`)
   and stable `{#anchor}` headings.
3. Write the hand-authored `<product>/<version>/index.md` topic map.
4. Run `reference:reindex` to regenerate the store catalog, topics, and
   `api-index.md`.
5. Reference the result from an issue:

```markdown
<!-- mc:context
{"references":["<product>/<version>/content/file.md#anchor"]}
-->
```

## Rules

- Never write to project code paths. Reference writes are scoped to the store
  or the project reference view.
- Prefer primary sources. Attribute every claim to its source URL.
- Keep one concept per content file; split when larger.
- Read only the exact cited file and anchor. Never load a whole bundle.
- General agent does not get reference commands. Use an agent with `command`.
