# Sieve Script Patterns and Configuration

## Config and Rule Discovery

The hook invokes the dispatcher with `${CLAUDE_PLUGIN_ROOT}/permission-sieve`
as the config directory. All `.lua` files in the `rules/` subdirectory are
auto-discovered by `discover_rules()` in `config.rs` — no registration
needed. Rules are sorted by filename for deterministic ordering, but the
resolution algebra is commutative so order does not affect correctness.

The config file `sieve.yaml` in the config directory controls the
summarizer (model, prompt, timeout). Read `config.rs` for the canonical
schema:

```yaml
summarizer:
  model: claude-haiku-4-5-20251001
  prompt: "Describe what this tool call is attempting..."
  max_tokens: 150
  timeout_seconds: 15
```

The fallback config directory is `~/.cache/stacia-permission-sieve/`, used
only when no CLI argument is provided. In normal operation the hook always
passes the plugin root, so rules and config live in the repo.

## Script Design Patterns

### Pattern: Command Allowlist with Carve-outs

When a broad category is safe but specific commands within it need scrutiny,
check the carve-outs first, then the broad match:

```lua
if request.tool_name ~= "Bash" then return "skip" end

local function needs_ask(cmd)
  if cmd:match("^rm%s+%-rf") then return true end
  if cmd:match("^git%s+push") then return true end
  return false
end

local function is_safe(cmd)
  local safe = { "git", "ls", "cat", "grep" }
  for _, c in ipairs(safe) do
    if cmd == c or cmd:sub(1, #c + 1) == c .. " " then
      return true
    end
  end
  return false
end

if needs_ask(cmd) then return "uncertain" end
if is_safe(cmd) then return "approved" end
return "uncertain"
```

The carve-out check runs first, so `git push` returns "uncertain" (ask) even
though `git` would match the broader allow. This replicates specificity
ordering from glob-based permission systems.

Note: `"pass"` is no longer a valid outcome — it is treated as an unrecognized
value and produces `Outcome::Error`. Use `"skip"` (not my scope) or
`"uncertain"` (checked, needs scrutiny) instead.

### Pattern: Path Guarding

Use `request.paths` for resolved absolute paths. The dispatcher extracts
paths from command arguments and redirect targets (`>`, `>>`, `2>`, etc.),
so `request.paths` covers both. Substring scanning on the raw command
string is optional defense-in-depth for edge cases the path extractor
might miss (e.g. unusual variable interpolation):

```lua
for _, path in ipairs(request.paths) do
  if path:find("/.ssh/", 1, true) then return "uncertain" end
end

return "approved"
```

### Pattern: Extension Matching

```lua
local function has_extension(path, ext)
  return path:match("%." .. ext .. "$") ~= nil
end
```

Note: in Lua patterns, `.` matches any character — escape with `%` for a
literal dot.

### Pattern: Deny with Instruction

The third return value from "denied" is an instruction — it tells Claude what
to do instead. Use it to redirect rather than just block:

```lua
return "denied", "terraform is not available", "Use tofu instead of terraform"
```

The instruction appears in `permissionDecisionReason` in the hook response,
which Claude reads and acts on.

## Testing Scripts

### Manual Testing

Trigger a tool call that the script should intercept, then inspect the audit
log:

```bash
tail -1 permission-sieve/decisions.jsonl | jq .
```

The log records `resolution`, `scripts_run` (with per-script outcomes), and
`summarizer_output` for each decision.

### Verifying Script Load

Set `debugLog: true` in the config (if supported) or watch stderr:

```bash
# Temporarily test with a known input
echo '{"tool_name":"Bash","tool_input":{"command":"ls /tmp"}}' | \
  plugins/stacia/permission-sieve/target/release/dispatcher
```

### Unit Testing Lua Logic

For complex matching logic, isolate it by running the Lua snippet directly
(requires a local `lua` binary):

```bash
lua -e '
  local cmd = "git push --force origin main"
  print(cmd:match("git%s+push%s+%-%-force"))
'
```

## Script Lifecycle

1. **Create** — write the `.lua` file in `permission-sieve/rules/` in the
   stacias-utils repo
2. **Activate** — it takes effect on the next tool call (auto-discovered,
   no registration needed, no restart required)
3. **Disable** — remove or rename the file (e.g., `.lua.disabled`)
4. **Remove** — delete the file from `rules/`

## Evolving the Binary API

When the `request.*` table or return-value contract changes in the Rust
source, scripts may need updating. The authoritative definitions:

- `set_request()` in `sieve.rs` — what fields exist on `request`
- `extract_paths()` in `paths.rs` — how `request.paths` is populated
- `parse_return()` in `sieve.rs` — what return values are valid
- `resolve()` in `sieve.rs` — how outcomes aggregate

Read these functions before assuming the API surface. The examples in
`permission-sieve/examples/` are maintained alongside the binary and reflect
the current contract.
