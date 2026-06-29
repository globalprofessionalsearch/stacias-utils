#!/usr/bin/env python3
"""Run-directory manager for a stacia-code-review run.

This is a private helper for the stacia-code-review skill (NOT a PATH utility).
It owns every path, name, and mkdir for a review run *and* performs every write,
so the orchestrating model never handles a filesystem path for output: it calls
`init` once to allocate the run, then pipes content to named `write-*` targets
that the script resolves. Placement is fully deterministic.

Layout (base = ${XDG_CACHE_HOME:-$HOME/.cache}/stacia-code-review):

    runs/<UTC-timestamp>-<shortid>/
        manifest.json            # the run's path map (written by init)
        bundles/<slug>.md        # one diff bundle per repo
        findings/<slug>.json     # raw per-perspective reviewer results per repo
        findings/cross-repo.json # cross-repo reviewer result (multi-repo only)
        report.md                # final assembled report

Subcommands
-----------
    init <repo> [<repo> ...] [--label L]
        Allocate the run tree, write manifest.json, print the manifest JSON.
    write-bundle    --run <dir> --slug <slug>     (content on stdin)
    write-findings  --run <dir> --slug <slug>     (JSON on stdin; validated)
    write-cross-findings --run <dir>              (JSON on stdin; validated)
    write-report    --run <dir>                   (content on stdin)

Every write-* command resolves its destination from the run's manifest.json,
validates the target is legitimate, writes stdin to it, and prints the absolute
path it wrote. Content is never placed by path supplied from outside.
"""

import argparse
import json
import os
import re
import secrets
import sys
from datetime import datetime, timezone
from pathlib import Path


def slugify(name: str) -> str:
    """Filesystem-safe slug from a repo identifier (uses the last path segment)."""
    base = name.rstrip("/").split("/")[-1] or name
    slug = re.sub(r"[^a-zA-Z0-9]+", "-", base).strip("-").lower()
    return slug or "repo"


def unique_slugs(repos):
    """Map each repo identifier to a slug, disambiguating collisions deterministically."""
    seen = {}
    result = []
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


def cmd_init(args) -> int:
    ts = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    shortid = secrets.token_hex(3)
    run_name = f"{ts}-{shortid}"
    if args.label:
        run_name += "-" + slugify(args.label)

    run_dir = base_dir() / "runs" / run_name
    bundles_dir = run_dir / "bundles"
    findings_dir = run_dir / "findings"
    bundles_dir.mkdir(parents=True, exist_ok=True)
    findings_dir.mkdir(parents=True, exist_ok=True)

    repos = unique_slugs(args.repos)
    multi = len(repos) > 1

    manifest = {
        "run_dir": str(run_dir),
        "report": str(run_dir / "report.md"),
        "multi_repo": multi,
        "repos": [
            {
                "repo": repo,
                "slug": slug,
                "bundle": str(bundles_dir / f"{slug}.md"),
                "findings": str(findings_dir / f"{slug}.json"),
            }
            for repo, slug in repos
        ],
    }
    if multi:
        manifest["cross_repo_findings"] = str(findings_dir / "cross-repo.json")

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


def cmd_write_bundle(args) -> int:
    _, manifest = load_manifest(args.run)
    target = Path(_repo_entry(manifest, args.slug)["bundle"])
    target.write_text(read_stdin())
    print(str(target))
    return 0


def cmd_write_findings(args) -> int:
    _, manifest = load_manifest(args.run)
    target = Path(_repo_entry(manifest, args.slug)["findings"])
    payload = read_stdin()
    try:
        json.loads(payload)
    except json.JSONDecodeError as exc:
        return die(f"findings for {args.slug!r} is not valid JSON: {exc}")
    target.write_text(payload)
    print(str(target))
    return 0


def cmd_write_cross_findings(args) -> int:
    _, manifest = load_manifest(args.run)
    if not manifest.get("multi_repo"):
        return die("this run is single-repo; there is no cross-repo findings target")
    target = Path(manifest["cross_repo_findings"])
    payload = read_stdin()
    try:
        json.loads(payload)
    except json.JSONDecodeError as exc:
        return die(f"cross-repo findings is not valid JSON: {exc}")
    target.write_text(payload)
    print(str(target))
    return 0


def cmd_write_report(args) -> int:
    _, manifest = load_manifest(args.run)
    target = Path(manifest["report"])
    target.write_text(read_stdin())
    print(str(target))
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="code-review-workdir",
        description="Allocate and write into a stacia-code-review run directory.",
    )
    sub = parser.add_subparsers(dest="command", required=True)

    p_init = sub.add_parser("init", help="Allocate a run directory and print its manifest.")
    p_init.add_argument("repos", nargs="+", metavar="REPO",
                        help="Repo identifier(s) in scope (name or path; order preserved).")
    p_init.add_argument("--label", default=None,
                        help="Optional human label appended to the run directory name.")
    p_init.set_defaults(func=cmd_init)

    p_b = sub.add_parser("write-bundle", help="Write a repo's diff bundle (stdin).")
    p_b.add_argument("--run", required=True, help="Run directory from init.")
    p_b.add_argument("--slug", required=True, help="Repo slug from the manifest.")
    p_b.set_defaults(func=cmd_write_bundle)

    p_f = sub.add_parser("write-findings", help="Write a repo's raw findings JSON (stdin).")
    p_f.add_argument("--run", required=True, help="Run directory from init.")
    p_f.add_argument("--slug", required=True, help="Repo slug from the manifest.")
    p_f.set_defaults(func=cmd_write_findings)

    p_c = sub.add_parser("write-cross-findings", help="Write the cross-repo findings JSON (stdin).")
    p_c.add_argument("--run", required=True, help="Run directory from init.")
    p_c.set_defaults(func=cmd_write_cross_findings)

    p_r = sub.add_parser("write-report", help="Write the final report (stdin).")
    p_r.add_argument("--run", required=True, help="Run directory from init.")
    p_r.set_defaults(func=cmd_write_report)

    return parser


def main(argv=None) -> int:
    args = build_parser().parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
