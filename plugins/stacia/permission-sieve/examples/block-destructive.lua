-- Denies destructive commands with an instruction suggesting a safer alternative.

local cmd = request.tool_input and request.tool_input.command or ""

if request.tool_name ~= "Bash" then
  return "skip"
end

if string.find(cmd, "rm %-rf") then
  return "denied", "rm -rf blocked", "Delete specific files by name instead of using rm -rf"
end

if string.find(cmd, "git clean") then
  return "denied", "git clean blocked", "Use git stash -u to preserve untracked files, or remove files individually"
end

if string.find(cmd, "git reset %-%-hard") then
  return "denied", "git reset --hard blocked", "Use git stash to save changes before resetting, or use git reset without --hard"
end

if string.find(cmd, "git push %-%-force") or string.find(cmd, "git push .* %-f") then
  return "denied", "force push blocked", "Use --force-with-lease for safer force pushes"
end

return "skip"
