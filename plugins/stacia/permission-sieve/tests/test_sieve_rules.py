#!/usr/bin/env python3
"""
Integration tests for the permission-sieve Lua rule set.

Pipes tool-call JSON directly to the dispatcher binary and asserts on the
hook response. No Claude Code session needed — tests are idempotent and
execute in milliseconds.

The tests verify the DEPLOYED scripts at ~/.cache/stacia-permission-sieve/.
If you've edited examples but not copied them, results will reflect the
deployed versions, not the repo copies.

Run:
    python3 -m pytest tests/test_sieve_rules.py -v
    # or directly:
    python3 tests/test_sieve_rules.py
"""

import json
import os
import subprocess
import unittest

DISPATCHER = os.path.join(
    os.path.dirname(__file__), "..", "target", "release", "dispatcher"
)


def sieve(tool_name: str, tool_input: dict) -> dict:
    """Send a tool call to the dispatcher and return the parsed response."""
    event = json.dumps({"tool_name": tool_name, "tool_input": tool_input})
    result = subprocess.run(
        [DISPATCHER],
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

    def test_agent_tool(self):
        r = sieve("Agent", {"description": "do something", "prompt": "hello"})
        self.assertEqual(decision(r), "ask")


if __name__ == "__main__":
    unittest.main()
