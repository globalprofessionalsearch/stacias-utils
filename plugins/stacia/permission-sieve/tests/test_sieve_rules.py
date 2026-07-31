#!/usr/bin/env python3
"""
Integration tests for the permission-sieve Lua rule set.

Pipes tool-call JSON directly to the dispatcher binary and asserts on the
hook response. No Claude Code session needed — tests are idempotent and
execute in milliseconds.

The tests verify the rules at permission-sieve/rules/ — the same files
the hook loads at runtime. One set of scripts, one source of truth.

Run:
    python3 -m pytest tests/test_sieve_rules.py -v
    # or directly:
    python3 tests/test_sieve_rules.py
"""

import hashlib
import json
import os
import subprocess
import sys
import unittest

SIEVE_DIR = os.path.join(os.path.dirname(__file__), "..")
DISPATCHER = os.path.join(SIEVE_DIR, "target", "release", "dispatcher")
RULES_DIR = os.path.join(SIEVE_DIR, "rules")
CHECKSUM_FILE = os.path.join(os.path.dirname(__file__), "rules.sha256")


def sieve(tool_name: str, tool_input: dict) -> dict:
    """Send a tool call to the dispatcher and return the parsed response."""
    event = json.dumps({"tool_name": tool_name, "tool_input": tool_input})
    result = subprocess.run(
        [DISPATCHER, SIEVE_DIR],
        input=event,
        capture_output=True,
        text=True,
        timeout=15,
    )
    if result.returncode != 0:
        raise RuntimeError(
            f"Dispatcher exited {result.returncode}: {result.stderr}"
        )
    return json.loads(result.stdout)


def decision(response: dict) -> str:
    """Extract permissionDecision from hook response."""
    return response["hookSpecificOutput"]["permissionDecision"]


def reason(response: dict) -> str:
    """Extract permissionDecisionReason from hook response."""
    return response["hookSpecificOutput"]["permissionDecisionReason"]


# ── Read tool ────────────────────────────────────────────────


class TestReadTool(unittest.TestCase):
    def test_read_allowed_directory(self):
        r = sieve("Read", {"file_path": os.path.expanduser("~/Documents/code/foo.txt")})
        self.assertEqual(decision(r), "allow")

    def test_read_ssh_config(self):
        r = sieve("Read", {"file_path": os.path.expanduser("~/.ssh/config")})
        self.assertEqual(decision(r), "ask")

    def test_read_ssh_key(self):
        r = sieve("Read", {"file_path": os.path.expanduser("~/.ssh/id_rsa")})
        self.assertEqual(decision(r), "ask")

    def test_read_aws_credentials(self):
        r = sieve("Read", {"file_path": os.path.expanduser("~/.aws/credentials")})
        self.assertEqual(decision(r), "ask")

    def test_read_env_file(self):
        r = sieve("Read", {"file_path": os.path.expanduser("~/Documents/code/project/.env")})
        self.assertEqual(decision(r), "ask")

    def test_read_env_local_file(self):
        r = sieve("Read", {"file_path": os.path.expanduser("~/Documents/code/project/.env.local")})
        self.assertEqual(decision(r), "ask")

    def test_read_env_example_allowed(self):
        r = sieve("Read", {"file_path": os.path.expanduser("~/Documents/code/project/.env.example")})
        self.assertEqual(decision(r), "allow")

    def test_read_external_non_sensitive(self):
        r = sieve("Read", {"file_path": "/etc/hosts"})
        self.assertEqual(decision(r), "allow")

    def test_read_pem_file(self):
        r = sieve("Read", {"file_path": os.path.expanduser("~/Documents/code/cert.pem")})
        self.assertEqual(decision(r), "ask")

    def test_read_key_file(self):
        r = sieve("Read", {"file_path": os.path.expanduser("~/Documents/code/server.key")})
        self.assertEqual(decision(r), "ask")

    def test_read_bashrc(self):
        r = sieve("Read", {"file_path": os.path.expanduser("~/.bashrc")})
        self.assertEqual(decision(r), "ask")

    def test_read_zshrc(self):
        r = sieve("Read", {"file_path": os.path.expanduser("~/.zshrc")})
        self.assertEqual(decision(r), "ask")

    def test_read_kube_config(self):
        r = sieve("Read", {"file_path": os.path.expanduser("~/.kube/config")})
        self.assertEqual(decision(r), "ask")

    def test_read_docker_config(self):
        r = sieve("Read", {"file_path": os.path.expanduser("~/.docker/config.json")})
        self.assertEqual(decision(r), "ask")

    def test_read_npmrc(self):
        r = sieve("Read", {"file_path": os.path.expanduser("~/.npmrc")})
        self.assertEqual(decision(r), "ask")

    def test_read_netrc(self):
        r = sieve("Read", {"file_path": os.path.expanduser("~/.netrc")})
        self.assertEqual(decision(r), "ask")

    def test_read_cache_directory(self):
        r = sieve("Read", {"file_path": os.path.expanduser("~/.cache/some-tool/data.json")})
        self.assertEqual(decision(r), "allow")


# ── Write tool ───────────────────────────────────────────────


class TestWriteTool(unittest.TestCase):
    def test_write_allowed_directory(self):
        r = sieve("Write", {"file_path": os.path.expanduser("~/Documents/code/output.txt"), "content": "test"})
        self.assertEqual(decision(r), "allow")

    def test_write_cache_directory(self):
        r = sieve("Write", {"file_path": os.path.expanduser("~/.cache/tool/data.json"), "content": "{}"})
        self.assertEqual(decision(r), "allow")

    def test_write_outside_allowed_dirs(self):
        r = sieve("Write", {"file_path": "/tmp/output.txt", "content": "test"})
        self.assertEqual(decision(r), "ask")

    def test_write_env_file(self):
        r = sieve("Write", {"file_path": os.path.expanduser("~/Documents/code/.env"), "content": "SECRET=x"})
        self.assertEqual(decision(r), "ask")

    def test_write_ssh_dir(self):
        r = sieve("Write", {"file_path": os.path.expanduser("~/.ssh/authorized_keys"), "content": "key"})
        self.assertEqual(decision(r), "ask")

    def test_write_home_root(self):
        r = sieve("Write", {"file_path": os.path.expanduser("~/random.txt"), "content": "test"})
        self.assertEqual(decision(r), "ask")


# ── Edit tool ────────────────────────────────────────────────


class TestEditTool(unittest.TestCase):
    def test_edit_allowed_directory(self):
        r = sieve("Edit", {
            "file_path": os.path.expanduser("~/Documents/code/main.py"),
            "old_string": "foo",
            "new_string": "bar",
        })
        self.assertEqual(decision(r), "allow")

    def test_edit_outside_allowed_dirs(self):
        r = sieve("Edit", {
            "file_path": "/tmp/main.py",
            "old_string": "foo",
            "new_string": "bar",
        })
        self.assertEqual(decision(r), "ask")

    def test_edit_sensitive_file(self):
        r = sieve("Edit", {
            "file_path": os.path.expanduser("~/.zshrc"),
            "old_string": "foo",
            "new_string": "bar",
        })
        self.assertEqual(decision(r), "ask")


# ── Bash — safe commands ─────────────────────────────────────


class TestBashSafe(unittest.TestCase):
    def test_ls(self):
        r = sieve("Bash", {"command": "ls /tmp"})
        self.assertEqual(decision(r), "allow")

    def test_cat(self):
        r = sieve("Bash", {"command": "cat /tmp/foo.txt"})
        self.assertEqual(decision(r), "allow")

    def test_grep(self):
        r = sieve("Bash", {"command": "grep -r 'pattern' ."})
        self.assertEqual(decision(r), "allow")

    def test_find(self):
        r = sieve("Bash", {"command": "find . -name '*.py'"})
        self.assertEqual(decision(r), "allow")

    def test_head(self):
        r = sieve("Bash", {"command": "head -20 file.txt"})
        self.assertEqual(decision(r), "allow")

    def test_tail(self):
        r = sieve("Bash", {"command": "tail -f log.txt"})
        self.assertEqual(decision(r), "allow")

    def test_wc(self):
        r = sieve("Bash", {"command": "wc -l file.txt"})
        self.assertEqual(decision(r), "allow")

    def test_mkdir(self):
        r = sieve("Bash", {"command": "mkdir -p /tmp/test-dir"})
        self.assertEqual(decision(r), "allow")

    def test_cp(self):
        r = sieve("Bash", {"command": "cp file1.txt file2.txt"})
        self.assertEqual(decision(r), "allow")

    def test_mv(self):
        r = sieve("Bash", {"command": "mv old.txt new.txt"})
        self.assertEqual(decision(r), "allow")

    def test_rm_without_rf(self):
        r = sieve("Bash", {"command": "rm /tmp/file.txt"})
        self.assertEqual(decision(r), "allow")

    def test_sed(self):
        r = sieve("Bash", {"command": "sed 's/old/new/g' file.txt"})
        self.assertEqual(decision(r), "allow")

    def test_awk(self):
        r = sieve("Bash", {"command": "awk '{print $1}' file.txt"})
        self.assertEqual(decision(r), "allow")

    def test_echo(self):
        r = sieve("Bash", {"command": "echo hello"})
        self.assertEqual(decision(r), "allow")

    def test_pwd(self):
        r = sieve("Bash", {"command": "pwd"})
        self.assertEqual(decision(r), "allow")

    def test_cd(self):
        r = sieve("Bash", {"command": "cd /tmp"})
        self.assertEqual(decision(r), "allow")

    def test_sleep(self):
        r = sieve("Bash", {"command": "sleep 1"})
        self.assertEqual(decision(r), "allow")

    def test_make(self):
        r = sieve("Bash", {"command": "make build"})
        self.assertEqual(decision(r), "allow")

    def test_git_status(self):
        r = sieve("Bash", {"command": "git status"})
        self.assertEqual(decision(r), "allow")

    def test_git_log(self):
        r = sieve("Bash", {"command": "git log --oneline -5"})
        self.assertEqual(decision(r), "allow")

    def test_git_diff(self):
        r = sieve("Bash", {"command": "git diff HEAD"})
        self.assertEqual(decision(r), "allow")

    def test_gh_pr_list(self):
        r = sieve("Bash", {"command": "gh pr list"})
        self.assertEqual(decision(r), "allow")

    def test_summon(self):
        r = sieve("Bash", {"command": "summon lint"})
        self.assertEqual(decision(r), "allow")


# ── Bash — kubernetes / cloud read-only ──────────────────────


class TestBashCloudReadOnly(unittest.TestCase):
    def test_kubectl_get(self):
        r = sieve("Bash", {"command": "kubectl get pods"})
        self.assertEqual(decision(r), "allow")

    def test_kubectl_describe(self):
        r = sieve("Bash", {"command": "kubectl describe pod my-pod"})
        self.assertEqual(decision(r), "allow")

    def test_kubectl_logs(self):
        r = sieve("Bash", {"command": "kubectl logs my-pod"})
        self.assertEqual(decision(r), "allow")

    def test_helm_list(self):
        r = sieve("Bash", {"command": "helm list"})
        self.assertEqual(decision(r), "allow")

    def test_helm_status(self):
        r = sieve("Bash", {"command": "helm status my-release"})
        self.assertEqual(decision(r), "allow")

    def test_tofu_plan(self):
        r = sieve("Bash", {"command": "tofu plan"})
        self.assertEqual(decision(r), "allow")

    def test_tofu_show(self):
        r = sieve("Bash", {"command": "tofu show"})
        self.assertEqual(decision(r), "allow")

    def test_gcloud_list(self):
        r = sieve("Bash", {"command": "gcloud compute instances list"})
        self.assertEqual(decision(r), "allow")

    def test_gsutil_ls(self):
        r = sieve("Bash", {"command": "gsutil ls gs://bucket"})
        self.assertEqual(decision(r), "allow")


# ── Bash — carve-outs (should prompt) ────────────────────────


class TestBashCarveouts(unittest.TestCase):
    def test_rm_rf(self):
        r = sieve("Bash", {"command": "rm -rf /tmp/some-dir"})
        self.assertEqual(decision(r), "ask")

    def test_rm_fr(self):
        r = sieve("Bash", {"command": "rm -fr /tmp/some-dir"})
        self.assertEqual(decision(r), "ask")

    def test_git_push(self):
        r = sieve("Bash", {"command": "git push origin main"})
        self.assertEqual(decision(r), "ask")

    def test_summon_ctx_prod(self):
        r = sieve("Bash", {"command": "summon ctx prod"})
        self.assertEqual(decision(r), "ask")

    def test_unknown_command(self):
        r = sieve("Bash", {"command": "some-unknown-tool --flag"})
        self.assertEqual(decision(r), "ask")


# ── Bash — hard denials ──────────────────────────────────────


class TestBashDenied(unittest.TestCase):
    def test_force_push_long_flag(self):
        r = sieve("Bash", {"command": "git push --force origin main"})
        self.assertEqual(decision(r), "deny")

    def test_force_push_short_flag(self):
        r = sieve("Bash", {"command": "git push -f origin main"})
        self.assertEqual(decision(r), "deny")

    def test_force_with_lease_allowed(self):
        """--force-with-lease should NOT be denied."""
        r = sieve("Bash", {"command": "git push --force-with-lease origin main"})
        self.assertNotEqual(decision(r), "deny")

    def test_terraform(self):
        r = sieve("Bash", {"command": "terraform plan"})
        self.assertEqual(decision(r), "deny")
        self.assertIn("tofu", reason(r).lower())

    def test_terraform_init(self):
        r = sieve("Bash", {"command": "terraform init"})
        self.assertEqual(decision(r), "deny")

    def test_tf_alias(self):
        r = sieve("Bash", {"command": "tf plan"})
        self.assertEqual(decision(r), "deny")

    def test_gh_pr_merge(self):
        r = sieve("Bash", {"command": "gh pr merge 123"})
        self.assertEqual(decision(r), "deny")


# ── Bash — sensitive paths in commands ───────────────────────


class TestBashSensitivePaths(unittest.TestCase):
    def test_cat_ssh(self):
        r = sieve("Bash", {"command": "cat ~/.ssh/id_rsa"})
        self.assertEqual(decision(r), "ask")

    def test_cat_aws(self):
        r = sieve("Bash", {"command": "cat ~/.aws/credentials"})
        self.assertEqual(decision(r), "ask")

    def test_cat_env(self):
        r = sieve("Bash", {"command": "cat .env"})
        self.assertEqual(decision(r), "ask")

    def test_grep_in_gnupg(self):
        r = sieve("Bash", {"command": "grep -r key ~/.gnupg/"})
        self.assertEqual(decision(r), "ask")

    def test_tee_to_ssh(self):
        r = sieve("Bash", {"command": "echo key | tee ~/.ssh/authorized_keys"})
        self.assertEqual(decision(r), "ask")


# ── Bash — compound commands ─────────────────────────────────


class TestBashCompound(unittest.TestCase):
    def test_safe_and_safe(self):
        r = sieve("Bash", {"command": "ls /tmp && grep test /etc/hosts"})
        self.assertEqual(decision(r), "allow")

    def test_safe_and_unsafe(self):
        r = sieve("Bash", {"command": "ls /tmp && rm -rf /tmp/fake"})
        self.assertEqual(decision(r), "ask")

    def test_safe_pipe_safe(self):
        r = sieve("Bash", {"command": "cat file.txt | grep pattern"})
        self.assertEqual(decision(r), "allow")

    def test_safe_semicolon_safe(self):
        r = sieve("Bash", {"command": "echo hello; echo world"})
        self.assertEqual(decision(r), "allow")

    def test_safe_semicolon_unknown(self):
        r = sieve("Bash", {"command": "echo hello; unknown-cmd"})
        self.assertEqual(decision(r), "ask")


# ── Non-tool-specific: safe tools ────────────────────────────


class TestSafeTools(unittest.TestCase):
    def test_grep_tool(self):
        r = sieve("Grep", {"pattern": "test", "path": "."})
        self.assertEqual(decision(r), "allow")

    def test_glob_tool(self):
        r = sieve("Glob", {"pattern": "**/*.py"})
        self.assertEqual(decision(r), "allow")

    def test_ls_tool(self):
        r = sieve("LS", {"path": "."})
        self.assertEqual(decision(r), "allow")

    def test_web_search(self):
        r = sieve("WebSearch", {"query": "python docs"})
        self.assertEqual(decision(r), "allow")

    def test_web_fetch(self):
        r = sieve("WebFetch", {"url": "https://example.com"})
        self.assertEqual(decision(r), "allow")

    def test_skill(self):
        r = sieve("Skill", {"skill": "stacia:sieve-test"})
        self.assertEqual(decision(r), "allow")

    def test_ask_user_question(self):
        r = sieve("AskUserQuestion", {"question": "Which approach?"})
        self.assertEqual(decision(r), "allow")

    def test_tool_search(self):
        r = sieve("ToolSearch", {"query": "select:Read"})
        self.assertEqual(decision(r), "allow")


# ── Unknown tools (should prompt) ────────────────────────────


class TestUnknownTools(unittest.TestCase):
    def test_unknown_tool(self):
        r = sieve("SomeNewTool", {"input": "data"})
        self.assertEqual(decision(r), "ask")

    def test_mcp_tool(self):
        r = sieve("mcp__plugin_atlassian__getJiraIssue", {"issueId": "PROJ-123"})
        self.assertEqual(decision(r), "ask")

    def test_agent_tool_no_model(self):
        r = sieve("Agent", {"description": "do something", "prompt": "hello"})
        self.assertEqual(decision(r), "deny")


# ── Subagent model guard ─────────────────────────────────────


class TestSubagentModel(unittest.TestCase):
    def test_sonnet_shorthand_denied(self):
        """Bare 'sonnet' resolves to latest (Sonnet 5), not 4.6."""
        r = sieve("Agent", {"description": "task", "prompt": "do it", "model": "sonnet"})
        self.assertEqual(decision(r), "deny")

    def test_sonnet_4_6_prompts(self):
        r = sieve("Agent", {"description": "task", "prompt": "do it", "model": "sonnet-4-6"})
        self.assertEqual(decision(r), "ask")

    def test_sonnet_4_6_full_id_prompts(self):
        r = sieve("Agent", {"description": "task", "prompt": "do it", "model": "claude-sonnet-4-6"})
        self.assertEqual(decision(r), "ask")

    def test_sonnet_5_denied(self):
        r = sieve("Agent", {"description": "task", "prompt": "do it", "model": "claude-sonnet-5"})
        self.assertEqual(decision(r), "deny")

    def test_sonnet_5_shorthand_denied(self):
        r = sieve("Agent", {"description": "task", "prompt": "do it", "model": "sonnet-5"})
        self.assertEqual(decision(r), "deny")

    def test_haiku_shorthand_prompts(self):
        r = sieve("Agent", {"description": "task", "prompt": "do it", "model": "haiku"})
        self.assertEqual(decision(r), "ask")

    def test_haiku_full_id_prompts(self):
        r = sieve("Agent", {"description": "task", "prompt": "do it", "model": "claude-haiku-4-5"})
        self.assertEqual(decision(r), "ask")

    def test_opus_denied(self):
        r = sieve("Agent", {"description": "task", "prompt": "do it", "model": "opus"})
        self.assertEqual(decision(r), "deny")

    def test_fable_denied(self):
        r = sieve("Agent", {"description": "task", "prompt": "do it", "model": "fable"})
        self.assertEqual(decision(r), "deny")

    def test_no_model_denied(self):
        r = sieve("Agent", {"description": "task", "prompt": "do it"})
        self.assertEqual(decision(r), "deny")
        self.assertIn("sonnet", reason(r).lower())

    def test_workflow_always_prompts(self):
        r = sieve("Workflow", {"script": "export const meta = {name: 'test'};"})
        self.assertEqual(decision(r), "ask")

    def test_non_agent_tool_skips(self):
        r = sieve("Bash", {"command": "ls"})
        self.assertEqual(decision(r), "allow")


# ── Rule checksum verification ───────────────────────────────


def compute_checksums() -> dict[str, str]:
    """SHA-256 each .lua file in rules/, keyed by filename."""
    checksums = {}
    for name in sorted(os.listdir(RULES_DIR)):
        if not name.endswith(".lua"):
            continue
        path = os.path.join(RULES_DIR, name)
        with open(path, "rb") as f:
            checksums[name] = hashlib.sha256(f.read()).hexdigest()
    return checksums


def load_checksums() -> dict[str, str]:
    """Load saved checksums from rules.sha256."""
    checksums = {}
    if not os.path.exists(CHECKSUM_FILE):
        return checksums
    with open(CHECKSUM_FILE) as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            sha, name = line.split("  ", 1)
            checksums[name] = sha
    return checksums


def save_checksums(checksums: dict[str, str]) -> None:
    """Write checksums to rules.sha256 in sha256sum format."""
    with open(CHECKSUM_FILE, "w") as f:
        for name in sorted(checksums):
            f.write(f"{checksums[name]}  {name}\n")


class TestRuleChecksums(unittest.TestCase):
    def test_rules_match_saved_checksums(self):
        current = compute_checksums()
        saved = load_checksums()

        if not saved:
            self.fail(
                "No checksum file found at tests/rules.sha256. "
                "Run: python3 tests/test_sieve_rules.py --update-checksums"
            )

        added = set(current) - set(saved)
        removed = set(saved) - set(current)
        changed = {
            name for name in set(current) & set(saved)
            if current[name] != saved[name]
        }

        if not added and not removed and not changed:
            return

        lines = [
            "",
            "Rule files have changed since the test suite was last updated.",
            "Review and update the test cases, then regenerate checksums:",
            "",
            "    python3 tests/test_sieve_rules.py --update-checksums",
            "",
        ]
        if added:
            lines.append(f"  Added:   {', '.join(sorted(added))}")
        if removed:
            lines.append(f"  Removed: {', '.join(sorted(removed))}")
        if changed:
            lines.append(f"  Changed: {', '.join(sorted(changed))}")

        self.fail("\n".join(lines))


if __name__ == "__main__":
    if "--update-checksums" in sys.argv:
        checksums = compute_checksums()
        save_checksums(checksums)
        print(f"Updated {CHECKSUM_FILE} with {len(checksums)} rule(s):")
        for name in sorted(checksums):
            print(f"  {name}")
        sys.exit(0)
    unittest.main()
