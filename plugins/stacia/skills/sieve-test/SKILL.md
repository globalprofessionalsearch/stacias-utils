---
name: sieve-test
description: This skill should be used when the user asks to "test the sieve", "run sieve tests", "test permission sieve", "sieve test matrix", "verify sieve rules", or wants to verify, evaluate, or update the permission-sieve test suite and scripts.
---

# Permission Sieve Test Runner

Verify, evaluate, and maintain the permission-sieve rule set and its test
suite.

## Capabilities

This skill supports three modes:

1. **Run** — execute the automated test suite against the deployed sieve
2. **Evaluate** — analyze test results, identify gaps, and recommend new
   test cases or script changes
3. **Interactive** — walk through tests one at a time in a live Claude Code
   session (for integration testing beyond what the automated suite covers)

## Source of Truth

| What | Where |
|------|-------|
| Automated test suite | `permission-sieve/tests/test_sieve_rules.py` |
| Interactive test cases | `references/test-cases.md` |
| Deployed Lua scripts | `~/.cache/stacia-permission-sieve/scripts/` |
| Repo Lua scripts | `permission-sieve/examples/pi-migration/` |
| Decision log | `~/.cache/stacia-permission-sieve/decisions.jsonl` |
| Dispatcher binary | `permission-sieve/target/release/dispatcher` |

All paths are relative to `plugins/stacia/` in the stacias-utils repo.

## Mode 1: Run the Automated Suite

The test suite pipes tool-call JSON directly to the dispatcher binary —
fully idempotent, no Claude Code session needed, no side effects. It
tests the DEPLOYED scripts at `~/.cache/stacia-permission-sieve/`.

### Prerequisites

1. The dispatcher binary is built and current:
   ```bash
   cd plugins/stacia/permission-sieve && cargo build --release
   ```
2. Scripts are deployed to `~/.cache/stacia-permission-sieve/scripts/`.
3. Python 3 is available.

### Run

```bash
cd plugins/stacia/permission-sieve
python3 -m pytest tests/test_sieve_rules.py -v
```

Or without pytest:

```bash
python3 tests/test_sieve_rules.py -v
```

### Interpreting Results

- A failing test means the deployed Lua scripts produce a different
  decision than the test expects.
- Before changing the test expectation, determine whether the Lua script
  or the test is wrong — read the relevant script and trace the logic.
- After changing a Lua script, redeploy it:
  ```bash
  cp examples/pi-migration/<script>.lua ~/.cache/stacia-permission-sieve/scripts/
  ```

## Mode 2: Evaluate and Recommend

When asked to evaluate the sieve rules or the test suite:

1. **Read** the test suite at `permission-sieve/tests/test_sieve_rules.py`
   and the deployed scripts at `~/.cache/stacia-permission-sieve/scripts/`.
2. **Run** the suite and capture results.
3. **Identify gaps** — tool types, command patterns, or path patterns not
   covered by any test. Common gaps:
   - New tools added to Claude Code not in the safe-tools list
   - Bash commands the user runs frequently but the allowlist misses
   - Sensitive paths not covered by guards
4. **Recommend** concrete changes:
   - New test cases to add to `test_sieve_rules.py`
   - New entries for Lua script allowlists or guard patterns
   - Script logic changes with rationale
5. **Update** the test suite and/or scripts after user approval.
   Always update the repo examples first, then deploy:
   ```bash
   cp examples/pi-migration/*.lua ~/.cache/stacia-permission-sieve/scripts/
   ```

### Using the Decision Log for Gap Analysis

The decision log reveals real-world tool calls the sieve has seen.
Cross-reference it against the test suite to find untested patterns:

```bash
cat ~/.cache/stacia-permission-sieve/decisions.jsonl | python3 -c "
import json, sys
from collections import Counter
tools = Counter()
for line in sys.stdin:
    r = json.loads(line)
    tools[(r['tool_name'], r['resolution'])] += 1
for (tool, res), cnt in tools.most_common():
    print(f'  {tool:30s} {res:12s} {cnt}')
"
```

Compare this against the test classes in `test_sieve_rules.py` — any
tool/resolution pair that appears in the log but has no test is a gap.

## Mode 3: Interactive Testing

For integration testing that requires a live Claude Code session (testing
hook rendering, summarizer messages, prompt behavior, session-level
permission interactions):

1. Read the test cases from `references/test-cases.md`.
2. Present one test at a time — state the command and expected behavior.
3. Place the command between `---` delimiters:
   ```
   ---
   Read the file at ~/Documents/code/sieve-test.txt
   ---
   ```
4. Wait for the user to report the result.
5. Check the decision log:
   ```bash
   tail -1 ~/.cache/stacia-permission-sieve/decisions.jsonl | \
     jq '{tool: .tool_name, resolution: .resolution, summarizer: .summarizer_output, scripts: [.scripts_run[]? | {name, outcome}]}'
   ```
6. Report pass or fail, then move to the next test.
7. After all tests, print a summary table.

Interactive tests cover behaviors the automated suite cannot:
- Whether the summarizer message renders in Claude Code's UI
- Whether "allow during session" is overridden by the sieve
- Whether denied commands produce the correct instruction to Claude

## Additional Resources

- **`references/test-cases.md`** — Interactive test cases with expected
  per-script outcomes
