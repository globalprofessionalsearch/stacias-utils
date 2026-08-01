-- Auto-approves known-safe bash commands. Commands not matched here
-- return "uncertain" (-> ask the user).

if request.tool_name ~= "Bash" then return "skip" end

local cmd = request.tool_input.command or ""

local function starts_with(s, prefix)
  return s:sub(1, #prefix) == prefix
end

local function trim(s)
  return s:match("^%s*(.-)%s*$")
end

local function strip_redirects(s)
  s = s:gsub("%d*>%&%d+", "")
  s = s:gsub("%d*>>%s*%S+", "")
  s = s:gsub("%d*>%s*%S+", "")
  s = s:gsub("<%s*%S+", "")
  return s
end

local function split_segments(s)
  s = strip_redirects(s)
  local segments = {}
  local current = {}
  local in_single = false
  local in_double = false
  local i = 1
  while i <= #s do
    local c = s:sub(i, i)
    if c == "'" and not in_double then
      in_single = not in_single
      current[#current + 1] = c
    elseif c == '"' and not in_single then
      in_double = not in_double
      current[#current + 1] = c
    elseif c == "\\" and not in_single then
      current[#current + 1] = c
      if i < #s then
        i = i + 1
        current[#current + 1] = s:sub(i, i)
      end
    elseif not in_single and not in_double and (c == "&" or c == "|" or c == ";") then
      local t = trim(table.concat(current))
      if t and #t > 0 then
        segments[#segments + 1] = t
      end
      current = {}
    else
      current[#current + 1] = c
    end
    i = i + 1
  end
  local t = trim(table.concat(current))
  if t and #t > 0 then
    segments[#segments + 1] = t
  end
  if #segments == 0 then
    segments[1] = trim(s)
  end
  return segments
end

local simple_cmds = {
  "cd", "pwd", "echo", "cat", "ls", "find", "grep", "head", "tail",
  "wc", "sleep", "mkdir", "mv", "cp", "rm", "sed", "awk", "touch",
  "git", "gh", "summon", "make", "oapi-codegen",
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

local segments = split_segments(cmd)

for _, seg in ipairs(segments) do
  if not is_safe(seg) then return "uncertain" end
end

return "approved"
