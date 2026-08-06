---
name: sieve-audit
description: This skill should be used when the user asks to "audit sieve", "analyze permissions", "sieve stats", "check sieve decisions", "why is it always asking", "show permission stats", or wants to analyze the permission-sieve decision log for anomalies, auto-approve candidates, or dead scripts.
---

# Permission Sieve Audit

The permission-sieve logs every tool-call decision to a JSONL file. This
skill covers analyzing that log to find anomalies, tune scripts, and verify
the sieve is working as intended.

## Source of Truth

The log schema is defined by `DecisionRecord` and `ScriptRun` in
`permission-sieve/src/log.rs`. Read that file to confirm the current field
names before writing queries.

| What | Where |
|------|-------|
| Log record schema | `permission-sieve/src/log.rs` — `DecisionRecord`, `ScriptRun` |
| Log file | `permission-sieve/decisions.jsonl` |
| Summarizer config | `permission-sieve/sieve.yaml` |
| Rule files | `permission-sieve/rules/*.lua` (auto-discovered) |

## Workflow

1. Read `references/audit-queries.md` for ready-to-run analysis commands.
2. Run the relevant query against the decision log.
3. Interpret results and recommend script changes if warranted.
4. Use `/stacia:sieve-scripts` to implement any recommended changes.

## Analysis Areas

### Resolution Distribution

Overall counts of allowed, uncertain, denied, and error resolutions. A
healthy sieve has most calls auto-approved, with uncertain reserved for
genuinely unknown operations.

### Uncertain Poisoning

Scripts returning "uncertain" for tools outside their scope — the most
common misconfiguration. Detected by finding scripts that return "uncertain"
for tool types they don't handle (e.g., a Bash-only script returning
"uncertain" for Read calls). These should return "skip" instead.

### Auto-Approve Candidates

Tools that consistently resolve as uncertain but follow recognizable
patterns. High-volume uncertain resolutions for safe operations indicate
missing allow-script entries.

### Dead Scripts

Scripts in `permission-sieve/rules/` that never return "approved" or "denied"
— only "skip". These may be misconfigured, obsolete, or redundant.

### Error Rates

Scripts returning errors, or summarizer failures. Errors indicate script
bugs or contract violations (e.g., returning the deprecated "pass" value).

## Recommending Rule Changes

When the audit reveals frequently-prompted commands, do not assume they
all need allow rules. The sieve's design principle: complexity is the
signal. An unfamiliar command that prompts the user is working as
intended — the inability to cleanly express a rule is itself evidence
the command needs human review.

The dispatcher splits compound Bash commands into segments and evaluates
each through the full sieve pipeline independently. Rules always see
single-segment commands — do not implement segment splitting in rules.
When a compound command prompts, inspect the decision log's `segments`
field to identify which specific segment triggered uncertainty.

Only recommend new allow entries for commands that are structurally
simple, clearly safe, and frequently repeated. See
`docs/adr/0010-dispatcher-splits-compound-commands.md`.

## Additional Resources

### Reference File

- **`references/audit-queries.md`** — Ready-to-run Python and jq commands
  for each analysis area
