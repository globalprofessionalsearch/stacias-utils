# Adding New Utilities

## Structure

```
stacias-utils/
  utility-name/           # Complex utilities with multiple files
    main-script
    helpers.sh
    README.md             # What it does, how to use it
  simple-script           # Simple single-file utilities
  bin/                    # Symlinks only (managed)
```

## Steps to Add a Utility

1. **Create the utility**
   - Single script: Place in root with executable permissions
   - Multi-file: Create a subdirectory with main executable + README.md

2. **Make it executable**
   ```bash
   chmod +x your-script
   ```

3. **Add to PATH**
   ```bash
   cd bin/
   ln -sf ../path/to/your-script friendly-name
   ```

4. **Document it**
   - Add entry to main README.md under "Available Utilities"
   - For complex utilities, include a README.md in its directory

5. **Commit**
   ```bash
   git add .
   git commit -m "feat: add utility-name"
   git push
   ```

## Naming Conventions

- Use kebab-case for symlink names: `my-tool`, not `my_tool` or `myTool`
- Keep names short and descriptive
- Avoid generic names like `util` or `helper`

## Documentation

Each utility should be self-documenting:
- Include `--help` flag
- Add usage examples in comments or README
- Describe what problem it solves

## What Belongs Here

✅ Personal tools used across projects
✅ Workflow automation scripts
✅ CLI utilities for common tasks

❌ Project-specific scripts (those go in the project)
❌ One-off experiments (those go in experiments/)
