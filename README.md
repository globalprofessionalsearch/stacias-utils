# Stacia's Utils

Personal *nix-style command-line utilities, reached through one dispatcher:
`summon`.

There is no maintained list of tools and no generated metadata. Every utility
describes itself, and `summon` discovers them live:

```bash
summon list                 # what exists (name - description)
summon <name> --help        # how one works
summon <name> [args...]     # run it
```

## The convention (enforced)

A utility is a top-level directory containing an executable `main` whose
`--help` exits 0 and prints, on line 1:

```
<name> - <one-line description>
```

That single rule is what makes tools auto-discoverable. `summon lint` enforces
it (in CI and the pre-commit hook); see `CONTRIBUTING.md`.

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
`using-stacia-utils`, `contributing-stacia-utils`). Nothing in this repo is on
an agent's search path by default — `summon setup` installs them into the
harness-global skill directories:

- **pi** discovers skills in `~/.pi/agent/skills/`, recursing into any
  subdirectory that contains a `SKILL.md`. `summon setup` symlinks each
  `skills/<name>/` into `~/.pi/agent/skills/<name>`, so pi picks them up with no
  registration or config. Because it's a symlink, repo edits are live.
- **Claude Code** discovers flat `~/.claude/skills/<name>.md` files. `summon
  setup` copies each `SKILL.md` there; that's a copy, so re-run `summon setup`
  after editing a skill.

In short: pi knows where the skills are because they live in (or symlink from)
`~/.pi/agent/skills/`, one of pi's built-in global skill locations. Run `summon
setup` once after cloning, and again whenever you add or change a skill.

## Conventions

- One command on PATH: `summon` (everything else is `summon <name>`).
- Commits / PR titles use [Conventional Commits](https://www.conventionalcommits.org/),
  enforced by the `commit-msg` hook and CI.
- Agents discover everything through the `using-stacia-utils` skill; contributors
  follow `contributing-stacia-utils`.
