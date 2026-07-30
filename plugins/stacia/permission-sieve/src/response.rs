use serde::Serialize;

#[derive(Serialize)]
pub struct HookResponse {
    #[serde(rename = "hookSpecificOutput")]
    pub hook_specific_output: HookSpecificOutput,
    #[serde(rename = "systemMessage")]
    pub system_message: String,
}

#[derive(Serialize)]
pub struct HookSpecificOutput {
    #[serde(rename = "hookEventName")]
    pub hook_event_name: String,
    #[serde(rename = "permissionDecision")]
    pub permission_decision: String,
    #[serde(rename = "permissionDecisionReason")]
    pub permission_decision_reason: String,
}

pub fn uncertain_response(summary: &str) -> HookResponse {
    HookResponse {
        hook_specific_output: HookSpecificOutput {
            hook_event_name: "PreToolUse".into(),
            permission_decision: "ask".into(),
            permission_decision_reason: String::new(),
        },
        system_message: summary.to_string(),
    }
}
