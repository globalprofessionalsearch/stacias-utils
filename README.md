# Stacia's Utils

Personal command-line **utilities** and a Claude Code **plugin** — two kinds of
thing, both discovered and wired through one dispatcher: `summon`.

There is no maintained list and no generated metadata. Everything describes
itself, and `summon` discovers it live:

```bash
summon list                 # utilities and plugins (name - description)
summon <name> --help        # how a utility works
summon <name> [args...]     # run a utility
```

## Layout

```
utilities/<name>/main                        executable CLI tool
plugins/<name>/.claude-plugin/plugin.json    Claude Code plugin manifest
plugins/<name>/skills/<skill>/SKILL.md       a plugin's skills
```

Everything else at the repo root is infrastructure.

## The conventions (enforced)

- **Utilities**: `utilities/<name>/main` is executable and its `--help` exits 0
  and prints `<name> - <one-line description>` on line 1.
- **Plugins**: `plugins/<name>/` has a `.claude-plugin/plugin.json` whose `name`
  equals the directory, and is listed in the marketplace manifest. A plugin's
  skills live at `plugins/<name>/skills/<skill>/SKILL.md` with frontmatter
  `name` (== dir) and a non-empty `description`. They need no prefix — the
  plugin already namespaces them (`/<plugin>:<skill>`).

Those rules make everything auto-discoverable. `summon lint` enforces both (in
CI and the pre-commit hook); see `CONTRIBUTING.md`.

## Setup

```bash
git clone git@github.com:globalprofessionalsearch/stacias-utils.git
cd stacias-utils
./summon/main setup          # enables git hooks, installs the plugin, prints a shell-rc line
```

Then add the line it prints to your shell rc:

```bash
export PATH="$HOME/Documents/code/github/globalprofessionalsearch/stacias-utils/bin:$PATH"
```

That puts `summon` on PATH. Nothing else needs exporting — run `summon setup`
once, then `summon list`.

Claude Code plugins install through a local marketplace: `plugins/` is itself
the marketplace, and `summon setup` registers it once. Its manifest
(`plugins/.claude-plugin/marketplace.json`) is authored and committed — add a
plugin there when you add one under `plugins/`. `summon lint` checks it stays
accurate and says what is wrong; it never rewrites it.

`setup` runs once because there is one umbrella plugin, `stacia`. Utilities live
under `plugins/stacia/skills/<utility>/`, so adding or removing one never adds a
plugin and never needs a re-run.

## Plugins

`plugins/<name>/` holds Claude Code plugins — a `.claude-plugin/plugin.json`
manifest plus whatever skills, commands, agents, hooks, or supporting code the
plugin needs. `summon setup` installs them into Claude Code; they are not run
through `summon`, they are invoked in Claude Code as `/<plugin>:<skill>`.

The repo ships one plugin, the **`stacia`** umbrella. Each utility is a
self-contained directory under `plugins/stacia/skills/<utility>/` — `SKILL.md`
plus whatever `bin/`, code and `test.sh` it needs — invoked as
`/stacia:<utility>`. Deleting the directory removes the utility outright.

Utilities:

- **`/stacia:utils-usage`** — how to discover and run the command-line
  utilities in this repo via `summon`. Coding assistants load this to find out
  what exists rather than guessing.
- **`/stacia:utils-contributing`** — how to add or modify a utility or plugin
  here so it satisfies the contracts `summon lint` enforces.
- **`/stacia:code-review`** — an orchestrated, read-only, multi-perspective code
  review of a change set, optionally spanning several repos. It resolves scope
  and charge conversationally, then runs a bounded four-stage pipeline
  (comprehension → review → synthesis → verification) in a Claude Agent SDK
  coordinator process with a live monitor. Its design of record is the ADR
  series under `docs/adr/`.

## Conventions

- One command on PATH: `summon` (everything else is `summon <name>`).
- Commits / PR titles use [Conventional Commits](https://www.conventionalcommits.org/),
  enforced by the `commit-msg` hook and CI.
- Coding assistants discover everything through `/stacia:utils-usage`;
  contributors follow `/stacia:utils-contributing`.
