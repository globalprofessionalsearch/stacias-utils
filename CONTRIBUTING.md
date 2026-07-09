# Contributing

The repo holds two kinds of thing, each in its own top-level directory. Strict
conventions govern them; `summon lint` (pre-commit hook + CI) rejects anything
that breaks one. There is no metadata to maintain — the help text and the
frontmatter *are* the contracts.

```
utilities/<name>/main         executable CLI tool
skills/<name>/SKILL.md         harness-neutral agent skill
```

A skill may additionally ship a workflow-tool `agentType` binding in its own dir
(see the Skill contract) — that is part of the skill, not a separate kind.

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

**Skill-owned workflow `agentType` bindings.** A skill that drives the
pi-dynamic-workflows `workflow` tool may ship an `agentType` *binding*: a
frontmatter-only Markdown file in its own skill dir that binds a subagent's tool
allow-list. The `workflow` tool resolves `agentType` names from `~/.pi/agents/`,
so `summon setup` symlinks the binding there (user scope, any repo). The
code-review skill ships `skills/stacia-code-review/stacia-review-readonly.md`,
granting only read/search tools — this is what makes its review fan-out
tool-level read-only. `summon lint` enforces it: frontmatter block, a
`stacia-`-prefixed `name:`, and a `tools:` **YAML array** (`tools: [read, ...]`;
a comma *string* is silently ignored by the workflow tool) restricted to
non-mutating tools (`read, grep, find, ls, ffgrep, fffind`). The binding lives
with the skill it serves — no separate top-level directory.

### Add one

```bash
mkdir -p skills/stacia-my-skill
$EDITOR skills/stacia-my-skill/SKILL.md
summon lint                          # must pass
summon setup                         # one-time: plant the pi umbrella symlink
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
