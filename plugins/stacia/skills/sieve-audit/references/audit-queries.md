# Sieve Audit Queries

Ready-to-run commands for analyzing the permission-sieve decision log.
The log path is `~/.cache/stacia-permission-sieve/decisions.jsonl`.

Confirm field names against `DecisionRecord` and `ScriptRun` in
`permission-sieve/src/log.rs` before adapting these queries.

## Resolution Distribution

```bash
jq -r '.resolution' ~/.cache/stacia-permission-sieve/decisions.jsonl \
  | sort | uniq -c | sort -rn
```

## Per-Script Outcome Breakdown

```bash
cat ~/.cache/stacia-permission-sieve/decisions.jsonl | python3 -c "
import json, sys
from collections import Counter, defaultdict
per_script = defaultdict(Counter)
for line in sys.stdin:
    r = json.loads(line)
    for s in r.get('scripts_run', []):
        per_script[s['name']][s['outcome']] += 1
for script, counts in sorted(per_script.items()):
    print(f'{script}: {dict(counts)}')
"
```

## Uncertain Poisoning Detector

Finds scripts returning uncertain/pass for tools outside their scope —
cases where another script approved but the overall resolution was forced
to uncertain.

```bash
cat ~/.cache/stacia-permission-sieve/decisions.jsonl | python3 -c "
import json, sys
from collections import Counter, defaultdict
poisoning = defaultdict(Counter)
for line in sys.stdin:
    r = json.loads(line)
    runs = r.get('scripts_run', [])
    if r.get('resolution') == 'uncertain':
        has_approved = any(s['outcome'] == 'approved' for s in runs)
        if has_approved:
            for s in runs:
                if s['outcome'] in ('uncertain', 'pass'):
                    poisoning[s['name']][r['tool_name']] += 1
if poisoning:
    for script, tools in sorted(poisoning.items()):
        print(f'{script}:')
        for tool, cnt in tools.most_common(5):
            print(f'  {tool}: {cnt}x')
else:
    print('No uncertain poisoning detected.')
"
```

## Frequent Uncertain Tools (Auto-Approve Candidates)

```bash
cat ~/.cache/stacia-permission-sieve/decisions.jsonl | python3 -c "
import json, sys
from collections import Counter
tools = Counter()
for line in sys.stdin:
    r = json.loads(line)
    if r.get('resolution') == 'uncertain':
        tools[r.get('tool_name', 'unknown')] += 1
for tool, cnt in tools.most_common(10):
    print(f'  {tool}: {cnt}')
"
```

## Dead Scripts

Scripts that never return "approved" or "denied" — only skip or uncertain.

```bash
cat ~/.cache/stacia-permission-sieve/decisions.jsonl | python3 -c "
import json, sys
from collections import Counter, defaultdict
per_script = defaultdict(Counter)
for line in sys.stdin:
    r = json.loads(line)
    for s in r.get('scripts_run', []):
        per_script[s['name']][s['outcome']] += 1
for script, counts in sorted(per_script.items()):
    if 'approved' not in counts and 'denied' not in counts:
        print(f'DEAD: {script} -> {dict(counts)}')
"
```

## Error Rate

```bash
jq -r 'select(.resolution == "error") | [.ts, .tool_name, .error_detail] | @tsv' \
  ~/.cache/stacia-permission-sieve/decisions.jsonl | head -20
```

## Recent Decisions

```bash
tail -10 ~/.cache/stacia-permission-sieve/decisions.jsonl | \
  jq '[.ts, .tool_name, .resolution] | @tsv' -r
```

## Per-Decision Detail

Inspect the last decision with per-script outcomes:

```bash
tail -1 ~/.cache/stacia-permission-sieve/decisions.jsonl | \
  jq '{tool: .tool_name, resolution: .resolution, scripts: [.scripts_run[]? | {name, outcome}]}'
```

## Compound Command Segment Breakdown

For compound Bash commands, the dispatcher splits on `|`, `&&`, `;`, `&`
and evaluates each segment independently. The `segments` field in the
decision record shows per-segment results:

```bash
tail -1 ~/.cache/stacia-permission-sieve/decisions.jsonl | \
  jq '{tool: .tool_name, resolution: .resolution, segments: [.segments[]? | {command, resolution}]}'
```

## Per-Segment Resolution Distribution

Aggregate view of how individual segments resolve across all compound
commands:

```bash
cat ~/.cache/stacia-permission-sieve/decisions.jsonl | python3 -c "
import json, sys
from collections import Counter
seg_res = Counter()
total_compound = 0
for line in sys.stdin:
    r = json.loads(line)
    segs = r.get('segments', [])
    if len(segs) > 1:
        total_compound += 1
        for s in segs:
            seg_res[s.get('resolution', 'unknown')] += 1
print(f'Compound commands: {total_compound}')
for res, cnt in seg_res.most_common():
    print(f'  {res}: {cnt}')
"
```
