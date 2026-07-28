# code-review

Orchestrated, read-only, multi-perspective code review of a change set —
optionally spanning multiple repos. A utility of the `stacia` Claude Code
plugin, whose real work happens in a standalone Claude Agent SDK program
(`coordinator/`), launched into its own terminal pane so its live monitor gets a
real TTY.

Ported off the pi harness; see `docs/adr/` for the design of record.

This utility is self-contained — everything it needs is in this directory, and
deleting the directory removes it outright:

```
plugins/stacia/skills/code-review/
  SKILL.md              the entry point: resolves scope + charge
  bin/launch-review     hands the resolved request to a new iTerm2 pane
  bin/await-review      blocks until the review ends; the completion signal
  coordinator/          the Agent SDK program that runs the review
  test.sh               one test entrypoint (pre-commit hook + CI)
```

## Installing

Nothing to install per utility. `summon setup` registers `plugins/` as a local
marketplace named `stacia-utils` and installs the one umbrella plugin, `stacia`,
at user scope. Because this utility is a skill of that plugin rather than a
plugin of its own, it ships with it — and adding or removing a utility never
requires re-running setup.

The marketplace manifest (`plugins/.claude-plugin/marketplace.json`) is an
authored file listing each plugin. `summon lint` checks it stays accurate
against what is on disk.

Docs: <https://code.claude.com/docs/en/plugins> ·
<https://code.claude.com/docs/en/plugin-marketplaces>

## Invoking

`/stacia:code-review` (plugin-namespaced skill), or just
describe the review in plain language — the skill's description is written to
trigger on "review my PR / this branch / my working tree".

The skill establishes three things and nothing else:

- **The charge** — what the caller says the change is about. **Hard gate.**
  Never inferred from the diff, the branch name, or the commit messages; the
  review has nothing to measure against without it.
- **The repos** — where to look. Often more than one. Each carries a `source`
  spec (`pr:<id>` | `range:<base>...<head>` | `worktree` | `worktree:all` |
  `worktree:staged`) expressing which change set to capture.
- **The ADRs** — where to find them, if any apply. Optional, never blocking.

Then it invokes the launcher. It takes the caller at their word: it runs no
`git` or `gh`, verifies nothing, and never opens a file in the repos under
review.

## The division of labour

This is the thing that keeps getting lost, so it is written down here as well
as in the ADRs. Three layers, three questions:

| Layer | Question | Owns |
|---|---|---|
| **Orchestrator** (`SKILL.md`, the host session) | *Who is asking, and about what?* | Charge, repos, ADR locations. Takes the human at their word. |
| **Helper** (`coordinator/helper/code-review-workdir.py`) | *Which bytes are in scope?* | Runs `gh`/`git`, parses the diff, annotates each file with LOC and a confidence ceiling, writes the bundle. |
| **Orienteers** (`coordinator/assets/references/orienteer-*.md`) | *What is the relevant surface area, and does it serve the charge?* | Read the bundle, explore outward across the repo roots, stitch together the map — twice, independently, from opposite directions. Their disagreement becomes a seam. |

The orienteers own "what changed and what it means", and the code enforces it:
their personas grant `Read`/`Grep`/`Glob` and no Bash, so they cannot run
`git diff`; `orientation.schema.json` has no field in which to report a
changed-file list; and their whole change-set payload is one line per repo
naming a bundle path. Because their reads are confined to the repo roots plus
the run dir, the bundle is a starting point rather than a boundary — which is
precisely how they establish surface area for themselves.

An orchestrator that inspected the change first would break that: it would
anchor the charge on what it had just described, and inject a third orientation
that reaches the conversation but never the seam map.

## The launcher

`bin/launch-review` is what bridges Claude Code and the coordinator. It splits
an iTerm2 pane (`osascript` + `split horizontally with default profile`, the
same pattern as `utilities/repos/main`) and starts the coordinator there, so
stdin is a real TTY and the live monitor is interactive.

```
launch-review --charge <text> --repo <abs-path> [--source <spec>] …
              [--adr <id>:<title>:<abs-path>] [--here] [--dry-run]
```

Run `launch-review --help` for the full contract.

### Argument transport

The charge is free-form user text and repo paths may contain spaces, quotes and
shell metacharacters. None of it is interpolated into AppleScript. Instead:

1. The launcher validates every argument (repo is a directory *and* a git repo;
   `--source` matches the spec grammar; charge is non-blank) and writes the
   whole request as JSON to a mode-600 file under
   `$TMPDIR/stacia-code-review/req.XXXXXXXX/request.json`.
2. Only three values cross into AppleScript — the coordinator directory, the
   `node` binary, and that request path — all generated by the launcher itself.
   They are passed as `osascript` **argv** against a single-quoted heredoc (so
   bash expands nothing) and re-quoted with AppleScript's `quoted form of`
   before landing on the pane's command line.
3. The npm-install step is selected by a `"1"`/`"0"` flag against an AppleScript
   string literal, so not even that is assembled from outside data.

The command the pane runs is therefore fixed in shape:

```
cd '<coordinator>' && clear && [npm ci --no-audit --no-fund && ] '<node>' ./cli.ts --request '<request.json>'
```

JSON encoding escapes backslash and quote first, so no input can terminate the
string literal it lands in; remaining C0 control bytes are mapped to their JSON
escapes or dropped. Request dirs older than a day are reaped on the next run.

### Fallback

Off macOS, without `osascript`, without iTerm2 installed, if the split fails, or
with `--here`, the launcher prints why and runs the coordinator in the current
terminal instead of failing. In that mode stdin is usually not a TTY, and the
coordinator degrades to line-oriented progress output.

## Knowing when it finished

The launcher is fire-and-forget: it splits a pane and exits, so the calling
session would otherwise never hear from the review again. `bin/await-review`
closes that loop.

The coordinator writes `<run-dir>/status.json` exactly once, on **both** the
success and failure paths — `report.md` alone is not a completion signal
because a failed run never produces one. The write is atomic (temp +
`os.replace`) precisely because the waiter polls for the file's existence: a
half-written file would be read as "done".

```json
{ "version": 1, "state": "complete", "runDir": "…", "charge": "…",
  "startedAt": "…", "endedAt": "…",
  "verdict": "partial", "counts": { "Blocker": 1, "Major": 3, "Minor": 2, "Nit": 0 },
  "report": "…/report.md" }
```

`state` is `complete` or `failed`; a failed status carries `error` instead of
the verdict block.

The calling session runs `await-review <run-dir>` **in the background**. It
blocks until `status.json` appears, prints the outcome, and exits — and that
exit is what wakes the session. Exit codes: `0` complete, `1` failed, `3`
timed out or unreadable. The timeout (`STACIA_AWAIT_TIMEOUT`, default two
hours) exists for the one case the signal cannot cover: a coordinator killed
hard enough that it never writes a status at all.

## Contract with the coordinator

`bin/launch-review` invokes exactly:

```
node <plugin>/coordinator/cli.ts --request <abs path to request.json>
```

with cwd set to `<plugin>/coordinator`. The request file:

```json
{
  "version": 1,
  "charge": "what the change claims to accomplish",
  "cwd": "/dir the launcher was invoked from",
  "run_dir": "/…/runs/20260727T215846Z-177e95",
  "repos": [{ "path": "/abs/repo", "source": "range:main...HEAD" }],
  "adrs": [{ "id": "0003", "title": "…", "path": "/abs/docs/adr/0003-….md" }]
}
```

`run_dir` is allocated by the **launcher**, not the coordinator, and printed on
stdout before the pane is split. The pane is fire-and-forget — once it exists
the calling session never hears from the review again — so the one path worth
knowing has to be known before then. The helper still owns allocation and
mkdir (ADR-0003); `launch-review` is simply an earlier caller of `init` than
the coordinator used to be, and every other subcommand already takes
`--run <dir>`.

`repos` always has at least one entry with an absolute, existing path and a
grammar-valid `source`. `adrs` may be empty. `charge` is non-blank.

## Testing

```bash
./plugins/stacia/skills/code-review/test.sh
```

vitest plus the Python helper tests. Gated identically by the git pre-commit
hook and by CI, and only when this tree is touched.
