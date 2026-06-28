---
name: contributing-stacia-utils
description: How to add or modify a utility in Stacia's stacias-utils repo so it satisfies the enforced contract. Use this whenever creating a new utility, editing an existing one, or when `summon lint` fails.
---

# Contributing a utility

Stacia's `stacias-utils` repo enforces one strict convention. `summon lint`
(run in CI and the pre-commit hook) rejects anything that breaks it. Follow
this exactly — there is no metadata file to maintain, the contract is the help
text itself.

## The contract

A utility is a top-level directory named in `kebab-case` containing a single
executable entrypoint named **`main`**:

```
my-tool/
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

That is the whole contract. No `bin/` symlink, no README edit, no skill file —
discovery is automatic.

## Add a utility

```bash
mkdir my-tool
$EDITOR my-tool/main
chmod +x my-tool/main
summon lint          # must pass before committing
git add my-tool
git commit -m "feat: add my-tool"
```

## Reserved names

A utility may not be named: `list`, `lint`, `commit-lint`, `setup`, `help`, or
`summon` (these are dispatcher builtins).

## Conventions

- Commits and PR titles follow Conventional Commits (`feat:`, `fix:`, `docs:`,
  `chore:`, ...); enforced by `commit-msg` hook and CI.
- Project-specific or one-off scripts do **not** belong here.
- Run `summon lint` locally; if it fails, fix the reported violation — do not
  work around the linter.
