# Rule proposal — porting the pi-permission-system config to sieves

Source: `~/.pi/agent/extensions/pi-permission-system/config.json` (Stacia's live
config). This document proposes a set of **rejecters** and **approvers** for the
standalone sieve gate, grouped by logical domain, tiered from tractable to
complex.

## Mapping principle

The original three-state permission model collapses onto the two sieves:

| Original config       | Sieve gate                                  |
| --------------------- | ------------------------------------------- |
| `deny` (+ `reason`)   | **rejecter** — block, surface reason        |
| `allow`               | **approver** — run outright                 |
| `ask`                 | **no rule** — falls through to haiku + confirm |

Two ordering facts keep the port faithful:

- Rejecters run **before** approvers, so a `deny` always beats an `allow` —
  matching the original's "most-restrictive wins."
- `ask` needs no rule at all; the *absence* of an approver is the ask.

### The simple-command constraint

A bash-domain approver fires **only for a single simple command** — no `|`,
`;`, `&&`, `||`, `&`, `$(…)`, backticks, `<`/`>` redirects, or newlines. Any
compound/chained command falls through to the confirm prompt.

This is a deliberate, conservative simplification. It sidesteps bash command
**decomposition** (which the original system performed and which we have set
aside — see Tier 3), and it closes the compound blind spot observed in live
testing, where an `^`-anchored match on `ls` auto-approved an entire
`ls; …; …` chain.

---

## Tier 1 — tractable now

Bash single-command domains + non-bash tool domains. No path normalization
required.

### Rejecters (deny + reason)

| name                 | matches                              | reason                          |
| -------------------- | ------------------------------------ | ------------------------------- |
| `git-force-push`     | `git push --force*`, `git push -f*`  | Force push is destructive       |
| `gh-pr-merge`        | `gh pr merge *`                      | Use the GitHub UI to merge PRs  |
| `terraform-not-tofu` | `tf *`, `terraform *`                | Use tofu instead of terraform   |

### Approvers — bash domains (simple-command only)

| domain (name) | allowed                                                                                                             | excluded → falls through to ask       |
| ------------- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------- |
| `coreutils`   | cd, pwd, echo, cat, ls, find, grep, head, tail, wc, sleep, mkdir, mv, cp, sed, awk, `rm`                            | `rm -rf`, `rm -fr`                    |
| `git`         | `git *`                                                                                                            | `git push *`                          |
| `gh`          | `gh *`                                                                                                            | (`gh pr merge` rejected in Tier 1)    |
| `build`       | `make *`, `oapi-codegen *`                                                                                          | —                                     |
| `summon`      | `summon *`                                                                                                        | `summon ctx prod`                     |
| `kubectl`     | get, describe, logs, top, explain, version, api-resources, api-versions, cluster-info, `auth can-i`, diff          | all mutating verbs                    |
| `helm`        | template, lint, show, list, status, get, history, dependency, package, repo, create                                | install/upgrade/uninstall/rollback    |
| `argocd`      | `<sub> list`, `<sub> get`, `app diff/history/logs/manifests/resources`, version                                    | sync/create/delete/set                |
| `gcloud`      | `config list`, `auth list`, `<group> list`, `<group> describe`, info, version, `logging read`                      | mutating                              |
| `gsutil`      | ls, cat, stat, du, hash, version                                                                                   | cp/rm/mb/rb                           |
| `tofu`        | plan, show, `state list`, `state show`, output, validate, version, providers, graph, `fmt -check`                  | apply/destroy/`state rm`/import       |

### Approvers — non-bash tools (matched by `toolName`)

| name            | allowed tools                                                                                                    |
| --------------- | --------------------------------------------------------------------------------------------------------------- |
| `readonly-tools`| read, ls, grep, find, fffind, ffgrep, web_search, fetch_content, get_search_content, intercom, ask_user_question, structured_output |
| `skill`         | skill invocations                                                                                               |

---

## Tier 2 — medium (needs path normalization)

These map, but require `~`-expansion and canonicalization of `input.path`
before a glob comparison, so they are a deliberate second pass:

- **`edit` / `write` scoping** — allow under `~/Documents/code/*`; ask under
  `~/.pi/agent/extensions/*`. An approver that fires only when the resolved
  target path is under the code dir.
- **`subagent`** — allow `list` / `doctor`, ask everything else. Depends on how
  the subagent tool surfaces its arguments; needs a look before encoding.

---

## Tier 3 — set aside (not easily representable)

- **The `path` + `external_directory` secret-file policy.** The original makes
  `read` broadly `allow` yet still **asks** on `*.env`, `~/.ssh/*`, `*.pem`,
  `~/.aws/*`, `~/.gnupg/*`, `~/.npmrc`, `~/.kube/config`, etc. That is a
  *cross-cutting* gate applied across read/grep/find/ls/edit/write with glob +
  canonical-path matching and symlink resolution — the permission-system's
  dedicated engine. The `tool_call` hook exposes raw per-tool `input.path` but
  none of that normalization/secret-glob machinery. Rebuilding it is a
  workstream, not a rule.
- **Compound / piped bash** (`kubectl get … | jq`, `a && b`). Legitimate but
  chained commands fall through to confirm under the simple-command constraint.
  Proper handling needs bash decomposition, also set aside for parity.

---

## Behavior deltas from the current gate

1. **`rm -rf` → ask, not block.** The live config makes `rm -rf` an `ask`, but
   the current gate has a rejecter that *blocks* it. This proposal follows the
   config: drop the `rm-rf` rejecter and let the `coreutils` approver exclude
   `rm -rf` / `rm -fr` so they fall through to confirm.
2. **Drop `large-inline-script` rejecter.** It is not in the live config (it was
   an early example). Proposed for removal unless kept as a new addition.

---

## Proposed structure in `sieves.ts`

One named approver per domain, each of the form:

1. narrow to `bash` (or to the tool name, for tool domains);
2. extract the simple command (bail to fall-through if compound);
3. match the domain's allow list, honoring its exclusions.

Rejecters likewise one named entry per deny rule. A shared `simpleCommand()`
helper implements the simple-command constraint used by every bash approver.

---

## Appendix — original pi-permission-system configuration

Verbatim copy of `~/.pi/agent/extensions/pi-permission-system/config.json` at
the time of this proposal, for reference.

```json
{
  "debugLog": false,
  "permissionReviewLog": true,
  "yoloMode": false,
  "authorizerChain": ["hello-world"],
  "permission": {
    "external_directory": {
      "*": "ask",
      "~/Documents/code/*": "allow",
      "~/.pi/*": "allow",
      "~/.cache/*": "allow"
    },
    "path": {
      "*": "allow",
      "*.env": "ask",
      "*.env.*": "ask",
      "*.env.example": "allow",
      "~/.bashrc": "ask",
      "~/.bash_profile": "ask",
      "~/.zshrc": "ask",
      "~/.zprofile": "ask",
      "~/.zshenv": "ask",
      "~/.ssh/*": "ask",
      "~/.aws/*": "ask",
      "~/.gnupg/*": "ask",
      "~/.netrc": "ask",
      "~/.npmrc": "ask",
      "~/.kube/config": "ask",
      "~/.docker/config.json": "ask",
      "~/.config/gh/hosts.yml": "ask",
      "*.pem": "ask",
      "*.key": "ask"
    },
    "read": "allow",
    "ls": "allow",
    "grep": "allow",
    "find": "allow",
    "fffind": "allow",
    "ffgrep": "allow",
    "web_search": "allow",
    "fetch_content": "allow",
    "get_search_content": "allow",
    "intercom": "allow",
    "ask_user_question": "allow",
    "structured_output": "allow",
    "edit": {
      "~/Documents/code/*": "allow",
      "~/.pi/agent/extensions/*": "ask"
    },
    "write": {
      "~/Documents/code/*": "allow",
      "~/.pi/agent/extensions/*": "ask"
    },
    "subagent": {
      "*": "ask",
      "list": "allow",
      "doctor": "allow"
    },
    "skill": "allow",
    "bash": {
      "cd *": "allow",
      "pwd": "allow",
      "echo *": "allow",
      "cat *": "allow",
      "ls *": "allow",
      "find *": "allow",
      "grep *": "allow",
      "head *": "allow",
      "tail *": "allow",
      "wc *": "allow",
      "sleep *": "allow",
      "mkdir *": "allow",
      "mv *": "allow",
      "cp *": "allow",
      "rm *": "allow",
      "rm -rf *": "ask",
      "rm -fr *": "ask",
      "sed *": "allow",
      "sed -i *": "allow",
      "sed --in-place *": "allow",
      "awk *": "allow",
      "git *": "allow",
      "git push *": "ask",
      "git push --force *": {
        "action": "deny",
        "reason": "Force push is destructive"
      },
      "git push -f *": {
        "action": "deny",
        "reason": "Force push is destructive"
      },
      "gh *": "allow",
      "gh pr merge *": {
        "action": "deny",
        "reason": "Use the GitHub UI to merge PRs"
      },
      "summon *": "allow",
      "summon ctx prod": "ask",
      "make *": "allow",
      "oapi-codegen *": "allow",
      "kubectl get *": "allow",
      "kubectl describe *": "allow",
      "kubectl logs *": "allow",
      "kubectl top *": "allow",
      "kubectl explain *": "allow",
      "kubectl version *": "allow",
      "kubectl api-resources *": "allow",
      "kubectl api-versions *": "allow",
      "kubectl cluster-info *": "allow",
      "kubectl auth can-i *": "allow",
      "kubectl diff *": "allow",
      "helm template *": "allow",
      "helm lint *": "allow",
      "helm show *": "allow",
      "helm list *": "allow",
      "helm status *": "allow",
      "helm get *": "allow",
      "helm history *": "allow",
      "helm dependency *": "allow",
      "helm package *": "allow",
      "helm repo *": "allow",
      "helm create *": "allow",
      "argocd * list *": "allow",
      "argocd * get *": "allow",
      "argocd app diff *": "allow",
      "argocd app history *": "allow",
      "argocd app logs *": "allow",
      "argocd app manifests *": "allow",
      "argocd app resources *": "allow",
      "argocd version *": "allow",
      "gcloud config list *": "allow",
      "gcloud auth list *": "allow",
      "gcloud * list *": "allow",
      "gcloud * describe *": "allow",
      "gcloud info *": "allow",
      "gcloud version *": "allow",
      "gcloud logging read *": "allow",
      "gsutil ls *": "allow",
      "gsutil cat *": "allow",
      "gsutil stat *": "allow",
      "gsutil du *": "allow",
      "gsutil hash *": "allow",
      "gsutil version *": "allow",
      "tofu plan *": "allow",
      "tofu show *": "allow",
      "tofu state list *": "allow",
      "tofu state show *": "allow",
      "tofu output *": "allow",
      "tofu validate *": "allow",
      "tofu version *": "allow",
      "tofu providers *": "allow",
      "tofu graph *": "allow",
      "tofu fmt -check *": "allow",
      "tf *": {
        "action": "deny",
        "reason": "Use tofu instead of terraform"
      },
      "terraform *": {
        "action": "deny",
        "reason": "Use tofu instead of terraform"
      }
    }
  }
}
```
