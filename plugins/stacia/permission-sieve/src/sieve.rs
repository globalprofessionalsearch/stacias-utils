use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use mlua::{HookTriggers, Lua, LuaSerdeExt as _, MultiValue, Result as LuaResult, StdLib, Value};

use crate::config::RuleEntry;

#[derive(Debug)]
pub enum Outcome {
    Approved,
    Denied {
        reason: Option<String>,
        instruction: Option<String>,
    },
    Uncertain,
    Skip,
    Error(String),
}

#[derive(Debug)]
pub enum Resolution {
    Allowed,
    Denied {
        reason: Option<String>,
        instruction: Option<String>,
    },
    Error(String),
    Uncertain,
}

pub fn create_lua() -> Lua {
    let libs = StdLib::STRING | StdLib::TABLE | StdLib::MATH;
    let lua = Lua::new_with(libs, mlua::LuaOptions::default()).unwrap_or_else(|e| {
        eprintln!("Failed to create Lua runtime: {e}");
        std::process::exit(2);
    });
    let globals = lua.globals();
    for name in ["loadfile", "dofile", "load", "rawget", "rawset", "collectgarbage", "rawequal", "rawlen"] {
        let _ = globals.set(name, Value::Nil);
    }
    lua
}

pub fn set_request(lua: &Lua, event: &serde_json::Value, paths: &[String]) {
    let globals = lua.globals();
    let table = lua
        .to_value(event)
        .and_then(|v| match v {
            Value::Table(t) => Ok(t),
            _ => Err(mlua::Error::runtime("event is not a table")),
        })
        .unwrap_or_else(|e| {
            eprintln!("Failed to convert event to Lua table: {e}");
            std::process::exit(2);
        });

    // Add paths as a 1-indexed Lua array on the request table
    let paths_table = lua.create_table().unwrap_or_else(|e| {
        eprintln!("Failed to create paths table: {e}");
        std::process::exit(2);
    });
    for (i, path) in paths.iter().enumerate() {
        paths_table.set(i + 1, path.as_str()).unwrap_or_else(|e| {
            eprintln!("Failed to set path entry: {e}");
            std::process::exit(2);
        });
    }
    table.set("paths", paths_table).unwrap_or_else(|e| {
        eprintln!("Failed to set paths on request table: {e}");
        std::process::exit(2);
    });

    let home = std::env::var("HOME").unwrap_or_default();
    table.set("home", home.as_str()).unwrap_or_else(|e| {
        eprintln!("Failed to set home on request table: {e}");
        std::process::exit(2);
    });

    globals.set("request", table).unwrap_or_else(|e| {
        eprintln!("Failed to set request global: {e}");
        std::process::exit(2);
    });
}

fn lua_str_to_string(s: &mlua::String) -> String {
    s.to_string_lossy().to_string()
}

fn parse_return(values: MultiValue) -> Outcome {
    let vals: Vec<Value> = values.into_vec();

    if vals.is_empty() {
        return Outcome::Error("Script returned no values".into());
    }

    let outcome_str = match &vals[0] {
        Value::String(s) => lua_str_to_string(s).to_lowercase(),
        _ => {
            return Outcome::Error(format!(
                "Expected string outcome, got {}",
                vals[0].type_name()
            ))
        }
    };

    match outcome_str.as_str() {
        "approved" => {
            if vals.len() > 1 {
                return Outcome::Error("'approved' takes no additional values".into());
            }
            Outcome::Approved
        }
        "uncertain" => {
            if vals.len() > 1 {
                return Outcome::Error("'uncertain' takes no additional values".into());
            }
            Outcome::Uncertain
        }
        "skip" => {
            if vals.len() > 1 {
                return Outcome::Error("'skip' takes no additional values".into());
            }
            Outcome::Skip
        }
        "error" => {
            if vals.len() < 2 {
                return Outcome::Error("'error' requires a reason string".into());
            }
            match &vals[1] {
                Value::String(s) => Outcome::Error(lua_str_to_string(s)),
                _ => Outcome::Error("'error' reason must be a string".into()),
            }
        }
        "denied" => {
            if vals.len() > 3 {
                return Outcome::Error("'denied' takes at most reason and instruction".into());
            }
            let reason = vals.get(1).and_then(|v| match v {
                Value::String(s) => Some(lua_str_to_string(s)),
                _ => None,
            });
            let instruction = vals.get(2).and_then(|v| match v {
                Value::String(s) => Some(lua_str_to_string(s)),
                _ => None,
            });
            Outcome::Denied {
                reason,
                instruction,
            }
        }
        other => Outcome::Error(format!("Unrecognized outcome: '{other}'")),
    }
}

pub fn run_script(lua: &Lua, entry: &RuleEntry) -> Outcome {
    let source = match std::fs::read_to_string(&entry.path) {
        Ok(s) => s,
        Err(e) => {
            return Outcome::Error(format!(
                "Failed to read rule {}: {e}",
                entry.path.display()
            ))
        }
    };

    let name = entry.path.file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| entry.path.display().to_string());

    let timeout = Duration::from_secs(entry.timeout);
    let start = Instant::now();
    let timed_out = Arc::new(AtomicBool::new(false));
    let timed_out_clone = timed_out.clone();

    lua.set_hook(
        HookTriggers::new().every_nth_instruction(1000),
        move |_lua, _debug| {
            if start.elapsed() > timeout {
                timed_out_clone.store(true, Ordering::Relaxed);
                Err(mlua::Error::runtime("script timeout exceeded"))
            } else {
                Ok(mlua::VmState::Continue)
            }
        },
    );

    let result: LuaResult<MultiValue> = lua.load(&source).set_name(&name).eval();

    lua.remove_hook();

    match result {
        Ok(values) => parse_return(values),
        Err(_) if timed_out.load(Ordering::Relaxed) => {
            Outcome::Error(format!("Rule {} timed out after {}s", name, entry.timeout))
        }
        Err(e) => Outcome::Error(format!("Lua error in {}: {e}", name)),
    }
}

pub fn resolve(outcomes: &[Outcome]) -> Resolution {
    let active: Vec<&Outcome> = outcomes.iter()
        .filter(|o| !matches!(o, Outcome::Skip))
        .collect();
    if active.is_empty() {
        return Resolution::Uncertain;
    }

    let mut all_approved = true;

    for outcome in active {
        match outcome {
            Outcome::Error(msg) => return Resolution::Error(msg.clone()),
            Outcome::Denied {
                reason,
                instruction,
            } => {
                return Resolution::Denied {
                    reason: reason.clone(),
                    instruction: instruction.clone(),
                }
            }
            Outcome::Uncertain => {
                all_approved = false;
            }
            Outcome::Approved => {}
            Outcome::Skip => {}
        }
    }

    if all_approved {
        Resolution::Allowed
    } else {
        Resolution::Uncertain
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_lua() -> Lua {
        create_lua()
    }

    fn test_event() -> serde_json::Value {
        serde_json::json!({
            "tool_name": "Bash",
            "tool_input": {"command": "ls"},
            "session_id": "test"
        })
    }

    // Intentional: evaluates Lua code in the embedded sandbox — this IS the sieve's purpose.
    fn run_lua(lua: &Lua, code: &str) -> Outcome {
        let result: LuaResult<MultiValue> = lua.load(code).eval();
        match result {
            Ok(values) => parse_return(values),
            Err(e) => Outcome::Error(format!("Lua error: {e}")),
        }
    }

    #[test]
    fn approved_return() {
        let lua = test_lua();
        assert!(matches!(run_lua(&lua, r#"return "approved""#), Outcome::Approved));
    }

    #[test]
    fn approved_with_extra_values_is_error() {
        let lua = test_lua();
        match run_lua(&lua, r#"return "approved", "extra""#) {
            Outcome::Error(msg) => assert!(msg.contains("no additional values")),
            other => panic!("Expected Error, got {other:?}"),
        }
    }

    #[test]
    fn uncertain_return() {
        let lua = test_lua();
        assert!(matches!(run_lua(&lua, r#"return "uncertain""#), Outcome::Uncertain));
    }

    #[test]
    fn skip_return() {
        let lua = test_lua();
        assert!(matches!(run_lua(&lua, r#"return "skip""#), Outcome::Skip));
    }

    #[test]
    fn pass_is_now_error() {
        let lua = test_lua();
        match run_lua(&lua, r#"return "pass""#) {
            Outcome::Error(msg) => assert!(msg.contains("Unrecognized")),
            other => panic!("Expected Error, got {other:?}"),
        }
    }

    #[test]
    fn denied_no_reason() {
        let lua = test_lua();
        match run_lua(&lua, r#"return "denied""#) {
            Outcome::Denied { reason, instruction } => {
                assert!(reason.is_none());
                assert!(instruction.is_none());
            }
            other => panic!("Expected Denied, got {other:?}"),
        }
    }

    #[test]
    fn denied_with_reason() {
        let lua = test_lua();
        match run_lua(&lua, r#"return "denied", "blocked""#) {
            Outcome::Denied { reason, instruction } => {
                assert_eq!(reason.as_deref(), Some("blocked"));
                assert!(instruction.is_none());
            }
            other => panic!("Expected Denied, got {other:?}"),
        }
    }

    #[test]
    fn denied_with_instruction() {
        let lua = test_lua();
        match run_lua(&lua, r#"return "denied", "blocked", "try X instead""#) {
            Outcome::Denied { reason, instruction } => {
                assert_eq!(reason.as_deref(), Some("blocked"));
                assert_eq!(instruction.as_deref(), Some("try X instead"));
            }
            other => panic!("Expected Denied, got {other:?}"),
        }
    }

    #[test]
    fn error_requires_reason() {
        let lua = test_lua();
        match run_lua(&lua, r#"return "error""#) {
            Outcome::Error(msg) => assert!(msg.contains("requires a reason")),
            other => panic!("Expected Error, got {other:?}"),
        }
    }

    #[test]
    fn error_with_reason() {
        let lua = test_lua();
        match run_lua(&lua, r#"return "error", "something broke""#) {
            Outcome::Error(msg) => assert_eq!(msg, "something broke"),
            other => panic!("Expected Error, got {other:?}"),
        }
    }

    #[test]
    fn unrecognized_outcome() {
        let lua = test_lua();
        match run_lua(&lua, r#"return "maybe""#) {
            Outcome::Error(msg) => assert!(msg.contains("Unrecognized")),
            other => panic!("Expected Error, got {other:?}"),
        }
    }

    #[test]
    fn non_string_return() {
        let lua = test_lua();
        match run_lua(&lua, "return 42") {
            Outcome::Error(msg) => assert!(msg.contains("Expected string")),
            other => panic!("Expected Error, got {other:?}"),
        }
    }

    #[test]
    fn no_return() {
        let lua = test_lua();
        match run_lua(&lua, "-- empty script") {
            Outcome::Error(msg) => assert!(msg.contains("no values")),
            other => panic!("Expected Error, got {other:?}"),
        }
    }

    #[test]
    fn lua_runtime_error() {
        let lua = test_lua();
        match run_lua(&lua, r#"error("boom")"#) {
            Outcome::Error(msg) => assert!(msg.contains("boom")),
            other => panic!("Expected Error, got {other:?}"),
        }
    }

    #[test]
    fn request_table_accessible() {
        let lua = test_lua();
        let event = test_event();
        set_request(&lua, &event, &[]);
        assert!(matches!(
            run_lua(&lua, r#"if request.tool_name == "Bash" then return "approved" else return "error", "wrong tool" end"#),
            Outcome::Approved
        ));
    }

    #[test]
    fn resolve_empty_is_uncertain() {
        assert!(matches!(resolve(&[]), Resolution::Uncertain));
    }

    #[test]
    fn resolve_all_approved() {
        let outcomes = vec![Outcome::Approved, Outcome::Approved];
        assert!(matches!(resolve(&outcomes), Resolution::Allowed));
    }

    #[test]
    fn resolve_mixed_is_uncertain() {
        let outcomes = vec![Outcome::Approved, Outcome::Uncertain];
        assert!(matches!(resolve(&outcomes), Resolution::Uncertain));
    }

    #[test]
    fn resolve_all_uncertain_is_uncertain() {
        let outcomes = vec![Outcome::Uncertain, Outcome::Uncertain];
        assert!(matches!(resolve(&outcomes), Resolution::Uncertain));
    }

    #[test]
    fn resolve_skip_ignored() {
        let outcomes = vec![Outcome::Skip, Outcome::Approved];
        assert!(matches!(resolve(&outcomes), Resolution::Allowed));
    }

    #[test]
    fn resolve_all_skip_is_uncertain() {
        let outcomes = vec![Outcome::Skip, Outcome::Skip];
        assert!(matches!(resolve(&outcomes), Resolution::Uncertain));
    }

    #[test]
    fn resolve_skip_with_uncertain() {
        let outcomes = vec![Outcome::Skip, Outcome::Uncertain, Outcome::Approved];
        assert!(matches!(resolve(&outcomes), Resolution::Uncertain));
    }

    #[test]
    fn sandbox_blocks_os() {
        let lua = test_lua();
        match run_lua(&lua, r#"os.execute("ls"); return "approved""#) {
            Outcome::Error(_) => {}
            other => panic!("Expected Error from sandbox violation, got {other:?}"),
        }
    }

    #[test]
    fn sandbox_blocks_io() {
        let lua = test_lua();
        match run_lua(&lua, r#"io.open("/etc/passwd"); return "approved""#) {
            Outcome::Error(_) => {}
            other => panic!("Expected Error from sandbox violation, got {other:?}"),
        }
    }

    #[test]
    fn sandbox_blocks_loadfile() {
        let lua = test_lua();
        match run_lua(&lua, r#"loadfile("/etc/passwd"); return "approved""#) {
            Outcome::Error(_) => {}
            other => panic!("Expected Error from sandbox violation, got {other:?}"),
        }
    }

    #[test]
    fn sandbox_blocks_dofile() {
        let lua = test_lua();
        match run_lua(&lua, r#"dofile("/etc/passwd"); return "approved""#) {
            Outcome::Error(_) => {}
            other => panic!("Expected Error from sandbox violation, got {other:?}"),
        }
    }

    #[test]
    fn sandbox_blocks_load() {
        let lua = test_lua();
        match run_lua(&lua, r#"load("return 1")(); return "approved""#) {
            Outcome::Error(_) => {}
            other => panic!("Expected Error from sandbox violation, got {other:?}"),
        }
    }

    #[test]
    fn sandbox_blocks_require() {
        let lua = test_lua();
        match run_lua(&lua, r#"require("os"); return "approved""#) {
            Outcome::Error(_) => {}
            other => panic!("Expected Error from sandbox violation, got {other:?}"),
        }
    }

    #[test]
    fn denied_extra_values_is_error() {
        let lua = test_lua();
        match run_lua(&lua, r#"return "denied", "reason", "instruction", "extra""#) {
            Outcome::Error(msg) => assert!(msg.contains("at most")),
            other => panic!("Expected Error, got {other:?}"),
        }
    }
}
