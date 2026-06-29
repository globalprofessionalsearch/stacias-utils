# Contributing

The repo holds two kinds of thing, each in its own top-level directory. Two
strict conventions govern them; `summon lint` (pre-commit hook + CI) rejects
anything that breaks either. There is no metadata to maintain — the help text
and the skill frontmatter *are* the contracts.

```
utilities/<name>/main        executable CLI tool
skills/<name>/SKILL.md        harness-neutral agent skill
```

Everything else at the repo root (`bin/`, `summon/`, `.github/`, ...) is
infrastructure.

## Utility contract

A utility is a directory under `utilities/` named in `kebab-case` with a single
executable entrypoint named **`main`**:

```
utilities/my-tool/
  main          # executable, shebang on line 1, named exactly `main`
  helpers.*     # supporting files (not on PATH)
```

`my-tool/main` must:

1. Be executable and start with a shebang (`#!...`). Any language.
2. Support `--help`: exit `0`, write to **stdout**.
3. Print line 1 of `--help` as a man-page synopsis, exactly:

   ```
   my-tool - one-line description
   ```

   Name matches the directory; description is non-empty.

### Add one

```bash
mkdir -p utilities/my-tool
$EDITOR utilities/my-tool/main && chmod +x utilities/my-tool/main
summon lint                       # must pass
git add utilities/my-tool
git commit -m "feat: add my-tool" # Conventional Commits, enforced
```

## Skill contract

A skill is a directory under `skills/` named in `kebab-case` and **prefixed with
`stacia-`**, with a `SKILL.md` whose YAML frontmatter is the contract:

```
skills/stacia-my-skill/
  SKILL.md      # frontmatter: name (== dir), description (non-empty)
  references/   # optional supporting files
```

`SKILL.md` must:

1. Open with a YAML frontmatter block (`---`).
2. Set `name:` equal to the directory name (which starts with `stacia-`).
3. Set a non-empty `description:` (this is what `summon list` shows).

The `stacia-` prefix is enforced so a skill can't shadow, or be shadowed by,
unrelated skills that land in the shared harness skill directories.

**Harness-neutrality (authoring guideline, not linted):** write skill bodies so
the same `SKILL.md` works in pi and Claude. Describe behavior abstractly
("launch parallel read-only subagents, one per perspective, in a single
message") rather than naming a specific harness's delegation tool or execution
flags.

`summon setup` installs skills into both harnesses:

- **pi** (recursive discovery): one umbrella symlink `~/.pi/agent/skills/stacia-utils
  -> skills/`. Run-once — new skills are auto-discovered without re-running setup.
- **Claude Code** (top-level scan only): one symlink per skill under
  `~/.claude/skills/`. Re-run `summon setup` after adding/renaming a skill to
  expose it in Claude.

Skill-body edits are live in both (symlinks point back into the repo).

### Add one

```bash
mkdir -p skills/stacia-my-skill
$EDITOR skills/stacia-my-skill/SKILL.md
summon lint                          # must pass
summon setup                         # symlink into pi + claude
git add skills/stacia-my-skill
git commit -m "feat: add stacia-my-skill skill"
```

## Reserved names

`list`, `lint`, `commit-lint`, `setup`, `help`, `summon` — dispatcher builtins.
No utility or skill may use them.

## What belongs here

- ✅ Personal tools and skills used across projects; workflow automation.
- ❌ Project-specific scripts (keep them in the project).
- ❌ One-off experiments (use `experiments/`).
