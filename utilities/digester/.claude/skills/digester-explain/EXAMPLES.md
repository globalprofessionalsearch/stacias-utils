# Digester Explain - Example Sessions

## Example 1: Task Ranked Lower Than Expected

**User:** `/digester-explain`  
Why is my PR review for the auth service ranked #7? That seems really important.

**Assistant:**
Let me analyze task #7 for you.

*[reads state.json, finds task #7]*

```
Task #7: PULL_REQUEST "Review requested: auth-service PR #156 - add RBAC"
Current rank: #7 of 9 pending tasks
Priority score: 3.0
Age: 4 days old
Messages: 1
```

*[reads criteria.yaml prioritize section]*

**Why it ranked here:**

1. **No blocked human (yet)**: The message is the initial review request from 4 days ago. There are no follow-ups, no "changes requested", and no deadline mentioned. While the PR exists, there's no signal that anyone is actively blocked waiting for your review right now.

2. **Recency penalty**: At 4 days old, this is the second-oldest pending task. The prioritize criteria include "More recent follow-ups or explicit deadline signals increase urgency" — this has neither.

3. **No explicit urgency signal**: The message says "review requested" but doesn't include phrases like "before we can merge", "blocking the sprint", or "needed by EOD".

**Comparison to higher-ranked tasks:**

- **Task #1** (rank higher): PR with "changes requested" on _your_ PR — you're blocking a merge
- **Task #3** (rank higher): Opinion request with "need your input before EOD" — explicit deadline
- **Task #5** (rank higher): Slack thread with 3 replies from teammates after your last message — active conversation awaiting response

**Comparison to lower-ranked tasks:**

- **Task #8** (rank lower): Bot notification about CI passing — no human involved
- **Task #9** (rank lower): FYI email about a merged PR — informational only

**Assessment:**

The ranking is working as designed. The criteria prioritize "blocked_human" and "shipping_impact" — tasks where someone is _actively blocked right now_. Your auth service PR is important but lacks urgency signals.

**To change this:**

1. **If someone is actually blocked**: Ask them to send a follow-up or comment on the PR with context like "blocking our security audit" — that would create a new message that groups into this task and likely boost its priority.

2. **Adjust criteria**: If initial review requests should always rank high regardless of follow-ups, add an example to `criteria.yaml`:
   ```yaml
   examples:
     - a: "Initial review request on security-related PR"
       b: "FYI notification about unrelated topic"
       reason: "Security PRs should rank high even without explicit urgency"
   ```

3. **Manual override**: Run `digester 7 active` to mark it active, which will move it to the top section regardless of priority score.

---

## Example 2: Message Not Included

**User:** `/digester-explain`  
I got an email from Sarah about API design but don't see it in my digest. Why?

**Assistant:**
Let me search for that message.

*[reads state.json, searches for recent messages from Sarah about API]*

Found it:

```
Message ID: <abc123@example.com>
Subject: "Quick thoughts on the /users endpoint"
From: Sarah Chen <sarah@example.com>
Status: SKIPPED (filtered out)
Received: 2 days ago
```

**Why it was filtered out:**

The message scored below the filter threshold (0.5) for all categories. Let me break down why:

*[reads criteria.yaml filter section]*

**Category scores** (estimated based on criteria):

- **pull_request**: ~0.1 — No PR number, no "review requested" language
- **opinion_request**: ~0.45 — Closest match! The subject says "Quick thoughts" which is opinion-adjacent
- **topic_sensitive**: ~0.1 — Doesn't mention SAML, SSO, security, safety, or data contracts
- **repo_notification**: ~0.0 — Not from GitHub notifications

**Why opinion_request scored too low:**

Looking at the message body:
> "Hey! Just wanted to share my thoughts on the /users endpoint design we discussed. I went with REST for now since that's what the team decided. Let me know if you have any concerns."

This matches the counter-example pattern:
```yaml
counter_examples:
  - text: "FYI — we went with Kafka, just keeping you in the loop"
    reason: "informational only, no input requested"
  - text: "the team decided to use Postgres — let me know if you have concerns"
    reason: "decision already made, no genuine opinion requested"
```

The key phrase "the team decided" + "let me know if you have concerns" signals _post-decision notification_, not a genuine request for input. This is exactly what the second counter-example targets.

**To include this type of message:**

**Option 1 - Lower threshold** (affects everything):
```bash
# In .env
FILTER_THRESHOLD=0.4  # Was 0.5
```
This would include more borderline messages across all categories.

**Option 2 - Adjust criteria** (more targeted):

If you want post-decision "let me know concerns" messages to be included, add an example to `opinion_request`:
```yaml
examples:
  - "team decided on REST for /users endpoint — let me know concerns"
```

Or if this represents a distinct pattern you care about, create a new category:
```yaml
decision_notification:
  description: "FYI about a technical decision with optional feedback window"
  signals:
    - "decided"
    - "went with"
    - "concerns"
```

**Option 3 - Run calibration**:

Run `/digester-calibrate` and when shown similar skipped messages, mark them as "include" to strengthen the criteria with real examples.

**My recommendation:**

This seems like it's working correctly — the message is truly informational since the decision is already made. If Sarah's input is important to you regardless of whether she's asking a question, consider adding a `signals` entry for her name specifically, or create a "team_updates" category for post-decision FYIs you want to track.

---

## Example 3: Comparative Analysis

**User:** `/digester-explain`  
Why did the Slack thread rank higher than the PR review?

**Assistant:**
Let me compare those two tasks side by side.

*[reads state.json to find both tasks]*

**Task #2** (ranked higher): OPINION_REQUEST
```
Subject: "#eng-platform: thoughts on migrating to Datadog?"
Messages: 4 (conversation thread)
Age: 6 hours old
Latest message: "@stacia following up on this — need to decide by Friday"
```

**Task #5** (ranked lower): PULL_REQUEST
```
Subject: "Review requested: infra-tools PR #89"
Messages: 1
Age: 1 day old
Latest message: "mgornik requested your review on infra-tools"
```

*[reads criteria.yaml]*

**Why the Slack thread ranked higher:**

1. **Explicit deadline**: "need to decide by Friday" is a clear urgency signal that matches the prioritize example: "we need your sign-off before EOD to unblock the sprint"

2. **Active conversation**: 4 messages with a follow-up ("following up on this") shows someone is actively waiting and has circled back

3. **Direct mention**: The latest message includes "@stacia", which is a direct call for your attention

4. **Recent activity**: Latest message is 6 hours old vs 1 day for the PR

**Why the PR ranked lower:**

1. **No follow-up**: Just the initial review request, no indication anyone is blocked yet
2. **No deadline**: No "blocking" or "need by X" language
3. **Repo context**: "infra-tools" isn't in your monitored repo list (which includes analysis-mono, analysis-protos, jeenius-bmad, etc.)

**Key criteria at play:**

From `prioritize.dimensions`:
- ✅ **blocked_human**: Slack thread has someone waiting for a decision
- ✅ **explicit_ask**: Slack has direct @mention + "need to decide"
- ✅ **recency**: Slack thread is fresher with recent follow-up

This aligns with the prioritize philosophy: _"A task is more urgent if someone is blocked waiting on me, particularly with respect to shipping code."_

The Slack thread has a blocked human (needs decision by Friday), while the PR is an initial request with no blocking signal yet.

**Does this make sense?**

If you believe PR reviews should always outrank opinion requests regardless of deadline signals, you'd need to add a prioritize counter-example:
```yaml
counter_examples:
  - a: "Slack opinion request with deadline"
    b: "PR review request in any repo"
    reason: "Code reviews always take precedence over opinion questions"
```

But that would be a significant shift in philosophy — currently the system prioritizes "who is blocked right now" over "what type of work is it".

---

## Example 4: General System Question

**User:** `/digester-explain`  
Why do bot notifications seem to rank so low?

**Assistant:**
Great question — this is by design. Let me show you why.

*[reads criteria.yaml prioritize section]*

The prioritize criteria explicitly deprioritize bot/automated messages via the `blocked_human` dimension:

```yaml
dimensions:
  - name: "blocked_human"
    description: "A real person (not a bot) cannot proceed until Stacia responds"
```

And there's a counter-example that reinforces this:

```yaml
counter_examples:
  - a: "automated security scan found 3 warnings in analysis-protos"
    b: "[teammate] is asking for your review on the data model PR"
    reason: "A looks urgent but is automated with no human blocked; B has a real person waiting"
```

**In practice, this means:**

❌ **Low priority** (no blocked human):
- "CI passed on PR #123" (GitHub Actions bot)
- "Security scan found 3 warnings" (automated scanner)
- "PR #123 was merged" (merge bot notification)

✅ **High priority** (real person blocked):
- "Changes requested on your PR" (teammate waiting for fixes)
- "Can you review this PR?" (explicit human request)
- "@stacia thoughts on this approach?" (direct question)

**Exception: topic_sensitive**

Even bot messages get a boost if they're about sensitive topics:

```yaml
examples:
  - "automated scan comment on a SAML SSO PR — topic sensitivity overrides bot-source rule"
```

So a security scanner commenting on a SAML or auth PR might still rank higher than expected.

**Checking your actual digest:**

*[would read state.json to find bot messages and their ranks]*

If you're seeing bot notifications you don't care about at all, they should be:
1. Filtered out entirely (not passing the filter threshold), or
2. Ranking at the very bottom of pending tasks

If they're ranking in the middle or high, that would indicate either:
- They're not being detected as bot messages (criteria might need adjustment)
- They contain urgency signals that override the bot penalty

Want me to analyze a specific bot notification that ranked unexpectedly?
