---
name: using-stacia-utils
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

Prints one line per utility: `name - one-line description`. This is generated
on the fly from each utility, so it is always current.

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
