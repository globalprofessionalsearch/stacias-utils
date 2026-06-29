---
name: digester-explain
description: Analyze and explain why a specific task was prioritized the way it was, or why a message might not have been included in the digest at all. Use when the user questions ranking decisions or wants to understand what factors drove prioritization.
---

# Digester Explain Skill

**Invocation:** `/digester-explain` or `/explain-priority`

**Purpose:** Diagnostic tool for understanding digester's prioritization and filtering decisions.

---

## What This Skill Does

This is a diagnostic tool for understanding digester's decision-making. It:

1. **Inspects task ranking** — looks at where a task sits relative to others
2. **Analyzes against criteria** — compares task content to the prioritization rules in `criteria.yaml`
3. **Explains the reasoning** — provides human-readable rationale for why the task ranked high, low, or wasn't included

Use this when:
- A task you expected to be high-priority ranked lower than expected
- A task ranked higher than you think it should
- An important message was skipped entirely
- You want to understand what factors drive prioritization

---

## Session Flow

### Phase 1: Identify Target

Ask the user what they want explained. Accept:
- **Task rank number** (e.g., "rank 3", "task #5")
- **Task ID** (UUID from state.json)
- **Message-level query** (e.g., "the email about PR #412", "the Slack thread about SAML")
- **General question** (e.g., "why are my PRs ranking so low?")

If the user provides a vague description, help narrow it down by:
1. Reading `state.json` to list recent tasks
2. Showing a few candidates matching their description
3. Asking which one to analyze

### Phase 2: Gather Context

Once you have a target task:

1. **Read state.json**
   - Get the task's messages, category, priority score, status, and rank
   - Get representative content (subject, author, body snippet)
   - Note timestamp and age

2. **Read criteria.yaml**
   - Load the `prioritize` section
   - Note dimensions: blocked_human, shipping_impact, recency, explicit_ask
   - Read examples and counter-examples

3. **Get comparative context**
   - Find 2-3 tasks ranked immediately above the target
   - Find 2-3 tasks ranked immediately below the target
   - Note their categories, priority scores, and representative content

### Phase 3: Analysis

Analyze the target task against the prioritization criteria. Consider:

**Urgency Factors (from criteria.yaml):**
- **Blocked human**: Is a real person waiting for action? (Not a bot or automated notification)
- **Shipping impact**: Does this block a merge, deployment, or release?
- **Recency**: How old is it? Any follow-ups or deadline signals?
- **Explicit ask**: Is it a direct request/question, or passive FYI?

**Category influence:**
- PRs with "changes requested" imply blocking
- Opinion requests may be urgent if tied to a decision deadline
- Topic-sensitive items depend on context (is someone blocked?)
- Repo notifications are often informational unless explicitly requesting review

**Comparative positioning:**
- Why did tasks above it rank higher? What signals do they have that this one lacks?
- Why did tasks below it rank lower? What does this task have that elevates it?

### Phase 4: Explain

Present your findings in clear, structured prose:

#### For a task that's included but ranked unexpectedly:

```
Task #5: [category] "[subject]"
Current rank: #5 of 12 pending tasks
Priority score: 8.0 (scores are relative to the task set at time of run)

Why it ranked here:

[Explain 2-3 key factors. Be specific and cite content.]

Example:
- No blocked human: The PR was already merged by the time this ran, so there's
  no action needed. This dramatically lowers urgency.
  
- Passive notification: The message is a GitHub bot saying "PR #412 was merged",
  not a person asking for something. The criteria prioritize explicit asks.
  
- Recency is moderate: It's 2 days old, which isn't fresh enough to override
  the lack of a blocked human.

Comparison to higher-ranked tasks:
- Task #2 (rank higher): Has "changes requested on your PR" — explicit block
  on shipping, someone is waiting for fixes.
- Task #3 (rank higher): Opinion request with "before EOD" deadline signal.

This ranking makes sense given the criteria. If you want this type of message
to rank higher, consider adding a "merged PR requiring follow-up" category
or adjusting the prioritize examples to emphasize post-merge actions.
```

#### For a message that was skipped:

```
Message: "[subject]" from [author]

Status: Skipped (not included in digest)
Reason: Scored below filter threshold (0.5) for all categories

Why it was filtered out:

[Explain specifically which criteria it failed to match.]

Example:
- Not a pull_request: No PR number or review request language
- Not an opinion_request: No explicit ask for input ("what do you think", etc.)
- Not topic_sensitive: Doesn't mention SAML, SSO, data contracts, or safety keywords
- Not a repo_notification: Sender domain is example.com, not GitHub notifications
  for monitored repos

Closest category match: opinion_request (score: 0.42)
- The email does mention "thoughts on the API design", which is a weak opinion signal
- But the counter-example "FYI — we went with X, just keeping you in the loop"
  likely pulled the score down because this is framed as informational rather than
  a genuine request for input

To include this type of message, you could:
1. Lower FILTER_THRESHOLD in .env (currently 0.5)
2. Add an example to opinion_request that matches this phrasing pattern
3. Create a new category if this represents a distinct class of messages you care about
```

### Phase 5: Recommendations (Optional)

If the user is confused or disagrees with the ranking:

1. **Suggest criteria.yaml edits** — which examples/counter-examples to add
2. **Threshold tuning** — whether to adjust FILTER_THRESHOLD or GROUP_THRESHOLD
3. **Calibration session** — recommend running `/digester-calibrate` to ground
   the criteria in more real examples

---

## Guidelines

- **Be specific**: Quote actual message content and criteria text. Don't speak in generalities.
- **Show your work**: Explain which criteria dimensions applied and why.
- **Compare**: Always contextualize against nearby tasks in the ranking.
- **Be helpful**: If the ranking seems wrong, say so and explain how to fix it.
- **Don't guess**: If the LLM's internal reasoning isn't clear from the criteria,
  acknowledge that and focus on what the criteria explicitly say.

---

## Edge Cases

**User asks about a "done" task:**
- Explain that done tasks are sorted by their original priority score, which may
  not reflect when they were marked done (no `done_at` timestamp exists yet).

**User asks why two similar tasks ranked differently:**
- Do a side-by-side comparison of both, highlighting the differentiating factors.

**User questions the entire digest:**
- Offer to analyze the top 3 and bottom 3 tasks to show the range of urgency signals.

**Task has no priority score:**
- This means it was never run through the prioritize stage (likely created but
  not processed in a `run` yet). Explain this and note it will get a score on next run.

---

## Example Invocations

**User:** "Why did my SAML PR rank #8? That's security-critical!"

**You:**
1. Read state.json, find task #8
2. Note it's category `topic_sensitive`, subject contains "SAML SSO"
3. Check messages — is it a review request, or just a notification?
4. Read criteria.yaml prioritize section
5. Compare to tasks ranked #1-3 (are they blocking people? explicit asks?)
6. Explain: "While SAML is topic-sensitive (correctly filtered), the message is
   a bot commenting 'security scan passed' — no human is blocked. Tasks #1-3
   are all PRs with 'changes requested' or explicit review requests, so they
   correctly rank higher per the 'blocked_human' dimension."

**User:** "I didn't see an email about the infra repo in my digest at all."

**You:**
1. Ask for more details (subject, approximate date)
2. Read state.json, search messages for matching subject/sender
3. If found and skipped: explain which filter category it scored against and why
   it fell below threshold
4. If not in state at all: it may be older than DAYS_BACK or already processed
   in a prior run — check `received_at` and `seen` status

**User:** "Explain task #2."

**You:**
1. Read state.json, get task #2 details
2. Read criteria.yaml
3. Analyze and present structured explanation as shown above

---

## Implementation Notes

This skill is **read-only** — it never modifies state.json, criteria.yaml, or
runs the pipeline. It's purely diagnostic.

The skill operates on the current state of the system. If the user wants to
understand a decision from a previous run, you can only work with what's in
state.json (which persists across runs).

If you determine the ranking is working as designed per the criteria, say so
clearly. If it seems like a bug or criteria mismatch, call that out and suggest
next steps.
