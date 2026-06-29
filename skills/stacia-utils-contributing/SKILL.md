---
name: stacia-utils-contributing
description: How to add or modify a utility or skill in Stacia's stacias-utils repo so it satisfies the enforced contracts. Use this whenever creating or editing a utility or skill, or when `summon lint` fails.
---

# Contributing to stacias-utils

Stacia's `stacias-utils` repo holds two kinds of thing, each in its own
top-level directory, governed by two enforced contracts. `summon lint` (run in
CI and the pre-commit hook) rejects anything that breaks them. There is no
metadata file to maintain — the help text and skill frontmatter are the
contracts.

```
utilities/<name>/main        executable CLI tool
skills/<name>/SKILL.md         harness-neutral agent skill
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

Skills SHOULD also be **harness-neutral** (authoring guideline, not linted):
describe behavior abstractly so the same skill works in pi and Claude. Prefer
"launch parallel read-only subagents, one per perspective, in a single message"
over naming a specific harness's delegation tool or its execution flags.

```bash
mkdir -p skills/stacia-my-skill
$EDITOR skills/stacia-my-skill/SKILL.md
summon lint          # must pass
summon setup         # symlink into ~/.pi and ~/.claude
git add skills/stacia-my-skill
git commit -m "feat: add stacia-my-skill skill"
```

## Reserved names

A utility or skill may not be named: `list`, `lint`, `commit-lint`, `setup`,
`help`, or `summon` (these are dispatcher builtins).

## Conventions

- Commits and PR titles follow Conventional Commits (`feat:`, `fix:`, `docs:`,
  `chore:`, ...); enforced by `commit-msg` hook and CI.
- Project-specific or one-off scripts do **not** belong here.
- Run `summon lint` locally; if it fails, fix the reported violation — do not
  work around the linter.
