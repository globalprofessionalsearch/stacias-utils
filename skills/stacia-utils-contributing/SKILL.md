---
name: stacia-utils-contributing
description: How to add or modify a utility, agent skill, or Claude Code plugin in Stacia's stacias-utils repo so it satisfies the enforced contracts. Use this whenever creating or editing a utility, skill, or plugin there, or when `summon lint` fails.
---

# Contributing to stacias-utils

Stacia's `stacias-utils` repo holds three kinds of thing, each in its own
top-level directory, governed by enforced contracts. `summon lint` (run in CI
and the pre-commit hook) rejects anything that breaks them. There is no
metadata file to maintain — the help text, the frontmatter, and the plugin
manifest are the contracts.

```
utilities/<name>/main         executable CLI tool
skills/<name>/SKILL.md         harness-neutral agent skill
plugins/<name>/                Claude Code plugin
```

`extensions/` holds a legacy pi-harness extension that predates the Claude Code
port. It is being retired — do not add to it.

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

## The skill contract

A skill is a directory under `skills/` named in `kebab-case` and **prefixed with
`stacia-`** (so it can't shadow, or be shadowed by, unrelated skills installed
in the shared harness skill directories). It contains a `SKILL.md` whose YAML
frontmatter is the contract:

```
skills/stacia-my-skill/
  SKILL.md      # frontmatter: name (== dir) + non-empty description
  references/   # optional supporting files
```

`SKILL.md` MUST:

1. Open with a YAML frontmatter block (`---`).
2. Set `name:` equal to the directory name (which starts with `stacia-`).
3. Set a non-empty `description:` (what `summon list` shows).

Skills SHOULD also be **harness-neutral** (best practice, not linted): describe
behavior abstractly so a skill isn't coupled to one harness. Prefer "launch
parallel read-only subagents, one per perspective, in a single message" over
naming a specific harness's delegation tool or its execution flags. Claude Code
is the harness the repo is standardizing on; keeping skills neutral keeps them
portable to others.

`summon setup` wires the repo's skills into the agent harness, pointing back
into the repo — so skill-body edits are live, with no re-sync and no re-run.
Which harness the top-level `skills/` tree is wired into, and by what
mechanism, is being repointed as part of the Claude Code port: treat the output
of `summon setup` as authoritative over any path written down here.

```bash
mkdir -p skills/stacia-my-skill
$EDITOR skills/stacia-my-skill/SKILL.md
summon lint          # must pass
summon setup         # one-time: wire the skill into the harness
git add skills/stacia-my-skill
git commit -m "feat: add stacia-my-skill skill"
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
`.claude-plugin/plugin.json` is not a plugin. A plugin's own skills satisfy the
same frontmatter contract as `skills/` (frontmatter block, `name:` equal to the
skill dir, non-empty `description:`) but do **not** take the `stacia-` prefix:
they are already namespaced by their plugin and are invoked as
`/<plugin>:<skill>`.

`summon setup` installs plugins into Claude Code; they are never run through
`summon`. The install mechanism is being reworked alongside the Claude Code
port — run `summon lint` and trust its errors over any path written down here.

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
