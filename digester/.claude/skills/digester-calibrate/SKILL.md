---
name: digester-calibrate
description: Use when digester's filter/group/prioritize criteria feel inaccurate, when criteria.yaml examples feel made-up or thin, or when you want to ground the scoring in real inbox emails through an interactive quiz session.
---

# Digester: Calibrate Criteria from Real Email

## Overview
Run a two-phase calibration session: first review the last digester run retrospectively by reading `state.json` (covering filtering, grouping, and prioritization decisions), then quiz against real inbox emails via Gmail. Both phases feed into the same synthesis step, updating `examples` and `counter_examples` in `criteria.yaml`.

## Before Starting
Load Gmail tool schemas via ToolSearch: `select:mcp__claude_ai_Gmail__search_threads,mcp__claude_ai_Gmail__get_thread`

Read `/Users/joe/Documents/code/sandbox/digester/criteria.yaml` to know the current categories and their signals.

Read `/Users/joe/Documents/code/sandbox/digester/state.json` to reconstruct the last digester run.

## Step 0 — Retrospective Review

Parse state.json into three groups:

**Included tasks**: emails where `skipped=0`, grouped by `task_id`. For each task, look up its `priority` in the `tasks` dict and sort descending — highest priority = rank #1. The representative email for a task is the first one in the group.

**Borderline skipped emails**: emails where `skipped=1`, filtered to those that look work-relevant — i.e., sender domain is `@github.com`, `@jeenie.com`, `@atlassian.net`, `@jeenie.atlassian.net`, or subject contains PR/review/mention keywords. Exclude obvious noise: calendar bot emails, mass marketing, statuspage alerts, Datadog/Appbot digests. Aim for 6–10.

**All skipped** (for priority review only): full count, not shown individually.

If state.json has no emails, skip to Step 1.

Otherwise ask:
```
Found [N] included tasks and [M] skipped emails in the last run.
Run retrospective review? [Y]es / [S]kip to new email sampling
```

### Phase A — Included tasks

Present each included task in priority order (rank #1 first):

```
─── Included Task #N/Total ─ [CATEGORY] ────────
Subject:  [representative subject]
From:     [sender]
Grouped:  [count] email(s) in this task
────────────────────────────────────────────────
Should this have been included? [Y]es / [N]o / [S]kip
```

**If No:** Ask — "Brief reason?" → `counter_example` for the assigned category.

**If Yes:** Ask — "Was `[CATEGORY]` the right category? [Y]es / [N]o"
- If No: "Which correct category?" → `example` for correct + `counter_example` for wrong.
- If Yes: note as confirmed (add as `example` only if the category is thin).

**Grouping (tasks with >1 email):** After confirming inclusion, ask:
```
These [N] emails were grouped as one task — does that make sense? [Y]es / [N]o
```
- If No: "Which emails should be separate?" → note as `group.counter_examples` in synthesis.

### Phase B — Borderline skipped emails

After Phase A, present the borderline skipped emails:

```
─── Skipped Email N/Total ──────────────────────
Subject: [subject]
From:    [sender]
Date:    [date]
────────────────────────────────────────────────
Should this have been included? [Y]es / [N]o / [S]kip
```

**If Yes:** "Which category?" → `example` for that category (this is a false negative — high value).

**If No:** "Brief reason? (press Enter to skip)" → `counter_example` if reason given.

### Phase C — Priority order

Show the full ranked task list:
```
Priority ranking:
  #1 [CATEGORY] Subject...
  #2 [CATEGORY] Subject...
  ...

Does this ordering feel right? [Y]es / or describe what's off (press Enter to skip)
```

If the user identifies a misordering, note the pair and reason as a `prioritize` example or counter_example in synthesis.

## Step 1 — Sample Emails

Fetch two pools using `mcp__claude_ai_Gmail__search_threads`:

**Pool A — Decision zone** (emails that look like they might match):
Build a query from current filter signals, e.g.:
```
("review requested" OR "changes requested" OR "your thoughts" OR "opinion" OR "globalprofessionalsearch") newer_than:30d
```
Take up to 10 results.

**Pool B — Likely negatives** (recent inbox that doesn't match signals):
```
is:inbox newer_than:30d -"review requested" -"changes requested" -globalprofessionalsearch
```
Take up to 8 results.

Merge both pools and shuffle so quiz order is unbiased. Aim for 12–18 emails total.

For each thread, call `mcp__claude_ai_Gmail__get_thread` and extract the most recent message:
- Subject
- From
- Date
- First 200 characters of body (strip quoted text and HTML)

## Step 2 — Run the Quiz

Present emails one at a time. Format each card as:

```
─── Email N/Total ─────────────────────────
Subject: [subject]
From:    [sender]
Date:    [date]

[snippet, max 200 chars]
────────────────────────────────────────────
Include in digest? [Y]es / [N]o / [S]kip
```

**If Yes:** Ask — "Which category? (pull_request / opinion_request / repo_notification / or type a new name)"

**If No:** Ask — "Brief reason? (helps build counter-examples — press Enter to skip)"

**If Skip:** Move on, no judgment recorded.

Collect all answers in a running list: `{subject, sender, snippet, decision, category, reason}`.

## Step 3 — Synthesize

Merge answers from the retrospective (Step 0) and the Gmail quiz (Steps 1–2):

**Gmail quiz — Yes answers** → `examples` entry under the named category.

**Gmail quiz — No answers with reason** → `counter_examples` under whichever existing category the email most resembles (use signal overlap to decide).

**Phase A — should not have been included** → `counter_example` for the assigned category, with the user's reason.

**Phase A — included but wrong category** → `example` for the correct category + `counter_example` for the wrong category.

**Phase A — correctly included and correct category** → `example` for that category (skip if the category already has several examples).

**Phase A — grouping was wrong** → `group.counter_examples` entry with the two email subjects and why they don't belong together.

**Phase B — skipped email that should have been included** → `example` for the named category (false negative — treat as high priority).

**Phase B — skipped email confirmed correctly filtered** → `counter_example` for the most-resembling category, with the user's reason.

**Phase C — priority misordering** → `prioritize.examples` or `prioritize.counter_examples` entry capturing the pair and why one should rank higher.

### Generalize before writing

Strip specific identifiers from all examples and counter-examples before writing them to `criteria.yaml`. Specific handles, PR numbers, and ticket IDs teach the model the wrong thing — it learns a name, not a pattern.

| Replace | With |
|---------|------|
| `@mgornik`, `@akif-ali-10p`, any handle | `[teammate]` |
| `PR #412`, `#25`, any PR number | `#[N]` or omit |
| `YEL-1184`, `TEA-1611`, any ticket ID | `[TICKET-ID]` or omit |
| Specific commit SHAs | omit |

Keep: repo names (they are signals), topic keywords (SAML, SSO, data contract), action verbs (requested your review, mentioned you, do double check).

**New category names** → propose a new category block with description and ask the user for signals before adding.

**Pairs for grouping** → if two Yes emails appeared that clearly belong to the same task (same PR, same thread), offer to add them as a `group.examples` entry.

Show a diff summary of proposed changes before touching the file:
```
Would add to pull_request.examples:
  + "Stacia, can you review PR #88 before we merge?"

Would add to pull_request.counter_examples:
  + text: "PR #310 merged by devbot"
    reason: automated, no action needed

Apply these changes? [Y]es / [E]dit / [N]o
```

## Step 4 — Update criteria.yaml

If approved, write changes to `/Users/joe/Documents/code/sandbox/digester/criteria.yaml`.
- Append new entries to existing `examples` and `counter_examples` lists
- Deduplicate by text before writing
- **Order matters — apply the ordering rules below after every write**

## Ordering rules (primacy/recency bias)

The criteria YAML becomes Qwen's **system message**; the email being scored is the **user message**. This means:

- `counter_examples` land last in the system message — closest to the query — and get slightly more weight. This is intentional: you *want* the "score low" calibration freshest.
- Within `examples`, **primacy matters**: the first entry anchors what the category *means*. Later entries refine but with diminishing influence.

**After writing new entries, reorder each list:**

| List | Rule |
|------|------|
| `examples` | Most representative / clearest include-case **first**. Abstract or borderline cases **last**. |
| `counter_examples` | Clearest exclusions **first**. Most common false-positive patterns (the ones that keep sneaking through) **last** — they benefit from recency proximity to the query. |

Example: if Gemini meeting notes keep being falsely included, that counter-example should sit at the *end* of its list, not the beginning.

## Tips
- Counter-examples with specific reasons are the highest-value output — gently encourage reasons on No answers
- 3–4 sessions over a few days gives better coverage than one large session
- Pool A emails that score No are especially valuable — they're the false-positive boundary
- Skip is better than a wrong answer; don't pressure for a judgment on ambiguous emails
- Example quality matters more than order, but at the margin, ordering is a free improvement — always apply it
