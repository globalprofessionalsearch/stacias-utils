# Contributing

One strict convention governs this repo. `summon lint` (pre-commit hook + CI)
rejects anything that breaks it. There is no metadata to maintain — the help
text *is* the contract.

## The utility contract

A utility is a top-level directory named in `kebab-case` with a single
executable entrypoint named **`main`**:

```
my-tool/
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

No `bin/` symlink, no README edit, no per-tool skill file. Discovery is
automatic via `summon list`.

## Add one

```bash
mkdir my-tool
$EDITOR my-tool/main && chmod +x my-tool/main
summon lint                       # must pass
git add my-tool
git commit -m "feat: add my-tool" # Conventional Commits, enforced
```

## Reserved names

`list`, `lint`, `commit-lint`, `setup`, `help`, `summon` — dispatcher builtins.

## What belongs here

- ✅ Personal tools used across projects; workflow automation.
- ❌ Project-specific scripts (keep them in the project).
- ❌ One-off experiments (use `experiments/`).
