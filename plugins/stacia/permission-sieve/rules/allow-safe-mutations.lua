-- Auto-approves Write and Edit when all paths are within allowed directories.
-- Run AFTER guard-sensitive-paths so sensitive files still trigger "ask".

local HOME = "/Users/joe"

local mutating_tools = {
  Write = true,
  Edit = true,
  NotebookEdit = true,
}

if not mutating_tools[request.tool_name] then return "skip" end

local allowed_prefixes = {
  HOME .. "/Documents/code/",
  HOME .. "/.cache/",
  HOME .. "/.claude/plans/",
}

local function is_allowed(path)
  for _, prefix in ipairs(allowed_prefixes) do
    if path:sub(1, #prefix) == prefix then return true end
  end
  return false
end

if #request.paths == 0 then return "uncertain" end

for _, path in ipairs(request.paths) do
  if not is_allowed(path) then return "uncertain" end
end

return "approved"
