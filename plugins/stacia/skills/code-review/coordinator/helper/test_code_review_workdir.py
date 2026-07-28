"""Tests for code-review-workdir.py — slug routing, write commands, and the
atomic status signal. Runnable via `pytest` or directly with `python3`.
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


def test_write_findings_repo_slug(tmp_path):
    man = _init(tmp_path, "myrepo")
    run = man["run_dir"]
    slug = man["repos"][0]["slug"]
    proc = _run(["write-findings", "--run", run, "--slug", slug], tmp_path, stdin='{"repo":"data"}')
    assert proc.returncode == 0, proc.stderr
    assert Path(man["repos"][0]["findings"]).is_file()


def test_derived_slug_collision_is_disambiguated(tmp_path):
    # Two repos with the same basename must get distinct slugs, and a repo
    # whose basename is literally the first repo's derived suffix must not
    # collide with it.
    man = _init(tmp_path, "api", "api", "api-1")
    slugs = [r["slug"] for r in man["repos"]]
    assert len(slugs) == len(set(slugs)), slugs


def test_findings_slug_cannot_escape_run_dir(tmp_path):
    man = _init(tmp_path, "myrepo")
    run = Path(man["run_dir"])
    _run(["write-findings", "--run", str(run), "--slug", "../../evil"], tmp_path, stdin='{"x":1}')
    # nothing is written outside the run's findings dir
    assert not (run.parent.parent / "evil.json").exists()
    escaped = list(run.parent.rglob("evil.json"))
    assert all(str(run / "findings") in str(p) for p in escaped), escaped


def test_write_status_is_recorded_in_the_manifest(tmp_path):
    man = _init(tmp_path, "myrepo")
    assert man["status"].endswith("/status.json")
    assert man["status"].startswith(man["run_dir"])


def test_write_status_writes_the_payload(tmp_path):
    man = _init(tmp_path, "myrepo")
    run = Path(man["run_dir"])
    _run(["write-status", "--run", str(run)], tmp_path,
         stdin='{"state":"complete","verdict":"met"}')
    assert json.loads((run / "status.json").read_text())["verdict"] == "met"


def test_write_status_leaves_no_temp_file(tmp_path):
    # status.json is written temp-then-rename so a poller never sees a partial
    # file. The temp must not survive, or the run dir accumulates litter.
    man = _init(tmp_path, "myrepo")
    run = Path(man["run_dir"])
    _run(["write-status", "--run", str(run)], tmp_path, stdin='{"state":"failed"}')
    assert list(run.glob("*.tmp")) == []


def test_write_status_rejects_invalid_json(tmp_path):
    # A corrupt signal is worse than none: the waiter would report the run as
    # terminated with an unreadable outcome.
    man = _init(tmp_path, "myrepo")
    run = Path(man["run_dir"])
    proc = _run(["write-status", "--run", str(run)], tmp_path, stdin="{ nope")
    assert proc.returncode != 0
    assert not (run / "status.json").exists()


def test_write_status_overwrites_a_previous_status(tmp_path):
    man = _init(tmp_path, "myrepo")
    run = Path(man["run_dir"])
    _run(["write-status", "--run", str(run)], tmp_path, stdin='{"state":"complete"}')
    _run(["write-status", "--run", str(run)], tmp_path, stdin='{"state":"failed"}')
    assert json.loads((run / "status.json").read_text())["state"] == "failed"


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
