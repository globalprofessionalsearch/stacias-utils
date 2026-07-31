-- Auto-approves known-safe bash commands. Commands not matched here
-- return "uncertain" (-> ask the user).
-- Run AFTER deny-dangerous.lua so hard denials are already handled.

if request.tool_name ~= "Bash" then return "skip" end

local cmd = request.tool_input.command or ""

local function starts_with(s, prefix)
  return s:sub(1, #prefix) == prefix
end

local function trim(s)
  return s:match("^%s*(.-)%s*$")
end

-- Split on shell operators to check each segment independently.
-- If ALL segments are safe, approve. If any is unknown, pass.
local function split_segments(s)
  local segments = {}
  for part in s:gmatch("[^&|;]+") do
    local t = trim(part)
    if t and #t > 0 then
      segments[#segments + 1] = t
    end
  end
  if #segments == 0 then
    segments[1] = trim(s)
  end
  return segments
end

-- Commands that should prompt the user (carve-outs from broader allows)
local function needs_ask(segment)
  if segment:match("^rm%s+%-rf") or segment:match("^rm%s+%-fr") then return true end
  if segment:match("^git%s+push") then return true end
  if segment:match("^summon%s+ctx%s+prod") then return true end
  return false
end

-- Single-word commands that are safe with any arguments
local simple_cmds = {
  "cd", "pwd", "echo", "cat", "ls", "find", "grep", "head", "tail",
  "wc", "sleep", "mkdir", "mv", "cp", "rm", "sed", "awk",
  "git", "gh", "summon", "make", "oapi-codegen",
}

-- Multi-word command prefixes that are safe
local compound_prefixes = {
  -- kubectl (read-only subcommands)
  "kubectl get", "kubectl describe", "kubectl logs", "kubectl top",
  "kubectl explain", "kubectl version", "kubectl api-resources",
  "kubectl api-versions", "kubectl cluster-info", "kubectl auth can-i",
  "kubectl diff",
  -- helm (read-only / build subcommands)
  "helm template", "helm lint", "helm show", "helm list", "helm status",
  "helm get", "helm history", "helm dependency", "helm package",
  "helm repo", "helm create",
  -- argocd (read-only subcommands)
  "argocd app diff", "argocd app history", "argocd app logs",
  "argocd app manifests", "argocd app resources",
  "argocd version",
  -- gcloud (read-only subcommands)
  "gcloud config list", "gcloud auth list", "gcloud info", "gcloud version",
  "gcloud logging read",
  -- gsutil (read-only subcommands)
  "gsutil ls", "gsutil cat", "gsutil stat", "gsutil du",
  "gsutil hash", "gsutil version",
  -- tofu (read-only / plan subcommands)
  "tofu plan", "tofu show", "tofu state list", "tofu state show",
  "tofu output", "tofu validate", "tofu version", "tofu providers",
  "tofu graph", "tofu fmt -check",
}

-- Lua patterns for wildcard matches (argocd * list, gcloud * list, etc.)
local wildcard_patterns = {
  "^argocd%s+.+%s+list",
  "^argocd%s+.+%s+get",
  "^gcloud%s+.+%s+list",
  "^gcloud%s+.+%s+describe",
}

local function is_safe(segment)
  for _, c in ipairs(simple_cmds) do
    if segment == c or starts_with(segment, c .. " ") then
      return true
    end
  end

  for _, prefix in ipairs(compound_prefixes) do
    if segment == prefix or starts_with(segment, prefix .. " ") then
      return true
    end
  end

  for _, pattern in ipairs(wildcard_patterns) do
    if segment:match(pattern) then return true end
  end

  return false
end

local segments = split_segments(cmd)

for _, seg in ipairs(segments) do
  if needs_ask(seg) then return "uncertain" end
end

for _, seg in ipairs(segments) do
  if not is_safe(seg) then return "uncertain" end
end

return "approved"
