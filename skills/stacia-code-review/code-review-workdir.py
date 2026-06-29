#!/usr/bin/env python3
"""Allocate a deterministic run directory for a stacia-code-review run.

This is a private helper for the stacia-code-review skill (NOT a PATH utility).
It owns every path, name, and mkdir for a review run so the orchestrating model
never has to invent one. Call it once, after scope is confirmed, with the repo
identifiers in scope; it creates the run tree and prints the absolute paths of
every artifact as JSON on stdout.

Layout (base = ${XDG_CACHE_HOME:-$HOME/.cache}/stacia-code-review):

    runs/<UTC-timestamp>-<shortid>/
        bundles/<slug>.md        # one diff bundle per repo (orchestrator writes)
        findings/<slug>.json     # raw per-perspective reviewer results per repo
        findings/cross-repo.json # cross-repo reviewer result (multi-repo only)
        report.md                # final assembled report (orchestrator writes)

The script only creates directories and reports paths; it never writes content.
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


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(
        prog="code-review-workdir",
        description="Allocate a run directory for a stacia-code-review run.",
    )
    parser.add_argument(
        "repos",
        nargs="+",
        metavar="REPO",
        help="Repo identifier(s) in scope (name or path; order preserved).",
    )
    parser.add_argument(
        "--label",
        default=None,
        help="Optional human label appended to the run directory name.",
    )
    args = parser.parse_args(argv)

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

    out = {
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
        out["cross_repo_findings"] = str(findings_dir / "cross-repo.json")

    json.dump(out, sys.stdout, indent=2)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
