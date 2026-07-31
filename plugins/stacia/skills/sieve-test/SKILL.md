---
name: sieve-test
description: This skill should be used when the user asks to "test the sieve", "run sieve tests", "test permission sieve", "sieve test matrix", "verify sieve rules", "update checksums", or wants to verify, evaluate, or update the permission-sieve test suite and rules.
---

# Permission Sieve Test Runner

Verify, evaluate, and maintain the permission-sieve rule set and its test
suite.

## Capabilities

1. **Run** — execute the automated test suite
2. **Evaluate** — analyze results, identify gaps, recommend changes
3. **Interactive** — walk through tests in a live Claude Code session

## Source of Truth

| What | Where |
|------|-------|
| Automated test suite | `permission-sieve/tests/test_sieve_rules.py` |
| Rule checksums | `permission-sieve/tests/rules.sha256` |
| Rule files | `permission-sieve/rules/*.lua` |
| Interactive test cases | `references/test-cases.md` |
| Decision log | `permission-sieve/decisions.jsonl` |
| Dispatcher binary | `permission-sieve/target/release/dispatcher` |

All paths are relative to `plugins/stacia/` in the stacias-utils repo.

## Rule Change Protocol

Rules and tests are protected by a checksum mechanism. CI enforces that
any change to a rule file is accompanied by updated tests:

1. **Change a rule** in `permission-sieve/rules/`.
2. **Tests fail** — the checksum test detects the rule changed and reports
   which files differ.
3. **Update the test suite** — add, modify, or remove test cases in
   `test_sieve_rules.py` to cover the new behavior.
4. **Regenerate checksums:**
   ```bash
   python3 tests/test_sieve_rules.py --update-checksums
   ```
5. **Commit** the rule, updated tests, and updated checksums together.

The checksum is a forcing function, not a coverage guarantee. Its purpose
is to get a human's attention when rules change — to ensure the test suite
is consciously reviewed, not to prove every branch is tested. Do not
regenerate checksums without reviewing and updating tests. Do not add
no-op test changes to satisfy the checksum — that defeats the purpose.

## Mode 1: Run the Automated Suite

The test suite pipes tool-call JSON directly to the dispatcher binary —
fully idempotent, no Claude Code session needed, no side effects.

### Prerequisites

1. The dispatcher binary is built:
   ```bash
   cd plugins/stacia/permission-sieve && cargo build --release
   ```
2. Python 3 is available.

### Run

```bash
cd plugins/stacia/permission-sieve
python3 tests/test_sieve_rules.py -v
```

### Interpreting Results

- A **checksum failure** means a rule file changed but the test suite
  was not updated. Review the changed rules, update tests, then
  regenerate checksums.
- A **test assertion failure** means the rules produce a different
  decision than the test expects. Determine whether the rule or the
  test is wrong by reading the relevant Lua script.

## Mode 2: Evaluate and Recommend

When asked to evaluate the sieve rules or the test suite:

1. **Read** the test suite and the rule files in `permission-sieve/rules/`.
2. **Run** the suite and capture results.
3. **Identify gaps** — tool types, command patterns, or path patterns not
   covered by any test. Common gaps:
   - New tools added to Claude Code not in the safe-tools list
   - Bash commands the user runs frequently but the allowlist misses
   - Sensitive paths not covered by guards
4. **Recommend** concrete changes:
   - New test cases to add to `test_sieve_rules.py`
   - New entries for Lua rule allowlists or guard patterns
   - Rule logic changes with rationale
5. **Update** the test suite and/or rules after user approval, then
   regenerate checksums.

### Using the Decision Log for Gap Analysis

The decision log reveals real-world tool calls the sieve has seen.
Cross-reference it against the test suite to find untested patterns:

```bash
cat permission-sieve/decisions.jsonl | python3 -c "
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
