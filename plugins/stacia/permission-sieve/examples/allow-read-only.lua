-- Auto-approves read-only tools that never modify the filesystem.

local tool = request.tool_name

if tool == "Read" or tool == "Grep" or tool == "Glob" or tool == "LS" then
  return "approved"
end

return "pass"
