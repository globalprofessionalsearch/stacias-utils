-- Returns "uncertain" (-> ask) when any tool accesses sensitive files.
-- Uses request.paths for structured tools, plus substring scanning
-- on bash commands as a safety net.

local sensitive_dirs = {
  "/.ssh/", "/.aws/", "/.gnupg/",
}

local sensitive_suffixes = {
  "/.bashrc", "/.bash_profile",
  "/.zshrc", "/.zprofile", "/.zshenv",
  "/.netrc", "/.npmrc",
  "/.kube/config",
  "/.docker/config.json",
  "/.config/gh/hosts.yml",
}

local sensitive_extensions = {
  "%.pem$", "%.key$",
}

local function is_env_file(path)
  local basename = path:match("[^/]+$") or ""
  if basename:match("%.env$") then return true end
  if basename:match("%.env%.") and not basename:match("%.env%.example$") then return true end
  return false
end

local function is_sensitive(path)
  if is_env_file(path) then return true end

  for _, dir in ipairs(sensitive_dirs) do
    if path:find(dir, 1, true) then return true end
  end

  for _, suffix in ipairs(sensitive_suffixes) do
    if path:sub(-#suffix) == suffix then return true end
  end

  for _, pattern in ipairs(sensitive_extensions) do
    if path:match(pattern) then return true end
  end

  return false
end

-- Check resolved paths from the binary
for _, path in ipairs(request.paths) do
  if is_sensitive(path) then return "uncertain" end
end

-- Belt-and-suspenders: scan bash command string for patterns the
-- path extractor might miss (redirections, variable interpolation)
if request.tool_name == "Bash" then
  local cmd = request.tool_input.command or ""
  local markers = {
    ".env", ".pem", ".key",
    "/.ssh/", "/.aws/", "/.gnupg/",
    "/.bashrc", "/.zshrc", "/.zprofile", "/.zshenv",
    "/.bash_profile", "/.netrc", "/.npmrc",
    "/.kube/config", "/.docker/config.json",
  }
  for _, marker in ipairs(markers) do
    if cmd:find(marker, 1, true) then return "uncertain" end
  end
end

return "approved"
