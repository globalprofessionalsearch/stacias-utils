-- Hard denials for destructive or forbidden commands.
-- These short-circuit the sieve — no other script runs after a deny.

if request.tool_name ~= "Bash" then return "skip" end

local cmd = request.tool_input.command or ""

-- Force push (but not --force-with-lease)
if cmd:match("git%s+push") then
  local has_force = cmd:match("%s%-%-force%s") or cmd:match("%s%-%-force$")
                 or cmd:match("%s%-f%s") or cmd:match("%s%-f$")
  local has_lease = cmd:match("%-%-force%-with%-lease")
  if has_force and not has_lease then
    return "denied", "Force push is destructive", "Use git push or git push --force-with-lease"
  end
end

-- gh pr merge
if cmd:match("gh%s+pr%s+merge") then
  return "denied", "Use the GitHub UI to merge PRs"
end

-- terraform / tf (use tofu)
if cmd:match("^terraform[%s]") or cmd == "terraform"
   or cmd:match("^tf[%s]") or cmd == "tf" then
  return "denied", "Use tofu instead of terraform"
end

return "skip"
