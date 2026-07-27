# Contributing

The repo holds three kinds of thing, each in its own top-level directory. Strict
conventions govern them; `summon lint` (pre-commit hook + CI) rejects anything
that breaks one. There is no metadata to maintain — the help text, the
frontmatter, and the plugin manifest *are* the contracts.

```
utilities/<name>/main         executable CLI tool
skills/<name>/SKILL.md         harness-neutral agent skill
plugins/<name>/                Claude Code plugin
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
than naming a specific harness's delegation tool or execution flags. Claude
Code is the harness the repo is standardizing on; keeping skills neutral keeps
them portable to others.

`summon setup` wires the repo's skills into the agent harness, pointing back
into the repo — so skill-body edits are live, with no re-sync and no re-run.

<!-- OPEN: the top-level `skills/` tree is still installed into pi
     (`~/.pi/agent/skills/`) by one umbrella symlink. The code-review port moved
     off pi; this tree has not followed yet. Until it does, `summon setup`'s
     output is the source of truth, not this paragraph. -->

### Add one

```bash
mkdir -p skills/stacia-my-skill
$EDITOR skills/stacia-my-skill/SKILL.md
summon lint                          # must pass
summon setup                         # one-time: wire the skill into the harness
git add skills/stacia-my-skill
git commit -m "feat: add stacia-my-skill skill"
```

## Plugin contract

A plugin is a directory under `plugins/` named in `kebab-case`, whose
entrypoint is its manifest:

```
plugins/my-plugin/
  .claude-plugin/plugin.json    # "name" must equal the directory name
  skills/<skill>/SKILL.md       # optional: the plugin's own skills
  ...                           # commands, agents, hooks, supporting code
```

The manifest is what Claude Code reads — a directory without a valid
`.claude-plugin/plugin.json` is not a plugin. A plugin's own skills satisfy the
same frontmatter contract as `skills/` (frontmatter block, `name:` equal to the
skill dir, non-empty `description:`) but do **not** take the `stacia-` prefix:
they are already namespaced by their plugin and are invoked as
`/<plugin>:<skill>`.

`summon setup` installs plugins into Claude Code; they are never run through
`summon`.

Installs are snapshots, not symlinks: `claude plugin install` copies the plugin
into `~/.claude/plugins/cache/`, so re-run `summon setup` after editing one (or
use `claude --plugin-dir <repo>/plugins/<name>` while iterating).

The repo ships one plugin: `plugins/stacia-code-review/`, whose design of
record is the ADR series under `docs/adr/`. Read the relevant ADRs before
changing its coordinator, personas, or schemas — several of its constraints
(read-only subagent confinement, structured output, the TypeScript/Python
helper boundary) are decisions with recorded rationale, not incidental
implementation.

## Reserved names

`list`, `lint`, `commit-lint`, `setup`, `help`, `summon` — dispatcher builtins.
No utility or skill may use them.

## What belongs here

- ✅ Personal tools and skills used across projects; workflow automation.
- ❌ Project-specific scripts (keep them in the project).
- ❌ One-off experiments (use `experiments/`).
