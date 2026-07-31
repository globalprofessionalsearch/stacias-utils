-- Returns "uncertain" (-> ask) when a mutating tool accesses paths
-- outside allowed directories. Read-only tools are not guarded.
-- Edit HOME below for your system.

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
}

local function is_allowed(path)
  for _, prefix in ipairs(allowed_prefixes) do
    if path:sub(1, #prefix) == prefix then return true end
  end
  return false
end

-- If no paths in the request, this guard doesn't apply
if #request.paths == 0 then return "approved" end

for _, path in ipairs(request.paths) do
  if not is_allowed(path) then return "uncertain" end
end

return "approved"
