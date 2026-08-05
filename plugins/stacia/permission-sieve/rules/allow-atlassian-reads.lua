-- Auto-approves read-only Atlassian MCP tools.
-- Mutations, fetch, and unknown future tools fall through as uncertain
-- so guard-unknown-tools never sees this namespace.

local prefix = "mcp__plugin_atlassian_atlassian__"

if request.tool_name:sub(1, #prefix) ~= prefix then
  return "skip"
end

local tool = request.tool_name:sub(#prefix + 1)

local readonly = {
  atlassianUserInfo = true,
  getAccessibleAtlassianResources = true,
  getCompassComponent = true,
  getCompassComponents = true,
  getCompassCustomFieldDefinitions = true,
  getConfluenceCommentChildren = true,
  getConfluencePage = true,
  getConfluencePageDescendants = true,
  getConfluencePageFooterComments = true,
  getConfluencePageInlineComments = true,
  getConfluenceSpaces = true,
  getIssueLinkTypes = true,
  getJiraIssue = true,
  getJiraIssueRemoteIssueLinks = true,
  getJiraIssueTypeMetaWithFields = true,
  getJiraProjectIssueTypesMetadata = true,
  getPagesInConfluenceSpace = true,
  getTeamworkGraphContext = true,
  getTeamworkGraphObject = true,
  getTransitionsForJiraIssue = true,
  getVisibleJiraProjects = true,
  lookupJiraAccountId = true,
  search = true,
  searchConfluenceUsingCql = true,
  searchJiraIssuesUsingJql = true,
}

if readonly[tool] then
  return "approved"
end

return "uncertain"
