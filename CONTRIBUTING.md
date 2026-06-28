# Adding New Utilities

## Standard Layout (required)

Every utility is a **directory** named after the tool, containing a single
**`main` entrypoint** at its root. No bare scripts at the repo root.

```
stacias-utils/
  my-tool/                # Directory named after the tool (kebab-case)
    main                  # Entrypoint (main, main.py, main.go, ...)
    helpers.sh            # Internal files (not on PATH)
    README.md             # Optional: details for complex tools
  bin/
    my-tool -> ../my-tool/main   # One symlink per tool (the only PATH entry)
```

This mirrors the Go `cmd/<name>/main.go` convention, generalized across
languages (bash `main`, Python `main.py`, etc.). A tool with multiple
sub-commands uses one `main` that dispatches (see `gcp-db-proxy`).

> Repo tooling (`sync-skills`, `gen-readme`) is exempt from this layout.

## Steps to Add a Utility

1. **Create the directory + entrypoint**
   ```bash
   mkdir my-tool
   $EDITOR my-tool/main          # or main.py, main.go, ...
   chmod +x my-tool/main
   ```

2. **Add a description** so it auto-documents in the README. Either:
   - a `# desc: <one line>` header in `main`, or
   - a `skills/my-tool/SKILL.md` with a `description:` frontmatter field.

3. **Expose on PATH** with a single symlink:
   ```bash
   ln -sf ../my-tool/main bin/my-tool
   ```

4. **Commit** (the `pre-commit` hook regenerates the README + syncs skills):
   ```bash
   git add .
   git commit -m "feat: add my-tool"
   git push
   ```

## Naming Conventions

- Directory and symlink share the same kebab-case name: `my-tool`
- Entrypoint is always `main` (plus language extension if needed)
- Keep names short and descriptive; avoid generic names like `util`/`helper`

## Documentation

Each utility should be self-documenting:
- Include `--help` flag
- Add usage examples in comments or README
- Describe what problem it solves

### Adding Skills for Agent Discovery

**For pi:**
1. Create `skills/utility-name/SKILL.md` in this repo
2. Symlink to pi: `ln -sf ~/Documents/code/github/globalprofessionalsearch/stacias-utils/skills/utility-name ~/.pi/agent/skills/utility-name`

**For Claude Code:**
1. Create `~/.claude/skills/utility-name.md` with YAML frontmatter:
   ```markdown
   ---
   name: utility-name
   description: Brief description
   ---
   
   # Usage details here
   ```

Skills help AI agents discover and use your utilities automatically.

## What Belongs Here

✅ Personal tools used across projects
✅ Workflow automation scripts
✅ CLI utilities for common tasks

❌ Project-specific scripts (those go in the project)
❌ One-off experiments (those go in experiments/)
