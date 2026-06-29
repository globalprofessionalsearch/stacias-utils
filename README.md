# Stacia's Utils

Personal command-line utilities **and** agent skills, reached through one
dispatcher: `summon`.

There is no maintained list and no generated metadata. Everything describes
itself, and `summon` discovers it live:

```bash
summon list                 # utilities and skills (name - description)
summon <name> --help        # how a utility works
summon <name> [args...]     # run a utility
```

## Layout

```
utilities/<name>/main        executable CLI tool
skills/<name>/SKILL.md        harness-neutral agent skill
```

Everything else at the repo root is infrastructure.

## The conventions (enforced)

- **Utilities**: `utilities/<name>/main` is executable and its `--help` exits 0
  and prints `<name> - <one-line description>` on line 1.
- **Skills**: `skills/<name>/SKILL.md` is `stacia-`-prefixed, with frontmatter
  `name` (== dir) and a non-empty `description`. (Harness-neutral content is an
  authoring guideline, not linted.)

Those rules make everything auto-discoverable. `summon lint` enforces both (in
CI and the pre-commit hook); see `CONTRIBUTING.md`.

## Setup

```bash
git clone git@github.com:globalprofessionalsearch/stacias-utils.git
cd stacias-utils
./summon/main setup          # enables git hooks + agent skills, prints PATH line
```

Then add the single PATH entry it prints to your shell rc:

```bash
export PATH="$HOME/Documents/code/github/globalprofessionalsearch/stacias-utils/bin:$PATH"
```

## Agent skills

The repo ships agent skills under `skills/<name>/SKILL.md` (e.g.
`stacia-code-review`, `stacia-utils-usage`, `stacia-utils-contributing`). Skill
dirs are `stacia-`-prefixed so they can't collide with unrelated skills in the
shared directories. Nothing here is on an agent's search path by default —
`summon setup` installs them into both harness-global skill directories by
symlink:

- **pi** discovers skills in `~/.pi/agent/skills/`, recursing into any
  subdirectory that contains a `SKILL.md`.
- **Claude Code** discovers skills in `~/.claude/skills/` with the same
  `<name>/SKILL.md` layout.

`summon setup` symlinks each `skills/<name>/` into both locations (and prunes
its own stale symlinks), so edits in the repo are live. Because skills are
harness-neutral, the same `SKILL.md` serves both. Run `summon setup` once after
cloning, and again whenever you add or remove a skill.

## Conventions

- One command on PATH: `summon` (everything else is `summon <name>`).
- Commits / PR titles use [Conventional Commits](https://www.conventionalcommits.org/),
  enforced by the `commit-msg` hook and CI.
- Agents discover everything through the `stacia-utils-usage` skill; contributors
  follow `stacia-utils-contributing`.
