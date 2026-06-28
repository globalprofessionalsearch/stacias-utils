# Architecture

## Purpose

Digester is a personal attention-management tool. It fetches messages from communication sources, identifies which ones require the user's action, groups related messages into tasks, ranks those tasks by urgency, and presents a digest. All intelligence runs on a local LLM.

---

## Core Abstractions

### Message

The fundamental unit of the system. A **message** is a normalized representation of a communication from any source. It carries fields meaningful to the pipeline — subject, author, body, timestamp, thread identity, and contextual signals like whether the user was directly addressed — but carries no knowledge of where it came from or how it was retrieved.

The message schema is the contract between sources and the pipeline. Sources produce messages. The pipeline consumes them. Neither layer knows how the other works.

### Task

A **task** is a logical unit of work represented by one or more messages. Messages are grouped into tasks during the pipeline. The user works with tasks, not individual messages. A task has a status (`pending`, `active`, `done`) set by the user and persists across runs.

### Source

A **source** is any system that produces messages — email, Slack, or others. Each source is responsible for three things only:

1. **Fetching** — connecting to its system, retrieving new messages, and normalizing them to the message schema
2. **Syncing category labels** — writing back the pipeline's output to the source system, if the source supports it
3. **Syncing task status** — reflecting status changes (active/done) back to the source system, if supported

Sources that have no write-back capability implement sync operations as no-ops. The pipeline does not know or care which sources support write-back.

---

## The Protocol Boundary

**The most important architectural rule:** domain-specific knowledge must not cross the boundary between sources and the pipeline.

Everything that requires understanding how a source works — its authentication model, its API semantics, its internal identifiers, its connection lifecycle — belongs inside the source. The pipeline receives only normalized messages and routes sync calls back to the originating source by name.

This means:
- The pipeline never opens a network connection
- The pipeline never references source-specific identifiers (IMAP sequence numbers, Slack timestamps, etc.)
- No source-specific fields appear in the message schema
- Adding a new source requires no changes to the pipeline

A source may maintain internal state or mappings (e.g. a mapping from a message's normalized ID to a source-internal identifier needed for label writes) but must never expose those to the pipeline.

---

## The Pipeline

The pipeline is a sequence of source-agnostic transformations over a pool of messages:

```
Fetch → Filter → Group → Prioritize → Sync → Deliver
```

**Fetch** — each configured source is asked for its new messages. The results are merged into a single pool. The pipeline does not distinguish between sources from this point forward.

**Filter** — each message is scored against configured categories using the local LLM. Messages that score below a threshold for all categories are marked as skipped and excluded from further stages.

**Group** — filtered messages are assigned to tasks. Messages sharing a thread identity are grouped deterministically (no LLM call needed). Messages from different threads are compared pairwise by the LLM. New messages are compared against existing tasks carried forward from prior runs, so follow-ups join existing tasks rather than creating duplicates.

**Prioritize** — tasks are sorted by urgency via pairwise LLM comparisons. Each comparison asks whether task A is more urgent than task B and returns a signed score. The full ordering is derived from these pairwise results.

**Sync** — the pipeline's output (category assignments, seen status) is written back to each source. Each source handles its own sync in isolation.

**Deliver** — the ranked task list is rendered to the terminal.

---

## LLM Usage Philosophy

The system uses a capable but low-performance local model. Reliability is achieved not by expecting the model to reason in complex, open-ended ways, but by **reducing every decision to a constrained numerical output**.

Every LLM call in the pipeline:
- Asks a single, well-formed question
- Expects a single float in a defined range
- Validates the output with a range check
- Retries automatically on malformed output

This means the model never needs to generate prose, explain its reasoning, or make multi-step inferences. It classifies, compares, and scores. The criteria configuration provides examples and counter-examples that calibrate its judgments.

Open-ended text generation — summarization, synthesis, explanation — is not used in the pipeline because its output cannot be reliably validated and fails non-obviously.

---

## Criteria Configuration

The criteria file is the primary tuning surface. It defines:
- **Filter categories**: what kinds of messages belong in the digest and why
- **Group criteria**: what makes two messages the same task
- **Prioritize criteria**: what makes one task more urgent than another

Each section includes natural-language descriptions, keyword signals, positive examples, and counter-examples. All of this is injected verbatim into the LLM's system prompt at runtime. The model's behavior is shaped entirely by this configuration — no prompt logic lives in code.

Ordering within the criteria matters because the LLM is influenced by position. Earlier examples carry more weight; counter-examples placed last get a recency boost and should represent the trickiest edge cases.

---

## State Persistence

State is a single local file — a flat structure containing the accumulated record of all processed messages, their task assignments, task statuses, and scoring warnings. It is the only persistent layer. All pipeline state, user-set task statuses, and priority scores live here.

The state file is read and written by a dedicated module. No other part of the system touches it directly.

---

## Authentication

Sources that require OAuth use a browser-based PKCE flow. A local HTTP callback server on localhost handles the redirect (HTTPS is not required for loopback addresses and avoids self-signed certificate complexity). Tokens are stored in a local config file outside the project directory. Auth is a one-time setup step; the pipeline reads the stored token silently on each run.
