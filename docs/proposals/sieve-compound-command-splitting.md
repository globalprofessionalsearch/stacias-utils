---
status: approved
date: 2026-08-05
author: Stacia Colasurdo
tags: [permission-sieve, architecture]
adr: "0010"
---

# Dispatcher-level compound command splitting for the permission sieve

## Motivation

ADR 0009 kept compound command parsing out of the dispatcher, but rule
complexity grew to compensate — `allow-safe-bash.lua` accumulated its
own segment splitter and redirect stripper, and each new guard rule had
to independently decide how to handle compound commands. Moving the
splitting into the dispatcher centralizes it, simplifies rules, and
evaluates each sub-command more thoroughly (full pipeline, all rules,
path extraction).

## Design

### Dispatcher flow for Bash commands

When `tool_name == "Bash"`:

1. Split `tool_input.command` into segments on `|`, `||`, `&&`, `;`,
   `&` (quote-aware).
2. For each segment, build a synthetic event:
   - `tool_name`: `"Bash"`
   - `tool_input.command`: the segment text
   - All other fields (`session_id`, `agent_type`, etc.) copied from
     the original event.
3. Run the full per-segment pipeline:
   - `paths::extract_paths()` on the synthetic event
   - All Lua rules in order (short-circuit on deny/error as today)
   - `resolve()` to get a per-segment resolution
4. Aggregate segment resolutions (see algebra below).
5. If uncertain, call the summarizer with the **original full command**.
6. Write one decision record with per-segment detail.

For non-Bash tools, the existing single-command flow is unchanged.

### Splitting logic

Promote `split_on_shell_operators` from `paths.rs` to a shared public
function. One implementation used by both:

- The dispatcher (segment evaluation)
- `extract_bash_paths` (path extraction per segment)

The function already handles `|`, `||`, `&&`, `;`, `&` with quote
awareness. No changes to its logic are needed.

### Cross-segment resolution algebra

```
if any segment is denied   → compound is denied (first denial wins)
if all segments are approved → compound is approved
otherwise                   → compound is uncertain
```

Same algebra as `resolve()` across rules within a single command. Errors
are treated as denied (same as today's behavior).

### Redirect target path extraction

Add redirect-target extraction to `paths.rs`. Parse redirect operators
in the command string and extract target paths:

- `>`, `>>` — output redirects
- `2>`, `2>>` — stderr redirects
- `&>`, `&>>` — combined redirects
- `<` — input redirects (less critical but consistent)

Target paths are added to the `request.paths` array alongside paths
extracted from command arguments. This makes them visible to
`guard-sensitive-paths` and `guard-external-dirs`.

Redirections stay in the segment's command string — they are not
stripped. Rules see the full segment including redirect syntax.

### Decision logging

Add a `segments` field to `DecisionRecord`:

```rust
pub struct SegmentRecord {
    pub command: String,
    pub scripts_run: Vec<ScriptRun>,
    pub resolution: String,
}
```

For single-segment commands (no splitting needed), `segments` is omitted
or contains one entry. The top-level `resolution` and `scripts_run`
fields reflect the aggregate.

### Rule changes

**`allow-safe-bash.lua`** — major simplification:
- Remove `split_segments()` function (~45 lines)
- Remove `strip_redirects()` function (~6 lines)
- The rule now sees single commands; prefix matching
  (`starts_with(cmd, "git ")`) works directly.
- The `is_safe()` function and safe-command lists are unchanged.

**`guard-bash-carveouts.lua`** — no changes. Pattern matching
(`cmd:find("rm -rf")`) works on individual segments.

**`deny-dangerous.lua`** — no changes. Force-push detection, terraform
blocking, etc. work on individual segments.

**`guard-sensitive-paths.lua`** — no changes. The belt-and-suspenders
scan operates per segment. Path-based guards benefit from redirect
target extraction.

**`guard-external-dirs.lua`**, **`allow-safe-mutations.lua`** — no
changes (these skip Bash tools).

### Test changes

**Integration tests (`test_sieve_rules.py`):**
- Compound command tests (`TestBashCompound`) now test dispatcher-level
  splitting rather than rule-level splitting. Expected outcomes are
  unchanged.
- Redirect tests continue to work — redirect targets appear in paths.
- Add tests for compound commands where one segment is denied (e.g.,
  `ls && terraform plan` → denied).
- Update rule checksums after `allow-safe-bash.lua` simplification.

**Rust unit tests:**
- Add tests for cross-segment resolution algebra.
- Add tests for redirect target extraction in `paths.rs`.

### Performance

Each segment of a compound command runs through the full pipeline. For
a 3-segment command with 10 rules, that's ~30 Lua evaluations instead
of 10. Given the sieve's sub-millisecond per-rule budget and the
startup SLA test (< 1ms per iteration), this is well within tolerance.
Most commands are single-segment; the cost only applies to compounds.
