-- Guards subagent model selection.
-- Only sonnet-class models are accepted for subagents.
-- Workflows always prompt.

if request.tool_name == "Workflow" then
  return "uncertain"
end

if request.tool_name ~= "Agent" then return "skip" end

if request.tool_input.subagent_type == "fork" then
  return "denied",
    "Forks inherit the parent model and bypass model restrictions",
    "Use a fresh agent (omit subagent_type or use a named type) with model set to \"sonnet\". Include all necessary context in the prompt rather than relying on inherited conversation context."
end

local model = request.tool_input.model

if model == nil then
  return "denied", "Subagent must specify a model", "Set model to \"sonnet\" when spawning a subagent"
end

if model:find("sonnet") then
  return "uncertain"
end

return "denied", model .. " is not allowed for subagents", "Set model to \"sonnet\" when spawning a subagent"
