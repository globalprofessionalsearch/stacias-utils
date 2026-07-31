-- Auto-approves read-only and safe non-Bash tools.
-- Returns "uncertain" for tools not covered by any allow script.

local safe = {
  Read = true,
  Grep = true,
  Glob = true,
  LS = true,
  WebSearch = true,
  WebFetch = true,
  AskUserQuestion = true,
  Skill = true,
  ToolSearch = true,
  SendMessage = true,
  TaskGet = true,
  TaskList = true,
  ReportFindings = true,
}

if safe[request.tool_name] then
  return "approved"
end

local handled_elsewhere = {
  Bash = true,
  Write = true,
  Edit = true,
  NotebookEdit = true,
}

if handled_elsewhere[request.tool_name] then
  return "skip"
end

return "uncertain"
