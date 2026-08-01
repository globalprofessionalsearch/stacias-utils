# Permission Sieve

A PreToolUse hook that runs Lua scripts against every Claude Code tool call
to make allow/deny/ask decisions.

## Known Behaviors

### Hook responses override session-level permissions

The sieve is stateless — it evaluates every tool call from scratch with no
memory of prior decisions. This means Claude Code's "allow during this
session" option has no persistent effect when the sieve is active: the
sieve intercepts the next call before the session allowlist is consulted,
and will prompt again if any script returns "uncertain".

In practice, "allow X during this session" behaves the same as a one-time
"yes" for any tool call the sieve's guard scripts flag.

This also applies under `--dangerously-skip-permissions`: the flag bypasses
Claude Code's built-in permission checks, but hook responses (allow, deny,
ask) are still enforced. The sieve acts as an independent permission layer.

## Build

```
cargo build --release
```

The compiled binary is at `target/release/dispatcher`. Rebuild after any
Rust source change — Lua script changes take effect immediately (loaded
from disk on every invocation).

## Test

```
cargo test
```
