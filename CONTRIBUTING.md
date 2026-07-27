# Contributing

The repo holds two kinds of thing, each in its own top-level directory. Strict
conventions govern them; `summon lint` (pre-commit hook + CI) rejects anything
that breaks one. There is no metadata to maintain — the help text, the
frontmatter, and the plugin manifest *are* the contracts.

```
utilities/<name>/main         executable CLI tool
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

### Add a utility

```bash
mkdir -p utilities/my-tool
$EDITOR utilities/my-tool/main && chmod +x utilities/my-tool/main
summon lint                       # must pass
git add utilities/my-tool
git commit -m "feat: add my-tool" # Conventional Commits, enforced
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
`.claude-plugin/plugin.json` is not a plugin. A plugin's skills each need a
`SKILL.md` opening with a YAML frontmatter block whose `name:` equals the skill
directory and whose `description:` is non-empty (that description is what
`summon list` shows, and what Claude Code matches on to decide when to load the
skill). They take no prefix — the plugin namespaces them already, and they are
invoked as `/<plugin>:<skill>`.

`summon setup` installs plugins into Claude Code; they are never run through
`summon`.

Installs are marketplace-mediated. `plugins/.claude-plugin/marketplace.json` is
an authored file — a product of development, like any other source file — and
adding a plugin means adding it there too. Nothing generates or rewrites it;
`summon lint` checks it stays accurate against what is on disk and names what
is wrong (`name`, each entry's `source`, and plugins listed-but-absent or
present-but-unlisted). Owner and description wording are editorial and not
linted beyond being non-empty.

The repo ships one plugin: the `stacia` umbrella at `plugins/stacia/`. A utility
is a self-contained directory under `plugins/stacia/skills/<utility>/` — its
`SKILL.md` plus whatever `bin/`, code and `test.sh` it needs — invoked as
`/stacia:<utility>`. Adding or removing one is a mkdir or an rm: it never adds a
plugin, so `summon setup` does not need re-running.

### Add a utility to the `stacia` plugin

```bash
mkdir -p plugins/stacia/skills/my-utility
$EDITOR plugins/stacia/skills/my-utility/SKILL.md   # frontmatter: name (== dir), description
summon lint                                          # must pass
git add plugins/stacia/skills/my-utility
git commit -m "feat: add my-utility"
```

No `summon setup` re-run: the plugin is already registered, and its skills ship
with it.

The code-review utility (`plugins/stacia/skills/code-review/`) has its design of
record in the ADR series under `docs/adr/`. Read the relevant ADRs before
changing its coordinator, personas, or schemas — several of its constraints
(read-only subagent confinement, structured output, the TypeScript/Python
helper boundary) are decisions with recorded rationale, not incidental
implementation.

## Reserved names

`list`, `lint`, `commit-lint`, `setup`, `help`, `summon` — dispatcher builtins.
No utility may use them.

## What belongs here

- ✅ Personal tools and Claude Code skills used across projects; workflow automation.
- ❌ Project-specific scripts (keep them in the project).
- ❌ One-off experiments (use `experiments/`).
