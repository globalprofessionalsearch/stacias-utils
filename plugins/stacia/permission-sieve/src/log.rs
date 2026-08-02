use std::fs::OpenOptions;
use std::io::Write;
use std::path::Path;

use serde::Serialize;

#[derive(Debug, Serialize)]
pub struct ScriptRun {
    pub name: String,
    pub outcome: String,
    pub reason: Option<String>,
    pub instruction: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct DecisionRecord {
    pub build: &'static str,
    pub ts: String,
    pub session_id: Option<String>,
    pub agent_type: Option<String>,
    pub tool_name: String,
    pub tool_input_summary: String,
    pub scripts_run: Vec<ScriptRun>,
    pub resolution: String,
    pub error_detail: Option<String>,
    pub summarizer_output: Option<String>,
    pub user_decision: Option<String>,
    pub disposition: String,
}

pub fn now_utc() -> String {
    let output = std::process::Command::new("date")
        .args(["-u", "+%Y-%m-%dT%H:%M:%SZ"])
        .output();
    match output {
        Ok(o) if o.status.success() => String::from_utf8_lossy(&o.stdout).trim().to_string(),
        _ => "1970-01-01T00:00:00Z".to_string(),
    }
}

pub fn append_log(log_path: &Path, record: &DecisionRecord) {
    let line = match serde_json::to_string(record) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("Warning: failed to serialize decision record: {e}");
            return;
        }
    };

    let result = OpenOptions::new()
        .create(true)
        .append(true)
        .open(log_path)
        .and_then(|mut f| writeln!(f, "{line}"));

    if let Err(e) = result {
        eprintln!("Warning: failed to write decision log {}: {e}", log_path.display());
    }
}

pub fn tool_input_summary(tool_input: &serde_json::Value) -> String {
    let full = serde_json::to_string(tool_input).unwrap_or_default();
    if full.len() > 200 {
        let truncated = &full[..full.floor_char_boundary(200)];
        format!("{truncated}...")
    } else {
        full
    }
}
