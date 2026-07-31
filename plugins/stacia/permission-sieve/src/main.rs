use std::io::Read as _;
use std::path::PathBuf;
use std::{env, process};

mod config;
mod log;
mod paths;
mod response;
mod sieve;
mod summarizer;

use config::{RuleEntry, discover_rules, summarizer_model};
use log::{DecisionRecord, ScriptRun, append_log, now_utc, tool_input_summary};
use response::{allow_response, deny_response, uncertain_response};
use sieve::{Outcome, Resolution, create_lua, resolve, run_script, set_request};

fn die(msg: &str) -> ! {
    eprintln!("{msg}");
    process::exit(2);
}

fn config_dir() -> PathBuf {
    if let Some(dir) = env::args().nth(1) {
        return PathBuf::from(dir);
    }
    let home = env::var("HOME").unwrap_or_else(|_| die("HOME not set"));
    PathBuf::from(home)
        .join(".cache")
        .join("stacia-permission-sieve")
}

fn outcomes_to_runs(outcomes: &[Outcome], rules: &[RuleEntry]) -> Vec<ScriptRun> {
    outcomes
        .iter()
        .zip(rules.iter())
        .map(|(outcome, entry)| {
            let name = entry.path.file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_else(|| entry.path.display().to_string());
            let (outcome_str, reason, instruction) = match outcome {
                Outcome::Approved => ("approved", None, None),
                Outcome::Uncertain => ("uncertain", None, None),
                Outcome::Skip => ("skip", None, None),
                Outcome::Denied { reason, instruction } => {
                    ("denied", reason.clone(), instruction.clone())
                }
                Outcome::Error(msg) => ("error", Some(msg.clone()), None),
            };
            ScriptRun {
                name,
                outcome: outcome_str.to_string(),
                reason,
                instruction,
            }
        })
        .collect()
}

fn main() {
    let mut input = String::new();
    if let Err(e) = std::io::stdin().read_to_string(&mut input) {
        die(&format!("Failed to read stdin: {e}"));
    }

    let event: serde_json::Value = match serde_json::from_str(&input) {
        Ok(v) => v,
        Err(e) => die(&format!("Failed to parse hook input: {e}")),
    };

    let tool_name = event
        .get("tool_name")
        .and_then(|v| v.as_str())
        .unwrap_or("unknown");
    let tool_input = event
        .get("tool_input")
        .cloned()
        .unwrap_or_else(|| serde_json::json!({}));
    let session_id = event
        .get("session_id")
        .and_then(|v| v.as_str())
        .map(String::from);
    let agent_type = event
        .get("agent_type")
        .and_then(|v| v.as_str())
        .map(String::from);

    let dir = config_dir();
    let log_path = dir.join("decisions.jsonl");
    let rules = discover_rules(&dir);

    let input_summary = tool_input_summary(&tool_input);

    if rules.is_empty() {
        let (summary, error) = match summarizer::summarize(tool_name, &tool_input, summarizer_model()) {
            Ok(s) => (Some(s), None),
            Err(e) => {
                eprintln!("Warning: summarizer unavailable: {e}");
                (None, Some(e))
            }
        };
        let record = DecisionRecord {
            ts: now_utc(),
            session_id: session_id.clone(),
            agent_type: agent_type.clone(),
            tool_name: tool_name.to_string(),
            tool_input_summary: input_summary,
            scripts_run: vec![],
            resolution: "uncertain".to_string(),
            error_detail: error,
            summarizer_output: summary.clone(),
            user_decision: None,
            disposition: "asked".to_string(),
        };
        append_log(&log_path, &record);
        let message = summary.unwrap_or_else(|| format!("Permission sieve: summarizer unavailable ({})", record.error_detail.as_deref().unwrap_or("unknown error")));
        println!("{}", serde_json::to_string(&uncertain_response(&message)).unwrap());
        return;
    }

    let paths = paths::extract_paths(tool_name, &tool_input);

    let mut outcomes = Vec::with_capacity(rules.len());
    for entry in &rules {
        let lua = create_lua();
        set_request(&lua, &event, &paths);
        let outcome = run_script(&lua, entry);
        let short_circuit = matches!(outcome, Outcome::Error(_) | Outcome::Denied { .. });
        outcomes.push(outcome);
        if short_circuit {
            break;
        }
    }

    let resolution = resolve(&outcomes);
    let script_runs = outcomes_to_runs(&outcomes, &rules);

    let (resolution_str, error_detail, summarizer_output, disposition, response) = match resolution
    {
        Resolution::Allowed => (
            "approved",
            None,
            None,
            "allowed",
            Some(allow_response()),
        ),
        Resolution::Denied {
            reason,
            instruction,
        } => (
            "denied",
            None,
            None,
            "blocked",
            Some(deny_response(
                reason.as_deref().unwrap_or("denied by sieve"),
                instruction.as_deref(),
            )),
        ),
        Resolution::Error(ref msg) => {
            let error_msg = msg.clone();
            ("error", Some(error_msg.clone()), None, "error", None)
        }
        Resolution::Uncertain => {
            let (summary, err) = match summarizer::summarize(tool_name, &tool_input, summarizer_model()) {
                Ok(s) => (Some(s), None),
                Err(e) => {
                    eprintln!("Warning: summarizer unavailable: {e}");
                    (None, Some(e))
                }
            };
            let message = summary.clone().unwrap_or_else(|| format!("Permission sieve: summarizer unavailable ({})", err.as_deref().unwrap_or("unknown error")));
            (
                "uncertain",
                err,
                summary,
                "asked",
                Some(uncertain_response(&message)),
            )
        }
    };

    let record = DecisionRecord {
        ts: now_utc(),
        session_id,
        agent_type,
        tool_name: tool_name.to_string(),
        tool_input_summary: input_summary,
        scripts_run: script_runs,
        resolution: resolution_str.to_string(),
        error_detail,
        summarizer_output,
        user_decision: None,
        disposition: disposition.to_string(),
    };
    append_log(&log_path, &record);

    match response {
        Some(resp) => println!("{}", serde_json::to_string(&resp).unwrap()),
        None => {
            let msg = record.error_detail.as_deref().unwrap_or("unknown error");
            die(msg);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Instant;

    #[test]
    fn startup_sla_under_1000us() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("rules")).unwrap();

        let input = serde_json::json!({
            "tool_name": "Bash",
            "tool_input": {"command": "ls -la"},
            "session_id": "test",
            "hook_event_name": "PreToolUse"
        });
        let input_str = serde_json::to_string(&input).unwrap();

        let _ = discover_rules(dir.path());
        let _: serde_json::Value = serde_json::from_str(&input_str).unwrap();
        let _ = create_lua();

        let start = Instant::now();
        for _ in 0..100 {
            let event: serde_json::Value = serde_json::from_str(&input_str).unwrap();
            let _tool_name = event.get("tool_name").and_then(|v| v.as_str()).unwrap();
            let _tool_input = event.get("tool_input").unwrap();
            let _ = discover_rules(dir.path());
            let lua = create_lua();
            set_request(&lua, &event, &[]);
        }
        let elapsed = start.elapsed();
        let per_iter = elapsed / 100;

        assert!(
            per_iter.as_micros() < 1000,
            "Startup SLA violated: {per_iter:?} per iteration (max 1000µs)"
        );
    }
}
