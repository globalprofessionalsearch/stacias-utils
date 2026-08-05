-- Returns "uncertain" for tools not covered by any rule.
-- This is the single place that enumerates known tool types.
-- Add new tools here when a rule is written to handle them.

-- Atlassian MCP tools are owned by allow-atlassian-reads.lua; skip here so
-- that script's approved signals are not poisoned by uncertain from this one.
local atlassian_prefix = "mcp__plugin_atlassian_atlassian__"
if request.tool_name:sub(1, #atlassian_prefix) == atlassian_prefix then
  return "skip"
end

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
  EnterPlanMode = true,
  ExitPlanMode = true,
  EnterWorktree = true,
  ExitWorktree = true,
  Monitor = true,
  StructuredOutput = true,
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
