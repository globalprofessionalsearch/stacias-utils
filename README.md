# Stacia's Utils

Personal command-line **utilities**, agent **skills**, and Claude Code
**plugins** — three kinds of thing, all discovered and wired through one
dispatcher: `summon`.

There is no maintained list and no generated metadata. Everything describes
itself, and `summon` discovers it live:

```bash
summon list                 # utilities, skills, and plugins (name - description)
summon <name> --help        # how a utility works
summon <name> [args...]     # run a utility
```

## Layout

```
utilities/<name>/main                        executable CLI tool
skills/<name>/SKILL.md                       agent skill
plugins/<name>/.claude-plugin/plugin.json    Claude Code plugin manifest
plugins/<name>/skills/<skill>/SKILL.md       a plugin's own skills
```

Everything else at the repo root is infrastructure.

<!-- TODO: `extensions/` holds the legacy pi-harness extension that predates the
     Claude Code port. It is being retired, not extended — delete this note (and
     the directory) once the port lands. -->

## The conventions (enforced)

- **Utilities**: `utilities/<name>/main` is executable and its `--help` exits 0
  and prints `<name> - <one-line description>` on line 1.
- **Skills**: `skills/<name>/SKILL.md` is `stacia-`-prefixed, with frontmatter
  `name` (== dir) and a non-empty `description`. (Harness-neutral content is a
  best practice, not linted.)
- **Plugins**: `plugins/<name>/` has a `.claude-plugin/plugin.json` whose `name`
  equals the directory. A plugin's own skills live at
  `plugins/<name>/skills/<skill>/SKILL.md` and satisfy the same frontmatter
  contract, minus the `stacia-` prefix — they are already namespaced by their
  plugin (`/<plugin>:<skill>`).

Those rules make everything auto-discoverable. `summon lint` enforces all three
(in CI and the pre-commit hook); see `CONTRIBUTING.md`.

## Setup

```bash
git clone git@github.com:globalprofessionalsearch/stacias-utils.git
cd stacias-utils
./summon/main setup          # enables git hooks, installs skills + plugins, prints a shell-rc line
```

Then add the line it prints to your shell rc:

```bash
export PATH="$HOME/Documents/code/github/globalprofessionalsearch/stacias-utils/bin:$PATH"
```

That puts `summon` on PATH. Nothing else needs exporting — run `summon setup`
once, then `summon list`.

<!-- TODO: the exact install mechanism (which directories get written, and how)
     is being reworked alongside the Claude Code port. Until it settles, the
     output of `summon setup` is the source of truth, not this section. -->

## Skills

Skills are agent-skill files (`SKILL.md`) a harness loads on demand. The repo
ships them under `skills/<name>/SKILL.md` (`stacia-utils-usage`,
`stacia-utils-contributing`). Skill dirs are `stacia-`-prefixed so they can't
collide with, or be shadowed by, unrelated skills in the shared skill
directories.

Nothing here is on a harness search path by default — `summon setup` wires the
repo's skills into the agent harness, pointing back into the repo, so edits to a
skill's body are live with no re-sync.

<!-- TODO: which harness the top-level `skills/` tree is wired into is being
     repointed as part of the Claude Code port; `summon setup`'s own output is
     authoritative. Plugin skills (under `plugins/<name>/skills/`) are installed
     with their plugin and are unaffected. -->


Skill bodies should stay harness-neutral (a best practice, not enforced):
describe behavior abstractly rather than naming one harness's delegation tool
or execution flags, so a skill stays portable.

## Plugins

`plugins/<name>/` holds Claude Code plugins — a `.claude-plugin/plugin.json`
manifest plus whatever skills, commands, agents, hooks, or supporting code the
plugin needs. `summon setup` installs them into Claude Code; they are not run
through `summon`, they are invoked in Claude Code as `/<plugin>:<skill>`.

The repo ships **`stacia-code-review`**: an orchestrated, read-only,
multi-perspective code review of a change set, optionally spanning several
repos. It resolves scope and charge conversationally, then runs a bounded
four-stage pipeline (comprehension → review → synthesis → verification) in a
Claude Agent SDK coordinator process with a live monitor. Its design of record
is the ADR series under `docs/adr/`.

## Conventions

- One command on PATH: `summon` (everything else is `summon <name>`).
- Commits / PR titles use [Conventional Commits](https://www.conventionalcommits.org/),
  enforced by the `commit-msg` hook and CI.
- Coding assistants discover everything through the `stacia-utils-usage` skill;
  contributors follow `stacia-utils-contributing`.
