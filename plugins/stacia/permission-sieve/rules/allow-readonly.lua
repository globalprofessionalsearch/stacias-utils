-- Auto-approves read-only and safe non-Bash tools.

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
  TaskCreate = true,
  TaskUpdate = true,
  TaskGet = true,
  TaskList = true,
  TaskOutput = true,
  TaskStop = true,
  ReportFindings = true,
  EnterPlanMode = true,
  ExitPlanMode = true,
  EnterWorktree = true,
  ExitWorktree = true,
  Monitor = true,
}

if safe[request.tool_name] then
  return "approved"
end

return "skip"
