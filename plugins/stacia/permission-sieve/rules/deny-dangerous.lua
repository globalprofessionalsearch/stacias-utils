-- Hard denials for destructive or forbidden commands.
-- These short-circuit the sieve — no other script runs after a deny.

if request.tool_name ~= "Bash" then return "skip" end

local cmd = request.tool_input.command or ""

local function has_word(s, word)
  return s:find(" " .. word .. " ", 1, true) or s:sub(-#word - 1) == " " .. word
end

-- Force push (but not --force-with-lease)
if cmd:match("^git%s+push") then
  local has_force = has_word(cmd, "--force") or has_word(cmd, "-f")
  local has_lease = cmd:find("--force-with-lease", 1, true)
  if has_force and not has_lease then
    return "denied", "Force push is destructive", "Use git push or git push --force-with-lease"
  end
  if has_word(cmd, "main") or has_word(cmd, "master") then
    return "denied", "Direct push to a protected branch is forbidden", "Push to a feature branch and open a PR"
  end
end

-- gh pr merge
if cmd:match("^gh%s+pr%s+merge") then
  return "denied", "Use the GitHub UI to merge PRs"
end

-- terraform / tf (use tofu)
if cmd:match("^terraform[%s]") or cmd == "terraform"
   or cmd:match("^tf[%s]") or cmd == "tf" then
  return "denied", "Use tofu instead of terraform"
end

return "skip"
