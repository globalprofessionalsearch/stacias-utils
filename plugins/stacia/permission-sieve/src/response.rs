use serde::Serialize;

#[derive(Serialize)]
pub struct HookResponse {
    #[serde(rename = "hookSpecificOutput")]
    pub hook_specific_output: HookSpecificOutput,
}

#[derive(Serialize)]
pub struct HookSpecificOutput {
    #[serde(rename = "hookEventName")]
    pub hook_event_name: String,
    #[serde(rename = "permissionDecision")]
    pub permission_decision: String,
    #[serde(rename = "permissionDecisionReason")]
    pub permission_decision_reason: String,
    #[serde(rename = "systemMessage", skip_serializing_if = "String::is_empty")]
    pub system_message: String,
}

fn hook_response(decision: &str, reason: &str, message: &str) -> HookResponse {
    HookResponse {
        hook_specific_output: HookSpecificOutput {
            hook_event_name: "PreToolUse".into(),
            permission_decision: decision.into(),
            permission_decision_reason: reason.into(),
            system_message: message.into(),
        },
    }
}

pub fn allow_response() -> HookResponse {
    hook_response("allow", "", "")
}

pub fn deny_response(reason: &str, instruction: Option<&str>) -> HookResponse {
    let decision_reason = instruction.unwrap_or(reason);
    hook_response("deny", decision_reason, "")
}

pub fn uncertain_response(summary: &str) -> HookResponse {
    hook_response("ask", summary, "")
}
