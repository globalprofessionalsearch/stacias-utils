-- Guards subagent model selection.
-- Denies expensive models outright. Acceptable models (sonnet-4-6, haiku)
-- return "uncertain" so the user is still prompted to approve the spawn.

if request.tool_name == "Workflow" then
  return "uncertain"
end

if request.tool_name ~= "Agent" then return "skip" end

local model = request.tool_input.model

if model == nil then
  return "denied", "Subagent must specify a model", "Always set model to sonnet or haiku when spawning a subagent"
end

if model:find("haiku") then
  return "uncertain"
end

if model:find("sonnet%-4%-6") or model:find("sonnet_4_6") then
  return "uncertain"
end

return "denied", model .. " is not allowed for subagents", "Use model sonnet (Sonnet 4.6) or haiku for subagents"
