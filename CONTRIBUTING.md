# Contributing

The repo holds three kinds of thing, each in its own top-level directory. Strict
conventions govern them; `summon lint` (pre-commit hook + CI) rejects anything
that breaks one. There is no metadata to maintain — the help text and the
frontmatter *are* the contracts.

```
utilities/<name>/main         executable CLI tool
skills/<name>/SKILL.md         harness-neutral agent skill
agents/**/<stacia-name>.md    pi-subagents agent definition (harness-specific)
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

**Harness-neutrality (best practice, not linted):** write skill bodies so a
`SKILL.md` isn't coupled to one harness. Describe behavior abstractly ("launch
parallel read-only subagents, one per perspective, in a single message") rather
than naming a specific harness's delegation tool or execution flags. pi is the
only harness `summon setup` wires today; keeping skills neutral keeps them
portable to others.

`summon setup` installs skills into pi:

- **pi** (recursive discovery): one umbrella symlink `~/.pi/agent/skills/stacia-utils
  -> skills/`. Run-once — new skills are auto-discovered without re-running setup.

Skill-body edits are live (the symlink points back into the repo).

### Add one

```bash
mkdir -p skills/stacia-my-skill
$EDITOR skills/stacia-my-skill/SKILL.md
summon lint                          # must pass
summon setup                         # one-time: plant the pi umbrella symlink
git add skills/stacia-my-skill
git commit -m "feat: add stacia-my-skill skill"
```

## Agent contract

An agent is a [nicobailon `pi-subagents`](https://github.com/nicobailon/pi-subagents)
agent definition: a single Markdown file with YAML frontmatter and a system-prompt
body. Agents live anywhere under `agents/` (group them in subdirs freely —
discovery is recursive):

```
agents/<group>/stacia-my-agent.md   # e.g. agents/code-review/stacia-review-tests.md
```

Each `*.md` under `agents/` (excluding `*.chain.md`) must:

1. Open with a YAML frontmatter block (`---`).
2. Set `name:` to a `kebab-case`, **`stacia-`-prefixed** value that **equals the
   filename stem** (`stacia-review-tests` ⇄ `stacia-review-tests.md`).
3. Set a non-empty `description:` (what `summon list` shows).
4. Use a name unique across the whole `agents/` tree.

The `stacia-` prefix and uniqueness keep these from shadowing other agents in the
shared pi-subagents agent namespace. Beyond `name`/`description`, the frontmatter
is ordinary pi-subagents config (`tools`, `model`, `systemPromptMode`,
`defaultContext`, …); the body is the agent's system prompt.

Unlike skills, agents are **harness-specific by nature** (they target
pi-subagents), so the harness-neutrality guideline does not apply.

**Reviewer agents are read-only.** Any agent named `stacia-review-*` (the
code-review fan-out personas) must declare a non-empty `tools:` field restricted
to `read, grep, find, ls`. `summon lint` enforces this so the fan-out's read-only
isolation can't be silently weakened by adding `bash`/`write`/`edit`. Other
agents may declare whatever tools they need.

`summon setup` exposes the whole tree to pi-subagents through one shell-rc line —
`export PI_SUBAGENT_EXTRA_AGENT_DIRS="<repo>/agents"` — which it scans
**recursively**. This is **run-once**: add an agent and pi-subagents discovers it
with no re-run and no symlink/copy. Edits are live in place.

### Add one

```bash
mkdir -p agents/my-group
$EDITOR agents/my-group/stacia-my-agent.md   # frontmatter name == stem, stacia-prefixed
summon lint                                  # must pass
git add agents/my-group
git commit -m "feat: add stacia-my-agent agent"
```

## Reserved names

`list`, `lint`, `commit-lint`, `setup`, `help`, `summon` — dispatcher builtins.
No utility, skill, or agent may use them.

## What belongs here

- ✅ Personal tools and skills used across projects; workflow automation.
- ❌ Project-specific scripts (keep them in the project).
- ❌ One-off experiments (use `experiments/`).
