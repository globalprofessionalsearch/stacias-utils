# Stacia's Utils

Personal command-line utilities **and** agent skills, reached through one
dispatcher: `summon`.

There is no maintained list and no generated metadata. Everything describes
itself, and `summon` discovers it live:

```bash
summon list                 # utilities, skills, and agents (name - description)
summon <name> --help        # how a utility works
summon <name> [args...]     # run a utility
```

## Layout

```
utilities/<name>/main         executable CLI tool
skills/<name>/SKILL.md         harness-neutral agent skill
agents/**/<stacia-name>.md    pi-subagents agent definition (harness-specific)
```

Everything else at the repo root is infrastructure.

## The conventions (enforced)

- **Utilities**: `utilities/<name>/main` is executable and its `--help` exits 0
  and prints `<name> - <one-line description>` on line 1.
- **Skills**: `skills/<name>/SKILL.md` is `stacia-`-prefixed, with frontmatter
  `name` (== dir) and a non-empty `description`. (Harness-neutral content is an
  authoring guideline, not linted.)
- **Agents**: `agents/**/<name>.md` is a pi-subagents definition; frontmatter
  `name` is `stacia-`-prefixed, equals the filename stem, and is unique, with a
  non-empty `description`. (Harness-specific by nature.)

Those rules make everything auto-discoverable. `summon lint` enforces all three
(in CI and the pre-commit hook); see `CONTRIBUTING.md`.

## Setup

```bash
git clone git@github.com:globalprofessionalsearch/stacias-utils.git
cd stacias-utils
./summon/main setup          # enables git hooks + skills, prints shell-rc lines
```

Then add the two lines it prints to your shell rc:

```bash
export PATH="$HOME/Documents/code/github/globalprofessionalsearch/stacias-utils/bin:$PATH"
export PI_SUBAGENT_EXTRA_AGENT_DIRS="$HOME/Documents/code/github/globalprofessionalsearch/stacias-utils/agents"
```

The first puts `summon` on PATH. The second exposes every agent under `agents/`
to pi-subagents, scanned recursively — run-once, new agents auto-discovered.

## Agent skills

The repo ships agent skills under `skills/<name>/SKILL.md` (e.g.
`stacia-code-review`, `stacia-utils-usage`, `stacia-utils-contributing`). Skill
dirs are `stacia-`-prefixed so they can't collide with unrelated skills in the
shared directories. Nothing here is on an agent's search path by default —
`summon setup` installs them into both harness-global skill directories by
symlink:

- **pi** discovers skills in `~/.pi/agent/skills/` **recursively**. `summon
  setup` plants a single umbrella symlink `~/.pi/agent/skills/stacia-utils ->
  skills/`, so pi sees every current *and future* skill. This is **run-once**:
  add a skill to the repo and pi picks it up with no re-run.
- **Claude Code** scans only the **top level** of `~/.claude/skills/` (no
  recursive discovery), so each skill needs its own top-level symlink. `summon
  setup` creates one per skill and prunes stale ones. **Re-run `summon setup`
  after adding or renaming a skill** if you want it available in Claude.

Because the symlinks point back into the repo, edits to a skill's body are live
in both harnesses with no re-sync. pi is the primary harness and is run-once;
Claude requires a `summon setup` re-run per skill added.

## Agents

The repo also ships [pi-subagents](https://github.com/nicobailon/pi-subagents)
agent definitions under `agents/**/<stacia-name>.md` (e.g. the read-only
reviewers under `agents/code-review/` used by the `stacia-code-review` skill).
They are not on any search path by default — `summon setup` prints a single
`PI_SUBAGENT_EXTRA_AGENT_DIRS` shell-rc line that exposes the whole `agents/`
tree to pi-subagents, scanned **recursively**. This is **run-once**: add an agent
and pi-subagents discovers it with no re-run, no symlink, no copy. Edits are live
in place. (Agents are harness-specific — they target pi-subagents — unlike the
harness-neutral skills.)

## Conventions

- One command on PATH: `summon` (everything else is `summon <name>`).
- Commits / PR titles use [Conventional Commits](https://www.conventionalcommits.org/),
  enforced by the `commit-msg` hook and CI.
- Agents discover everything through the `stacia-utils-usage` skill; contributors
  follow `stacia-utils-contributing`.
