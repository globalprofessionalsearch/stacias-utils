-- Returns "uncertain" for tools not covered by any rule.
-- This is the single place that enumerates known tool types.
-- Add new tools here when a rule is written to handle them.

local known = {
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
  TaskCreate = true,
  TaskUpdate = true,
  TaskGet = true,
  TaskList = true,
  TaskOutput = true,
  TaskStop = true,
  ReportFindings = true,
  Bash = true,
  Write = true,
  Edit = true,
  NotebookEdit = true,
  Agent = true,
  Workflow = true,
}

if known[request.tool_name] then
  return "skip"
end

return "uncertain"
