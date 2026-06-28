# Digester Skills

Custom Claude Code skills for working with digester.

## Available Skills

### `/digester-calibrate`
**Purpose:** Improve criteria accuracy by grading real inbox messages  
**When to use:** When filter/group/prioritize decisions feel inaccurate, or when `criteria.yaml` examples feel made-up or thin

Interactive quiz session that:
1. Reviews the last digester run retrospectively
2. Fetches real inbox emails via Gmail
3. Asks you to grade each: include or exclude?
4. Synthesizes your judgments into `criteria.yaml` updates
5. Generalizes examples (strips specific names/IDs to patterns)

**Typical flow:**
```
/digester-calibrate
→ Review last run's included tasks
→ Grade borderline skipped messages
→ Sample new inbox emails
→ Approve criteria diff before writing
```

### `/digester-explain`
**Purpose:** Understand why tasks ranked where they did  
**When to use:** When a task ranked unexpectedly high/low, or when an important message was skipped

Diagnostic analysis that:
1. Reads your current state and criteria
2. Analyzes the target task against prioritization rules
3. Compares to nearby tasks in the ranking
4. Explains which urgency factors applied
5. Suggests criteria adjustments if needed

**Typical flow:**
```
/digester-explain
→ "Why is task #7 ranked so low?"
→ Analyzes task content + comparative context
→ Explains: no blocked human, old, no deadline
→ Suggests: criteria tweaks or manual status change
```

## How Skills Work

Skills are discovered automatically from `.claude/skills/*/SKILL.md` files. Each skill:
- Has a front matter block with `name` and `description`
- Defines a session flow and guidelines
- Is invoked with `/skill-name` in Claude Code

## Related Documentation

- **PRODUCT_BRIEF.md** — Main product documentation, includes skills section
- **ARCHITECTURE.md** — System design and LLM philosophy
- **criteria.yaml** — The tuning surface that skills help you improve
- **state.json** — Current state that `/explain` analyzes

## Skill Development

To create a new digester skill:

1. Create `.claude/skills/my-skill/SKILL.md`
2. Add front matter with `name` and `description`
3. Define the session flow and guidelines
4. Add examples in `EXAMPLES.md` (optional but recommended)
5. Update this README

See existing skills for patterns and conventions.
