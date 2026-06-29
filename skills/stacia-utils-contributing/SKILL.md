---
name: stacia-utils-contributing
description: How to add or modify a utility, skill, or pi-subagents agent in Stacia's stacias-utils repo so it satisfies the enforced contracts. Use this whenever creating or editing a utility, skill, or agent, or when `summon lint` fails.
---

# Contributing to stacias-utils

Stacia's `stacias-utils` repo holds three kinds of thing, each in its own
top-level directory, governed by enforced contracts. `summon lint` (run in
CI and the pre-commit hook) rejects anything that breaks them. There is no
metadata file to maintain — the help text and frontmatter are the contracts.

```
utilities/<name>/main         executable CLI tool
skills/<name>/SKILL.md         harness-neutral agent skill
agents/**/<stacia-name>.md    pi-subagents agent definition (harness-specific)
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

Skills SHOULD also be **harness-neutral** (best practice, not linted): describe
behavior abstractly so a skill isn't coupled to one harness. Prefer "launch
parallel read-only subagents, one per perspective, in a single message" over
naming a specific harness's delegation tool or its execution flags. pi is the
only harness `summon setup` wires today; keeping skills neutral keeps them
portable to others.

```bash
mkdir -p skills/stacia-my-skill
$EDITOR skills/stacia-my-skill/SKILL.md
summon lint          # must pass
summon setup         # one-time: plants the pi umbrella symlink; then auto-discovered
git add skills/stacia-my-skill
git commit -m "feat: add stacia-my-skill skill"
```

## The agent contract

An agent is a [nicobailon `pi-subagents`](https://github.com/nicobailon/pi-subagents)
agent definition: a single Markdown file with YAML frontmatter and a
system-prompt body. Agents live anywhere under `agents/` — group them in
subdirectories freely, since discovery is recursive:

```
agents/<group>/stacia-my-agent.md   # e.g. agents/code-review/stacia-review-tests.md
```

Each `*.md` under `agents/` (excluding `*.chain.md`) MUST:

1. Open with a YAML frontmatter block (`---`).
2. Set `name:` to a `kebab-case`, **`stacia-`-prefixed** value that **equals the
   filename stem** (`stacia-review-tests` ⇄ `stacia-review-tests.md`).
3. Set a non-empty `description:` (what `summon list` shows).
4. Use a name unique across the whole `agents/` tree.

The `stacia-` prefix and uniqueness stop these from shadowing other agents in
the shared pi-subagents agent namespace. Everything else in the frontmatter is
ordinary pi-subagents config (`tools`, `model`, `systemPromptMode`,
`defaultContext`, …); the body is the agent's system prompt. Unlike skills,
agents are **harness-specific by nature** (they target pi-subagents), so the
harness-neutrality guideline does not apply.

Discovery is **run-once**: `summon setup` prints a shell-rc line
(`export PI_SUBAGENT_EXTRA_AGENT_DIRS="<repo>/agents"`) that pi-subagents scans
recursively. Add an agent and it is discovered with no re-run, no symlink, no
copy. Edits are live in place.

```bash
mkdir -p agents/my-group
$EDITOR agents/my-group/stacia-my-agent.md   # name == stem, stacia-prefixed
summon lint          # must pass
git add agents/my-group
git commit -m "feat: add stacia-my-agent agent"
```

## Reserved names

A utility, skill, or agent may not be named: `list`, `lint`, `commit-lint`,
`setup`, `help`, or `summon` (these are dispatcher builtins).

## Conventions

- Commits and PR titles follow Conventional Commits (`feat:`, `fix:`, `docs:`,
  `chore:`, ...); enforced by `commit-msg` hook and CI.
- Project-specific or one-off scripts do **not** belong here.
- Run `summon lint` locally; if it fails, fix the reported violation — do not
  work around the linter.
