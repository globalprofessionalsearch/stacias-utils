---
name: stacia-utils-usage
description: Discover and run Stacia's personal command-line utilities via the `summon` dispatcher. Use this whenever a task might be served by one of Stacia's tools, or when she refers to one of her utilities by name. Do not guess what exists — ask `summon`.
---

# Using Stacia's utilities

All of Stacia's personal CLI utilities are reached through a single command,
`summon`, which is on the PATH. There is **no fixed list to memorize** — the
tools are self-describing, so always discover them live.

## Discover what exists

```bash
summon list
```

Prints a section per kind — **Utilities** (runnable CLI tools), **Skills**
(agent skills), and **Claude Code plugins** — with a one-line description each.
Generated on the fly, so it is always current.

Only utilities are run via `summon <name>`. Skills and plugins are not invoked
through the dispatcher: `summon setup` installs them into the agent harness,
which then loads skills on demand and exposes each plugin's own skills as
`/<plugin>:<skill>` (e.g. `/stacia-code-review:stacia-code-review`).

## Learn one utility

```bash
summon <name> --help
```

Every utility supports `--help` and prints full usage. Read it before running
the tool — flags, subcommands, and side effects are documented there.

## Run a utility

```bash
summon <name> [args...]
```

`summon <name>` is exactly equivalent to running that utility directly; the
dispatcher just locates it. Pass arguments through as usual.

## Rules of thumb

- When unsure whether a tool exists for a task, run `summon list` first.
- Never invent a utility name or flags — confirm with `--help`.
- If `summon list` flags a utility as having no synopsis, it is broken; mention
  it rather than guessing its behavior.
