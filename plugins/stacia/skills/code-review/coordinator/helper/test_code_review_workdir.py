"""Tests for code-review-workdir.py — focused on the write-findings slug routing
and the reserved 'synthesis' slug (the cross-language contract with the TS
coordinator). Runnable via `pytest` or directly with `python3`.
"""

import json
import subprocess
import sys
from pathlib import Path

HELPER = Path(__file__).parent / "code-review-workdir.py"


def _run(args, tmp, stdin=None):
    return subprocess.run(
        [sys.executable, str(HELPER), *args],
        input=stdin,
        text=True,
        capture_output=True,
        env={"XDG_CACHE_HOME": str(tmp), "PATH": __import__("os").environ["PATH"]},
    )


def _init(tmp, *repos):
    proc = _run(["init", *repos], tmp)
    assert proc.returncode == 0, proc.stderr
    return json.loads(proc.stdout)


def test_write_findings_synthesis_slug(tmp_path):
    man = _init(tmp_path, "myrepo")
    run = man["run_dir"]
    proc = _run(["write-findings", "--run", run, "--slug", "synthesis"], tmp_path, stdin='{"verdict":"met"}')
    assert proc.returncode == 0, proc.stderr
    out = Path(run) / "findings" / "synthesis.json"
    assert out.is_file()
    assert json.loads(out.read_text())["verdict"] == "met"


def test_write_findings_repo_slug(tmp_path):
    man = _init(tmp_path, "myrepo")
    run = man["run_dir"]
    slug = man["repos"][0]["slug"]
    proc = _run(["write-findings", "--run", run, "--slug", slug], tmp_path, stdin='{"repo":"data"}')
    assert proc.returncode == 0, proc.stderr
    assert Path(man["repos"][0]["findings"]).is_file()


def test_reserved_synthesis_slug_is_never_a_repo(tmp_path):
    # a repo whose basename slugifies to 'synthesis' must NOT take the reserved slug
    man = _init(tmp_path, "synthesis", "other")
    slugs = [r["slug"] for r in man["repos"]]
    assert "synthesis" not in slugs, slugs
    assert slugs[0].startswith("synthesis-"), slugs

    run = man["run_dir"]
    # synthesis findings still route to findings/synthesis.json, not the repo's file
    _run(["write-findings", "--run", run, "--slug", "synthesis"], tmp_path, stdin='{"verdict":"partial"}')
    synth = Path(run) / "findings" / "synthesis.json"
    assert synth.is_file()
    assert json.loads(synth.read_text())["verdict"] == "partial"
    # the repo's own findings file is distinct
    assert Path(man["repos"][0]["findings"]).name != "synthesis.json"


def test_derived_slug_collision_is_disambiguated(tmp_path):
    # "synthesis" is bumped off the reserved slug to "synthesis-1" -- but a
    # second repo whose basename literally IS "synthesis-1" must not collide
    # with that derived slug. unique_slugs() must disambiguate against the set
    # of already-ASSIGNED FINAL slugs, not just against each base name's own
    # collision count.
    man = _init(tmp_path, "synthesis", "synthesis-1", "other")
    slugs = [r["slug"] for r in man["repos"]]
    assert len(slugs) == len(set(slugs)), slugs
    assert "synthesis" not in slugs, slugs


def test_findings_slug_cannot_escape_run_dir(tmp_path):
    man = _init(tmp_path, "myrepo")
    run = Path(man["run_dir"])
    _run(["write-findings", "--run", str(run), "--slug", "../../evil"], tmp_path, stdin='{"x":1}')
    # nothing is written outside the run's findings dir
    assert not (run.parent.parent / "evil.json").exists()
    escaped = list(run.parent.rglob("evil.json"))
    assert all(str(run / "findings") in str(p) for p in escaped), escaped


if __name__ == "__main__":
    import tempfile

    passed = 0
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            with tempfile.TemporaryDirectory() as d:
                fn(Path(d))
            print(f"ok  {name}")
            passed += 1
    print(f"\n{passed} passed")
