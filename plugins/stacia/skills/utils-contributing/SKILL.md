---
name: utils-contributing
description: How to add or modify a utility, agent skill, or Claude Code plugin in Stacia's stacias-utils repo so it satisfies the enforced contracts. Use this whenever creating or editing a utility, skill, or plugin there, or when `summon lint` fails.
---

# Contributing to stacias-utils

Stacia's `stacias-utils` repo holds two kinds of thing, each in its own
top-level directory, governed by enforced contracts. `summon lint` (run in CI
and the pre-commit hook) rejects anything that breaks them. There is no
metadata file to maintain — the help text, the frontmatter, and the plugin
manifest are the contracts.

```
utilities/<name>/main         executable CLI tool
plugins/<name>/                Claude Code plugin
```

## The utility contract

A utility is a directory under `utilities/` named in `kebab-case` containing a
single executable entrypoint named **`main`**:

```
utilities/my-tool/
  main          # executable, starts with a shebang (#!...)
  ...           # any supporting files (not on PATH)
```

`my-tool/main` MUST:

1. Be executable (`chmod +x`) and start with a shebang. Any language is fine
   (`#!/usr/bin/env bash`, `#!/usr/bin/env python3`, a compiled binary via a
   wrapper, etc.). The file must be named exactly `main` — no `main.py`.
2. Support `--help`, which **exits 0** and prints help to **stdout**.
3. Make **line 1 of `--help`** a man-page-style synopsis, in exactly this form:

   ```
   my-tool - one-line description of what it does
   ```

   That single line is what `summon list` harvests. The name must match the
   directory name; the description must be non-empty.

That is the whole utility contract. No `bin/` symlink, no README edit —
discovery is automatic.

```bash
mkdir -p utilities/my-tool
$EDITOR utilities/my-tool/main
chmod +x utilities/my-tool/main
summon lint          # must pass before committing
git add utilities/my-tool
git commit -m "feat: add my-tool"
```

## The plugin contract

A plugin is a directory under `plugins/` named in `kebab-case`, whose
entrypoint is its manifest:

```
plugins/my-plugin/
  .claude-plugin/plugin.json    # "name" MUST equal the directory name
  skills/<skill>/SKILL.md       # optional: the plugin's own skills
  ...                           # commands, agents, hooks, supporting code
```

The manifest is what Claude Code reads — a directory without a valid
`.claude-plugin/plugin.json` is not a plugin. Each of a plugin's skills needs a
`SKILL.md` opening with a YAML frontmatter block whose `name:` equals the skill
directory and whose `description:` is non-empty. That description is both what
`summon list` shows and what Claude Code matches on to decide when to load the
skill, so write it as a trigger ("Use this when…"), not a title. Skills take no
prefix — the plugin namespaces them, and they are invoked as
`/<plugin>:<skill>`.

`summon setup` installs plugins into Claude Code; they are never run through
`summon`. Installs are marketplace-mediated: `plugins/` is itself the
marketplace, and `plugins/.claude-plugin/marketplace.json` is an authored file
listing each plugin. Adding a plugin means adding it there too — nothing
generates that file, and `summon lint` reports exactly where it has stopped
matching what is on disk.

The repo ships one plugin: the `stacia` umbrella at `plugins/stacia/`. A utility
is a self-contained directory under `plugins/stacia/skills/<utility>/`, invoked
as `/stacia:<utility>`; adding or removing one never requires re-running
`summon setup`. The marketplace manifest is generated from the directory scan —
never hand-edit it.

The code-review utility (`plugins/stacia/skills/code-review/`) has its design of
record in the ADR series under `docs/adr/`; read the relevant ADRs before
changing its coordinator, personas, or schemas, because several of its
constraints (read-only subagent confinement, structured output, the
TypeScript/Python helper boundary) are recorded decisions rather than
incidental implementation.

## Reserved names

A utility or skill may not be named: `list`, `lint`, `commit-lint`, `setup`,
`help`, or `summon` (these are dispatcher builtins).

## Conventions

- Commits and PR titles follow Conventional Commits (`feat:`, `fix:`, `docs:`,
  `chore:`, ...); enforced by `commit-msg` hook and CI.
- Project-specific or one-off scripts do **not** belong here.
- Run `summon lint` locally; if it fails, fix the reported violation — do not
  work around the linter.
