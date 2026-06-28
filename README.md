# Stacia's Utils

Personal utilities and tools.

## Setup

Clone and configure git hooks:

```bash
git clone git@github.com:globalprofessionalsearch/stacias-utils.git
cd stacias-utils
git config core.hooksPath .githooks
```

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
