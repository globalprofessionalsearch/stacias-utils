#!/usr/bin/env python3
"""Run-directory manager for a stacia-code-review run.

This is a private helper for the stacia-code-review skill (NOT a PATH utility).
It owns every path, name, and mkdir for a review run, *captures* each repo's diff
itself, and performs every write -- so the orchestrating model never handles diff
bytes or a filesystem path for output. The model supplies only parameters; the
helper runs `gh`/`git`, parses the diff, annotates each changed file with size and
an advisory confidence ceiling, assembles the bundle, and writes it.

Layout (base = ${XDG_CACHE_HOME:-$HOME/.cache}/stacia-code-review):

    runs/<UTC-timestamp>-<shortid>/
        manifest.json            # the run's path map (written by init)
        bundles/<slug>.md        # one diff bundle per repo
        context/<kind>/<id>.<ext># reference material, read by subagents on demand
        findings/<slug>.json     # raw per-perspective reviewer results per repo
        report.md                # final assembled report
        report.html              # HTML wrapper (renders report.md client-side)

Subcommands
-----------
    init <repo> [<repo> ...] [--label L]
        Allocate the run tree, write manifest.json, print the manifest JSON.
    build-bundle --run <dir> --slug <slug> --repo-path <path> --source <spec>
        Capture the repo's diff, assemble the annotated bundle, write it.
        <spec> is one of:
            pr:<id>                 a GitHub PR (via gh)
            range:<base>...<head>   a committed ref range
            worktree[:all|:staged]  uncommitted changes (all = staged+unstaged)
    add-context --run <dir> --kind <k> --id <id> --title <t> [--ext <ext>]
        Stage reference material (body on stdin) into the run's context store
        and record it in the manifest catalog. Subagents read it by path on
        demand -- large context never travels through workflow args by value.
    write-bundle    --run <dir> --slug <slug>     (raw bundle on stdin; fallback)
    write-findings  --run <dir> --slug <slug>     (JSON on stdin; validated)
    write-report    --run <dir>                   (content on stdin)

Every write/build command resolves its destination from the run's manifest.json,
validates the result (real diff hunks, non-empty), and prints the absolute path it
wrote. Content is never placed by a path supplied from outside.
"""

import argparse
import json
import os
import re
import secrets
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

# --- size -> advisory confidence ceiling policy (the larger the file, the less of
# it any reviewer can hold in view, so the ceiling on a finding about it drops). ---
SIZE_HIGH_MAX = 800     # post-change LOC at/under which High confidence is allowed
SIZE_MED_MAX = 2000     # at/under which Medium is the ceiling; above this -> Low
INLINE_MAX_DIFF_LINES = 1000  # per-file diff hunks larger than this are not inlined


def safe_filename(name: str) -> str:
    """Filesystem-safe token for a context id/kind (no slashes, no surprises)."""
    token = re.sub(r"[^a-zA-Z0-9._-]+", "-", str(name)).strip("-_.")
    return token or "item"


def slugify(name: str) -> str:
    base = name.rstrip("/").split("/")[-1] or name
    slug = re.sub(r"[^a-zA-Z0-9]+", "-", base).strip("-").lower()
    return slug or "repo"


def unique_slugs(repos):
    seen, result = {}, []
    for repo in repos:
        slug = slugify(repo)
        if slug in seen:
            seen[slug] += 1
            slug = f"{slug}-{seen[slug]}"
        else:
            seen[slug] = 1
        result.append((repo, slug))
    return result


def base_dir() -> Path:
    xdg = os.environ.get("XDG_CACHE_HOME")
    root = Path(xdg) if xdg else Path.home() / ".cache"
    return root / "stacia-code-review"


def die(msg: str) -> int:
    sys.stderr.write(f"code-review-workdir: {msg}\n")
    return 2


def load_manifest(run: str):
    run_dir = Path(run)
    manifest_path = run_dir / "manifest.json"
    if not manifest_path.is_file():
        raise SystemExit(die(f"no manifest.json under run dir {run_dir!s}"))
    with manifest_path.open() as fh:
        return run_dir, json.load(fh)


def read_stdin() -> str:
    data = sys.stdin.read()
    if not data.strip():
        raise SystemExit(die("refusing to write empty content from stdin"))
    return data


def run_capture(cmd, cwd):
    """Run a command, returning stdout text; raise SystemExit(die) on failure."""
    try:
        proc = subprocess.run(cmd, cwd=cwd, text=True, capture_output=True)
    except FileNotFoundError:
        raise SystemExit(die(f"command not found: {cmd[0]!r}"))
    if proc.returncode != 0:
        raise SystemExit(die(f"`{' '.join(cmd)}` failed: {proc.stderr.strip()}"))
    return proc.stdout


def git_show_loc(repo_path, ref, path):
    """Line count of <ref>:<path>, or None if the object can't be resolved."""
    try:
        proc = subprocess.run(["git", "show", f"{ref}:{path}"], cwd=repo_path,
                              text=True, capture_output=True)
    except FileNotFoundError:
        return None
    if proc.returncode != 0:
        return None
    return proc.stdout.count("\n") + (0 if proc.stdout.endswith("\n") or not proc.stdout else 1)


# --------------------------- diff parsing ---------------------------

def parse_diff(diff_text):
    """Parse a unified diff into per-file records (path, status, churn, binary, body)."""
    files = []
    cur = None
    for line in diff_text.split("\n"):
        if line.startswith("diff --git "):
            if cur is not None:
                files.append(cur)
            cur = {"old": None, "new": None, "status": "modified",
                   "adds": 0, "dels": 0, "binary": False, "body": [line]}
            continue
        if cur is None:
            continue
        cur["body"].append(line)
        if line.startswith("new file mode"):
            cur["status"] = "added"
        elif line.startswith("deleted file mode"):
            cur["status"] = "deleted"
        elif line.startswith("rename from") or line.startswith("rename to"):
            cur["status"] = "renamed"
        elif line.startswith("Binary files"):
            cur["binary"] = True
        elif line.startswith("--- "):
            p = line[4:].strip()
            cur["old"] = None if p == "/dev/null" else re.sub(r"^a/", "", p)
        elif line.startswith("+++ "):
            p = line[4:].strip()
            cur["new"] = None if p == "/dev/null" else re.sub(r"^b/", "", p)
        elif line.startswith("+") and not line.startswith("+++"):
            cur["adds"] += 1
        elif line.startswith("-") and not line.startswith("---"):
            cur["dels"] += 1
    if cur is not None:
        files.append(cur)
    for f in files:
        f["path"] = f["new"] or f["old"] or "?"
        f["diff_lines"] = len(f["body"])
    return files


# --------------------------- source resolution ---------------------------

def resolve_source(spec, repo_path):
    """Return (diff_text, base_ref, metadata_md) for the source spec."""
    if spec.startswith("pr:"):
        pr = spec[3:]
        diff_text = run_capture(["gh", "pr", "diff", pr], cwd=repo_path)
        info = run_capture(
            ["gh", "pr", "view", pr, "--json",
             "number,title,body,url,baseRefName,headRefName,labels"], cwd=repo_path)
        meta = json.loads(info)
        labels = ", ".join(l.get("name", "") for l in meta.get("labels", [])) or "(none)"
        md = (f"**PR #{meta.get('number')}** — {meta.get('title','').strip()}\n\n"
              f"- URL: {meta.get('url','')}\n"
              f"- Base: `{meta.get('baseRefName','')}`  Head: `{meta.get('headRefName','')}`\n"
              f"- Labels: {labels}\n\n"
              f"Description:\n\n{(meta.get('body') or '(none)').strip()}\n")
        base_ref = meta.get("baseRefName") or "HEAD"
        # prefer the locally-tracked base if present
        if subprocess.run(["git", "rev-parse", "--verify", f"origin/{base_ref}"],
                          cwd=repo_path, capture_output=True).returncode == 0:
            base_ref = f"origin/{base_ref}"
        return diff_text, base_ref, md
    if spec.startswith("range:"):
        rng = spec[6:]
        if "..." not in rng:
            raise SystemExit(die(f"range source must be base...head, got {rng!r}"))
        base_ref = rng.split("...", 1)[0]
        diff_text = run_capture(["git", "diff", rng], cwd=repo_path)
        return diff_text, base_ref, f"**Range:** `{rng}`\n"
    if spec == "worktree" or spec == "worktree:all":
        diff_text = run_capture(["git", "diff", "HEAD"], cwd=repo_path)
        return diff_text, "HEAD", "**Uncommitted working tree** (staged + unstaged)\n"
    if spec == "worktree:staged":
        diff_text = run_capture(["git", "diff", "--staged"], cwd=repo_path)
        return diff_text, "HEAD", "**Uncommitted working tree** (staged only)\n"
    raise SystemExit(die(f"unknown source spec {spec!r}"))


def confidence_ceiling(total_loc, inlined):
    if not inlined:
        return "Low"
    if total_loc is None:
        return "Low"
    if total_loc <= SIZE_HIGH_MAX:
        return "High"
    if total_loc <= SIZE_MED_MAX:
        return "Medium"
    return "Low"


def assemble_bundle(slug, repo_path, source_spec, meta_md, files, base_ref):
    repo_abs = str(Path(repo_path).resolve())
    rows, sections = [], []
    tot_add = tot_del = 0
    for f in files:
        tot_add += f["adds"]
        tot_del += f["dels"]
        if f["binary"]:
            total_loc = None
        elif f["status"] == "deleted":
            total_loc = 0
        else:
            base_loc = 0 if f["status"] == "added" else git_show_loc(repo_path, base_ref, f["path"])
            total_loc = None if base_loc is None else max(0, base_loc + f["adds"] - f["dels"])
        inlined = (not f["binary"]) and f["diff_lines"] <= INLINE_MAX_DIFF_LINES
        ceil = confidence_ceiling(total_loc, inlined)
        loc_disp = "binary" if f["binary"] else ("unknown" if total_loc is None else str(total_loc))
        rows.append(f"| `{f['path']}` | {f['status']} | +{f['adds']} | -{f['dels']} | "
                    f"{loc_disp} | {'yes' if inlined else 'NO'} | **{ceil}** |")
        if inlined:
            sections.append(f"### `{f['path']}`  _(size {loc_disp} LOC · confidence ceiling {ceil})_\n\n"
                            "```diff\n" + "\n".join(f["body"]).strip("\n") + "\n```\n")
        else:
            reason = "binary" if f["binary"] else f"diff too large ({f['diff_lines']} lines)"
            sections.append(f"### `{f['path']}`  _(size {loc_disp} LOC · confidence ceiling {ceil})_\n\n"
                            f"> Diff omitted ({reason}). Open `{repo_abs}/{f['path']}` to review. "
                            f"Confidence is floored at **Low** for findings here.\n")

    legend = (
        "**Confidence ceiling (advisory).** Each file is annotated with a ceiling "
        "derived from its post-change size and whether its diff is inlined. The "
        "larger the file, the less of it you can see, so your confidence in any "
        "finding about it must not exceed the ceiling:\n"
        f"- ≤ {SIZE_HIGH_MAX} LOC and inlined → **High** allowed\n"
        f"- {SIZE_HIGH_MAX + 1}–{SIZE_MED_MAX} LOC → ceiling **Medium**\n"
        f"- > {SIZE_MED_MAX} LOC, or diff not inlined, or size unknown → ceiling **Low**\n"
        "This is advisory: calibrate down, never up. You may open any file at the "
        "repo path for more context, but a large file inherently limits certainty.\n")

    return (
        f"# Code-review bundle — `{slug}`\n\n"
        f"- Repo path: `{repo_abs}`\n"
        f"- Source: `{source_spec}`\n"
        f"- Totals: {len(files)} files, +{tot_add} / -{tot_del}\n\n"
        f"## Metadata\n\n{meta_md}\n"
        f"## Changed files\n\n"
        "| File | Status | Adds | Dels | Post LOC | Inlined | Conf. ceiling |\n"
        "|------|--------|------|------|----------|---------|---------------|\n"
        + "\n".join(rows) + "\n\n"
        + legend + "\n"
        "## Diffs\n\n" + "\n".join(sections) + "\n"
    )


# --------------------------- commands ---------------------------

def cmd_init(args) -> int:
    ts = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    run_name = f"{ts}-{secrets.token_hex(3)}"
    if args.label:
        run_name += "-" + slugify(args.label)
    run_dir = base_dir() / "runs" / run_name
    bundles_dir, findings_dir = run_dir / "bundles", run_dir / "findings"
    context_dir = run_dir / "context"
    bundles_dir.mkdir(parents=True, exist_ok=True)
    findings_dir.mkdir(parents=True, exist_ok=True)
    context_dir.mkdir(parents=True, exist_ok=True)

    repos = unique_slugs(args.repos)
    multi = len(repos) > 1
    # Copy HTML template to run directory
    template_src = Path(__file__).parent / "report-template.html"
    report_html = run_dir / "report.html"
    if template_src.exists():
        report_html.write_text(template_src.read_text())

    manifest = {
        "run_dir": str(run_dir),
        "report": str(run_dir / "report.md"),
        "report_html": str(report_html),
        "multi_repo": multi,
        "context": [],
        "repos": [
            {"repo": repo, "slug": slug,
             "bundle": str(bundles_dir / f"{slug}.md"),
             "findings": str(findings_dir / f"{slug}.json")}
            for repo, slug in repos
        ],
    }
    (run_dir / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    json.dump(manifest, sys.stdout, indent=2)
    sys.stdout.write("\n")
    return 0


def _repo_entry(manifest, slug):
    for entry in manifest["repos"]:
        if entry["slug"] == slug:
            return entry
    known = ", ".join(e["slug"] for e in manifest["repos"])
    raise SystemExit(die(f"unknown slug {slug!r}; known slugs: {known}"))


def cmd_build_bundle(args) -> int:
    _, manifest = load_manifest(args.run)
    entry = _repo_entry(manifest, args.slug)
    repo_path = args.repo_path
    if subprocess.run(["git", "rev-parse", "--git-dir"], cwd=repo_path,
                      capture_output=True).returncode != 0:
        return die(f"{repo_path!r} is not a git work tree")
    diff_text, base_ref, meta_md = resolve_source(args.source, repo_path)
    files = parse_diff(diff_text)
    if not files:
        return die(f"captured diff for {args.slug!r} is empty — nothing to review "
                   f"(check the source spec {args.source!r})")
    if "diff --git" not in diff_text or not re.search(r"^@@ ", diff_text, re.M):
        return die(f"captured diff for {args.slug!r} has no hunks; refusing to write")
    bundle = assemble_bundle(args.slug, repo_path, args.source, meta_md, files, base_ref)
    Path(entry["bundle"]).write_text(bundle)
    print(entry["bundle"])
    return 0


def cmd_add_context(args) -> int:
    run_dir, manifest = load_manifest(args.run)
    body = read_stdin()
    kind = safe_filename(args.kind)
    cid = safe_filename(args.id)
    ext = safe_filename(args.ext).lstrip(".") or "md"
    dest_dir = run_dir / "context" / kind
    dest_dir.mkdir(parents=True, exist_ok=True)
    dest = dest_dir / f"{cid}.{ext}"
    dest.write_text(body)
    entry = {"id": args.id, "kind": args.kind, "title": args.title, "path": str(dest)}
    catalog = manifest.setdefault("context", [])
    # replace any prior entry with the same (kind, id); otherwise append
    catalog[:] = [c for c in catalog
                  if not (c.get("kind") == args.kind and c.get("id") == args.id)]
    catalog.append(entry)
    (run_dir / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print(str(dest))
    return 0


def cmd_write_bundle(args) -> int:
    _, manifest = load_manifest(args.run)
    target = Path(_repo_entry(manifest, args.slug)["bundle"])
    payload = read_stdin()
    if "diff --git" not in payload and "@@" not in payload:
        return die("bundle has no diff hunks (no `diff --git`/`@@`); did a command "
                   "substitution fail to expand? Prefer `build-bundle`.")
    if re.search(r"\$\([^)]*\b(gh|git)\b", payload):
        return die("bundle contains an unexpanded `$(... gh/git ...)` command; the "
                   "diff was not captured. Use `build-bundle` instead.")
    target.write_text(payload)
    print(str(target))
    return 0


def _write_json(target: Path, label: str) -> int:
    payload = read_stdin()
    try:
        json.loads(payload)
    except json.JSONDecodeError as exc:
        return die(f"{label} is not valid JSON: {exc}")
    target.write_text(payload)
    print(str(target))
    return 0


def cmd_write_findings(args) -> int:
    run_dir, manifest = load_manifest(args.run)
    # A repo slug writes to that repo's findings path; any other slug (e.g.
    # 'synthesis') writes findings/<slug>.json under the run dir.
    entry = next((e for e in manifest["repos"] if e["slug"] == args.slug), None)
    if entry is not None:
        target = Path(entry["findings"])
    else:
        target = run_dir / "findings" / f"{safe_filename(args.slug)}.json"
        target.parent.mkdir(parents=True, exist_ok=True)
    return _write_json(target, f"findings for {args.slug!r}")


def cmd_write_report(args) -> int:
    _, manifest = load_manifest(args.run)
    Path(manifest["report"]).write_text(read_stdin())
    print(manifest["report"])
    if manifest.get("report_html"):
        print(manifest["report_html"])
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="code-review-workdir",
        description="Allocate, capture into, and write a stacia-code-review run directory.")
    sub = parser.add_subparsers(dest="command", required=True)

    p = sub.add_parser("init", help="Allocate a run directory and print its manifest.")
    p.add_argument("repos", nargs="+", metavar="REPO")
    p.add_argument("--label", default=None)
    p.set_defaults(func=cmd_init)

    p = sub.add_parser("build-bundle", help="Capture a repo's diff and write its bundle.")
    p.add_argument("--run", required=True)
    p.add_argument("--slug", required=True)
    p.add_argument("--repo-path", required=True, dest="repo_path")
    p.add_argument("--source", required=True,
                   help="pr:<id> | range:<base>...<head> | worktree[:all|:staged]")
    p.set_defaults(func=cmd_build_bundle)

    p = sub.add_parser("add-context",
                       help="Stage reference material (stdin) into the context store.")
    p.add_argument("--run", required=True)
    p.add_argument("--kind", required=True, help="category, e.g. adr, spec, doc")
    p.add_argument("--id", required=True, help="stable id, used as the filename")
    p.add_argument("--title", required=True, help="human-readable title")
    p.add_argument("--ext", default="md", help="file extension (default: md)")
    p.set_defaults(func=cmd_add_context)

    p = sub.add_parser("write-bundle", help="Write a pre-built bundle from stdin (fallback).")
    p.add_argument("--run", required=True)
    p.add_argument("--slug", required=True)
    p.set_defaults(func=cmd_write_bundle)

    p = sub.add_parser("write-findings", help="Write a repo's raw findings JSON (stdin).")
    p.add_argument("--run", required=True)
    p.add_argument("--slug", required=True)
    p.set_defaults(func=cmd_write_findings)

    p = sub.add_parser("write-report", help="Write the final report (stdin).")
    p.add_argument("--run", required=True)
    p.set_defaults(func=cmd_write_report)

    return parser


def main(argv=None) -> int:
    args = build_parser().parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
