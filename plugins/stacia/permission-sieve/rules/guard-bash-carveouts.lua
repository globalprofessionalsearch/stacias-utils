-- Returns "uncertain" for bash commands that need human review
-- even though their broader category (rm, git, summon) is allowed.
-- Scans the full command string so compound commands are caught.

if request.tool_name ~= "Bash" then return "skip" end

local cmd = request.tool_input.command or ""

if cmd:find("rm %-rf", 1, false) or cmd:find("rm %-fr", 1, false) then return "uncertain" end
if cmd:find("git push", 1, true) then return "uncertain" end
if cmd:find("gh pr create", 1, true) then return "uncertain" end
if cmd:find("summon ctx prod", 1, true) then return "uncertain" end

local always_ask = {
  "xargs", "curl", "chmod", "chown", "pkill", "kill", "nohup",
  "yq", "env",
}
for _, c in ipairs(always_ask) do
  if cmd == c or cmd:sub(1, #c + 1) == c .. " " then return "uncertain" end
end

return "skip"
