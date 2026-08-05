-- Auto-approves known-safe bash commands. Commands not matched here
-- return "uncertain" (-> ask the user).
--
-- The dispatcher splits compound commands into segments before this
-- rule runs — each invocation sees a single command segment.

if request.tool_name ~= "Bash" then return "skip" end

local cmd = request.tool_input.command or ""

local function starts_with(s, prefix)
  return s:sub(1, #prefix) == prefix
end

local simple_cmds = {
  "cd", "pwd", "echo", "cat", "ls", "find", "grep", "head", "tail",
  "wc", "sleep", "mkdir", "mv", "cp", "rm", "sed", "awk", "touch",
  "git", "gh", "summon", "make", "cargo", "go", "which", "oapi-codegen",
}

local scoped_prefixes = {
  "python -m py_compile", "python3 -m py_compile",
  "python -m pytest", "python3 -m pytest",
  "python -m unittest", "python3 -m unittest",
  "python -m mypy", "python3 -m mypy",
  "python -m ruff", "python3 -m ruff",
  "uv run pytest", "uv run mypy", "uv run ruff",
  "uv sync", "uv pip install", "uv pip list", "uv pip show",
  "uv lock", "uv venv",
}

local compound_prefixes = {
  "kubectl get", "kubectl describe", "kubectl logs", "kubectl top",
  "kubectl explain", "kubectl version", "kubectl api-resources",
  "kubectl api-versions", "kubectl cluster-info", "kubectl auth can-i",
  "kubectl diff",
  "helm template", "helm lint", "helm show", "helm list", "helm status",
  "helm get", "helm history", "helm dependency", "helm package",
  "helm repo", "helm create",
  "argocd app diff", "argocd app history", "argocd app logs",
  "argocd app manifests", "argocd app resources",
  "argocd version",
  "gcloud config list", "gcloud auth list", "gcloud info", "gcloud version",
  "gcloud logging read",
  "gsutil ls", "gsutil cat", "gsutil stat", "gsutil du",
  "gsutil hash", "gsutil version",
  "tofu plan", "tofu show", "tofu state list", "tofu state show",
  "tofu output", "tofu validate", "tofu version", "tofu providers",
  "tofu graph", "tofu fmt -check",
  "docker compose up", "docker compose down", "docker compose ps",
  "docker compose logs", "docker compose build", "docker compose pull",
  "docker compose restart", "docker compose stop", "docker compose start",
  "docker compose config", "docker compose top", "docker compose version",
  "docker ps", "docker logs", "docker images", "docker inspect",
  "docker volume ls", "docker network ls", "docker info", "docker version",
}

local wildcard_patterns = {
  "^argocd%s+.+%s+list",
  "^argocd%s+.+%s+get",
  "^gcloud%s+.+%s+list",
  "^gcloud%s+.+%s+describe",
}

local function is_safe(segment)
  for _, c in ipairs(simple_cmds) do
    if segment == c or starts_with(segment, c .. " ") then return true end
  end
  for _, prefix in ipairs(compound_prefixes) do
    if segment == prefix or starts_with(segment, prefix .. " ") then return true end
  end
  for _, pattern in ipairs(wildcard_patterns) do
    if segment:match(pattern) then return true end
  end
  for _, prefix in ipairs(scoped_prefixes) do
    if segment == prefix or starts_with(segment, prefix .. " ") then return true end
  end
  return false
end

if is_safe(cmd) then return "approved" end

return "uncertain"
