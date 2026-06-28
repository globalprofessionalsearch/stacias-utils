# Stacia's Utils

Personal utilities and tools.

## Setup

Clone and configure:

```bash
git clone git@github.com:globalprofessionalsearch/stacias-utils.git
cd stacias-utils
git config core.hooksPath .githooks
```

## Add to PATH

Add to your shell config (`~/.zshrc` or `~/.bashrc`):

```bash
export PATH="$HOME/Documents/code/github/globalprofessionalsearch/stacias-utils/bin:$PATH"
```

Then reload: `source ~/.zshrc`

## Available Utilities

- `ctx` - Switch gcloud and k8s contexts
- `classify-repos` - Organize code repositories
- `present` - Terminal presentation tool
- `whoneedsme` - Analyze code dependencies
- `pr-overview` - GitHub PR summary tool
- `connect-to-database` - Connect to Cloud SQL via bastion
- `verify-db-requirements` - Check database prerequisites

## Commit Convention

This repository uses [Conventional Commits](https://www.conventionalcommits.org/):

```
type(scope?): subject

feat:     New feature
fix:      Bug fix
docs:     Documentation
chore:    Maintenance
```

Enforced via git hooks (client) and GitHub Actions (PRs).
