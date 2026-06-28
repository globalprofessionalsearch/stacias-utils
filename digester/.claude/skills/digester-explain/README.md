# Digester Explain Skill

A diagnostic tool for understanding why digester prioritized tasks the way it did.

## Quick Start

In Claude Code, type:
```
/digester-explain
```

Then describe what you want explained:
- "Why is task #7 ranked so low?"
- "I didn't see an email about API design — why?"
- "Explain the top 3 tasks"
- "Why did the Slack thread beat the PR review?"

## What It Does

This skill analyzes your current `state.json` and `criteria.yaml` to explain:

1. **Which urgency factors applied** — blocked_human, shipping_impact, recency, explicit_ask
2. **How the task compared to others** — what made nearby tasks rank higher/lower
3. **Why messages were filtered out** — which category they failed to match
4. **What you can do about it** — criteria adjustments or threshold tuning

## Files

- **SKILL.md** — Full skill definition (read this to understand the implementation)
- **EXAMPLES.md** — Four example sessions showing the skill in action
- **README.md** — This file

## Related Skills

- **`/digester-calibrate`** — Improve criteria accuracy by grading real inbox messages
- **`/digester-explain`** — Understand why decisions were made (this skill)

## Philosophy

This is a **read-only diagnostic tool**. It never modifies your state or criteria — it just helps you understand what happened and suggests changes you can make manually.

The skill assumes you've run `digester run` at least once so there's state to analyze.
