use std::io::Read as _;
use std::path::PathBuf;
use std::{env, fs, process};

mod config;
mod log;
mod response;
mod sieve;
mod summarizer;

use config::SieveConfig;
use log::{DecisionRecord, ScriptRun, append_log, now_utc, tool_input_summary};
use response::{allow_response, deny_response, uncertain_response};
use sieve::{Outcome, Resolution, create_lua, resolve, run_script, set_request};

fn die(msg: &str) -> ! {
    eprintln!("{msg}");
    process::exit(2);
}

fn config_dir() -> PathBuf {
    let home = env::var("HOME").unwrap_or_else(|_| die("HOME not set"));
    PathBuf::from(home)
        .join(".cache")
        .join("stacia-permission-sieve")
}

fn bootstrap_config(dir: &PathBuf, config_path: &PathBuf) {
    if let Err(e) = fs::create_dir_all(dir) {
        die(&format!(
            "Failed to create config directory {}: {e}",
            dir.display()
        ));
    }
    match fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(config_path)
    {
        Ok(mut f) => {
            use std::io::Write;
            let _ = writeln!(f, "# Permission Sieve configuration\n\nscripts: []");
        }
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(e) => die(&format!("Failed to write {}: {e}", config_path.display())),
    }
}

fn outcomes_to_script_runs(outcomes: &[Outcome], scripts: &[&config::ScriptEntry]) -> Vec<ScriptRun> {
    outcomes
        .iter()
        .zip(scripts.iter())
        .map(|(outcome, entry)| {
            let (outcome_str, reason, instruction) = match outcome {
                Outcome::Approved => ("approved", None, None),
                Outcome::Pass => ("pass", None, None),
                Outcome::Denied { reason, instruction } => {
                    ("denied", reason.clone(), instruction.clone())
                }
                Outcome::Error(msg) => ("error", Some(msg.clone()), None),
            };
            ScriptRun {
                name: entry.path.clone(),
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
    let config_path = dir.join("sieve.yaml");
    let log_path = dir.join("decisions.jsonl");
    bootstrap_config(&dir, &config_path);

    let config = match SieveConfig::load(&config_path) {
        Ok(c) => c,
        Err(e) => die(&e),
    };

    let input_summary = tool_input_summary(&tool_input);
    let scripts = config.scripts();

    if scripts.is_empty() {
        let summary = summarizer::summarize(tool_name, &tool_input, config.summarizer_model());
        let record = DecisionRecord {
            ts: now_utc(),
            session_id: session_id.clone(),
            agent_type: agent_type.clone(),
            tool_name: tool_name.to_string(),
            tool_input_summary: input_summary,
            scripts_run: vec![],
            resolution: "uncertain".to_string(),
            error_detail: None,
            summarizer_output: Some(summary.clone()),
            user_decision: None,
            disposition: "asked".to_string(),
        };
        append_log(&log_path, &record);
        println!("{}", serde_json::to_string(&uncertain_response(&summary)).unwrap());
        return;
    }

    let mut outcomes = Vec::with_capacity(scripts.len());
    for entry in &scripts {
        let lua = create_lua();
        set_request(&lua, &event);
        let outcome = run_script(&lua, entry, &dir);
        let short_circuit = matches!(outcome, Outcome::Error(_) | Outcome::Denied { .. });
        outcomes.push(outcome);
        if short_circuit {
            break;
        }
    }

    let resolution = resolve(&outcomes);
    let script_runs = outcomes_to_script_runs(&outcomes, &scripts);

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
            let summary =
                summarizer::summarize(tool_name, &tool_input, config.summarizer_model());
            (
                "uncertain",
                None,
                Some(summary.clone()),
                "asked",
                Some(uncertain_response(&summary)),
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
            // Resolution::Error — error_detail was set above
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
        let config_path = dir.path().join("sieve.yaml");
        std::fs::write(&config_path, "scripts: []\n").unwrap();

        let input = serde_json::json!({
            "tool_name": "Bash",
            "tool_input": {"command": "ls -la"},
            "session_id": "test",
            "hook_event_name": "PreToolUse"
        });
        let input_str = serde_json::to_string(&input).unwrap();

        let _ = SieveConfig::load(&config_path);
        let _: serde_json::Value = serde_json::from_str(&input_str).unwrap();
        let _ = create_lua();

        let start = Instant::now();
        for _ in 0..100 {
            let event: serde_json::Value = serde_json::from_str(&input_str).unwrap();
            let _tool_name = event.get("tool_name").and_then(|v| v.as_str()).unwrap();
            let _tool_input = event.get("tool_input").unwrap();
            let _config = SieveConfig::load(&config_path).unwrap();
            let lua = create_lua();
            set_request(&lua, &event);
        }
        let elapsed = start.elapsed();
        let per_iter = elapsed / 100;

        assert!(
            per_iter.as_micros() < 1000,
            "Startup SLA violated: {per_iter:?} per iteration (max 1000µs)"
        );
    }
}
