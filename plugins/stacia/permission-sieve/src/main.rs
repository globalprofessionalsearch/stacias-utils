use std::io::Read as _;
use std::path::PathBuf;
use std::{env, fs, process};

mod config;
mod response;
mod sieve;
mod summarizer;

use config::SieveConfig;
use response::{allow_response, deny_response, uncertain_response};
use sieve::{Resolution, create_lua, resolve, run_script, set_request};

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

    let dir = config_dir();
    let config_path = dir.join("sieve.yaml");
    bootstrap_config(&dir, &config_path);

    let config = match SieveConfig::load(&config_path) {
        Ok(c) => c,
        Err(e) => die(&e),
    };

    let scripts = config.scripts();

    if scripts.is_empty() {
        let summary = summarizer::summarize(tool_name, &tool_input, config.summarizer_model());
        println!("{}", serde_json::to_string(&uncertain_response(&summary)).unwrap());
        return;
    }

    let mut outcomes = Vec::with_capacity(scripts.len());
    for entry in &scripts {
        let lua = create_lua();
        set_request(&lua, &event);
        let outcome = run_script(&lua, entry, &dir);
        let short_circuit = matches!(outcome, sieve::Outcome::Error(_) | sieve::Outcome::Denied { .. });
        outcomes.push(outcome);
        if short_circuit {
            break;
        }
    }

    let resolution = resolve(&outcomes);

    let response = match resolution {
        Resolution::Allowed => allow_response(),
        Resolution::Denied { reason, instruction } => {
            deny_response(
                reason.as_deref().unwrap_or("denied by sieve"),
                instruction.as_deref(),
            )
        }
        Resolution::Error(msg) => die(&msg),
        Resolution::Uncertain => {
            let summary = summarizer::summarize(tool_name, &tool_input, config.summarizer_model());
            uncertain_response(&summary)
        }
    };

    println!("{}", serde_json::to_string(&response).unwrap());
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

        // Warm up
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
