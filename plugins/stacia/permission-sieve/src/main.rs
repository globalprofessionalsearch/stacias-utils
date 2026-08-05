use std::io::Read as _;
use std::path::PathBuf;
use std::{env, process};

mod config;
mod log;
mod paths;
mod response;
mod shell;
mod sieve;
mod summarizer;

use config::{RuleEntry, discover_rules, load_config};
use log::{DecisionRecord, ScriptRun, SegmentRecord, append_log, now_utc, tool_input_summary};
use response::{allow_response, deny_response, uncertain_response};
use shell::split_on_shell_operators;
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

fn resolution_str(resolution: &Resolution) -> &'static str {
    match resolution {
        Resolution::Allowed => "approved",
        Resolution::Denied { .. } => "denied",
        Resolution::Error(_) => "error",
        Resolution::Uncertain => "uncertain",
    }
}

struct SegmentResult {
    command: String,
    resolution: Resolution,
    outcomes: Vec<Outcome>,
}

fn evaluate_single(
    event: &serde_json::Value,
    rules: &[RuleEntry],
) -> (Vec<Outcome>, Resolution) {
    let tool_name = event
        .get("tool_name")
        .and_then(|v| v.as_str())
        .unwrap_or("unknown");
    let tool_input = event
        .get("tool_input")
        .cloned()
        .unwrap_or_else(|| serde_json::json!({}));

    let extracted_paths = paths::extract_paths(tool_name, &tool_input);

    let mut outcomes = Vec::with_capacity(rules.len());
    for entry in rules {
        let lua = create_lua();
        set_request(&lua, event, &extracted_paths);
        let outcome = run_script(&lua, entry);
        let short_circuit = matches!(outcome, Outcome::Error(_) | Outcome::Denied { .. });
        outcomes.push(outcome);
        if short_circuit {
            break;
        }
    }

    let resolution = resolve(&outcomes);
    (outcomes, resolution)
}

fn evaluate_compound(
    event: &serde_json::Value,
    segments: &[String],
    rules: &[RuleEntry],
) -> Vec<SegmentResult> {
    segments
        .iter()
        .map(|seg| {
            let mut seg_event = event.clone();
            if let Some(obj) = seg_event.as_object_mut() {
                let mut input = obj
                    .get("tool_input")
                    .cloned()
                    .unwrap_or_else(|| serde_json::json!({}));
                if let Some(input_obj) = input.as_object_mut() {
                    input_obj.insert("command".to_string(), serde_json::json!(seg));
                }
                obj.insert("tool_input".to_string(), input);
            }
            let (outcomes, resolution) = evaluate_single(&seg_event, rules);
            SegmentResult {
                command: seg.clone(),
                resolution,
                outcomes,
            }
        })
        .collect()
}

fn aggregate_resolutions(segment_results: &[SegmentResult]) -> Resolution {
    for result in segment_results {
        match &result.resolution {
            Resolution::Error(msg) => return Resolution::Error(msg.clone()),
            Resolution::Denied { reason, instruction } => {
                return Resolution::Denied {
                    reason: reason.clone(),
                    instruction: instruction.clone(),
                };
            }
            _ => {}
        }
    }

    let all_approved = segment_results
        .iter()
        .all(|r| matches!(r.resolution, Resolution::Allowed));

    if all_approved {
        Resolution::Allowed
    } else {
        Resolution::Uncertain
    }
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
    let config = load_config(&dir);
    let summarizer_cfg = config.summarizer;

    let input_summary = tool_input_summary(&tool_input);

    if rules.is_empty() {
        let (summary, error) = match summarizer::summarize(tool_name, &tool_input, &summarizer_cfg) {
            Ok(s) => (Some(s), None),
            Err(e) => {
                eprintln!("Warning: summarizer unavailable: {e}");
                (None, Some(e))
            }
        };
        let record = DecisionRecord {
            build: env!("SIEVE_BUILD_HASH"),
            build_ts: env!("SIEVE_BUILD_TS"),
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
            segments: vec![],
        };
        append_log(&log_path, &record);
        let message = summary.unwrap_or_else(|| format!("Permission sieve: summarizer unavailable ({})", record.error_detail.as_deref().unwrap_or("unknown error")));
        println!("{}", serde_json::to_string(&uncertain_response(&message)).unwrap());
        return;
    }

    // Compound command splitting for Bash tools
    let is_bash = tool_name == "Bash";
    let bash_segments: Vec<String> = if is_bash {
        let cmd = tool_input
            .get("command")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        split_on_shell_operators(cmd)
    } else {
        vec![]
    };
    let is_compound = is_bash && bash_segments.len() > 1;

    let (resolution, script_runs, segment_records) = if is_compound {
        let segment_results = evaluate_compound(&event, &bash_segments, &rules);
        let aggregate = aggregate_resolutions(&segment_results);

        let seg_records: Vec<SegmentRecord> = segment_results
            .iter()
            .map(|sr| SegmentRecord {
                command: sr.command.clone(),
                scripts_run: outcomes_to_runs(&sr.outcomes, &rules),
                resolution: resolution_str(&sr.resolution).to_string(),
            })
            .collect();

        // Aggregate script_runs: flatten all segment runs for the top-level record
        let all_runs: Vec<ScriptRun> = segment_results
            .iter()
            .flat_map(|sr| outcomes_to_runs(&sr.outcomes, &rules))
            .collect();

        (aggregate, all_runs, seg_records)
    } else {
        let (outcomes, resolution) = evaluate_single(&event, &rules);
        let script_runs = outcomes_to_runs(&outcomes, &rules);
        (resolution, script_runs, vec![])
    };

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
            let (summary, err) = match summarizer::summarize(tool_name, &tool_input, &summarizer_cfg) {
                Ok(s) => {
                    eprintln!("[sieve] {tool_name}: {s}");
                    (Some(s), None)
                }
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
        build: env!("SIEVE_BUILD_HASH"),
        build_ts: env!("SIEVE_BUILD_TS"),
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
        segments: segment_records,
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

    #[test]
    fn aggregate_all_approved() {
        let results = vec![
            SegmentResult {
                command: "ls".into(),
                resolution: Resolution::Allowed,
                outcomes: vec![Outcome::Approved],
            },
            SegmentResult {
                command: "pwd".into(),
                resolution: Resolution::Allowed,
                outcomes: vec![Outcome::Approved],
            },
        ];
        assert!(matches!(aggregate_resolutions(&results), Resolution::Allowed));
    }

    #[test]
    fn aggregate_one_denied() {
        let results = vec![
            SegmentResult {
                command: "ls".into(),
                resolution: Resolution::Allowed,
                outcomes: vec![Outcome::Approved],
            },
            SegmentResult {
                command: "terraform plan".into(),
                resolution: Resolution::Denied {
                    reason: Some("use tofu".into()),
                    instruction: None,
                },
                outcomes: vec![],
            },
        ];
        assert!(matches!(aggregate_resolutions(&results), Resolution::Denied { .. }));
    }

    #[test]
    fn aggregate_one_uncertain() {
        let results = vec![
            SegmentResult {
                command: "ls".into(),
                resolution: Resolution::Allowed,
                outcomes: vec![Outcome::Approved],
            },
            SegmentResult {
                command: "unknown-cmd".into(),
                resolution: Resolution::Uncertain,
                outcomes: vec![Outcome::Uncertain],
            },
        ];
        assert!(matches!(aggregate_resolutions(&results), Resolution::Uncertain));
    }

    #[test]
    fn aggregate_error_wins() {
        let results = vec![
            SegmentResult {
                command: "ls".into(),
                resolution: Resolution::Allowed,
                outcomes: vec![Outcome::Approved],
            },
            SegmentResult {
                command: "bad".into(),
                resolution: Resolution::Error("broken".into()),
                outcomes: vec![],
            },
        ];
        assert!(matches!(aggregate_resolutions(&results), Resolution::Error(_)));
    }
}
