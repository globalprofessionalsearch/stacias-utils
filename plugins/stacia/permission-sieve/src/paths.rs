use std::collections::HashSet;

use crate::shell::split_on_shell_operators;

/// Extracts file paths from tool inputs and returns them as fully-resolved absolute path strings.
pub fn extract_paths(tool_name: &str, tool_input: &serde_json::Value) -> Vec<String> {
    let home = std::env::var("HOME").unwrap_or_default();

    let raw_paths: Vec<String> = match tool_name {
        "Read" | "Write" | "Edit" | "NotebookEdit" => extract_file_path_field(tool_input),
        "Bash" => extract_bash_paths(tool_input, &home),
        "Agent" => vec![],
        _ => extract_generic_path_field(tool_input),
    };

    // Expand ~ and $HOME, then canonicalize where possible
    let resolved: Vec<String> = raw_paths
        .into_iter()
        .map(|p| expand_path(&p, &home))
        .map(|p| resolve_path(&p))
        .filter(|p| !p.is_empty())
        .collect();

    // Deduplicate while preserving insertion order
    let mut seen = HashSet::new();
    resolved.into_iter().filter(|p| seen.insert(p.clone())).collect()
}

fn expand_path(path: &str, home: &str) -> String {
    if path.starts_with("~/") {
        format!("{}/{}", home, &path[2..])
    } else if path == "~" {
        home.to_string()
    } else if path.starts_with("$HOME/") {
        format!("{}/{}", home, &path[6..])
    } else if path == "$HOME" {
        home.to_string()
    } else {
        path.to_string()
    }
}

fn resolve_path(path: &str) -> String {
    match std::fs::canonicalize(path) {
        Ok(p) => p.to_string_lossy().to_string(),
        Err(_) => path.to_string(),
    }
}

fn extract_file_path_field(tool_input: &serde_json::Value) -> Vec<String> {
    tool_input
        .get("file_path")
        .and_then(|v| v.as_str())
        .map(|s| vec![s.to_string()])
        .unwrap_or_default()
}

fn extract_generic_path_field(tool_input: &serde_json::Value) -> Vec<String> {
    if let Some(fp) = tool_input.get("file_path").and_then(|v| v.as_str()) {
        return vec![fp.to_string()];
    }
    if let Some(p) = tool_input.get("path").and_then(|v| v.as_str()) {
        return vec![p.to_string()];
    }
    vec![]
}

fn extract_bash_paths(tool_input: &serde_json::Value, home: &str) -> Vec<String> {
    let command = match tool_input.get("command").and_then(|v| v.as_str()) {
        Some(cmd) => cmd,
        None => return vec![],
    };

    // Expand ~ and $HOME in the command string before tokenizing
    let expanded_cmd = command
        .replace("$HOME", home)
        .replace("~/", &format!("{}/", home));

    // Split on shell operators, then tokenize each segment
    let segments = split_on_shell_operators(&expanded_cmd);

    let mut paths = Vec::new();
    for segment in segments {
        // Extract redirect targets first
        paths.extend(extract_redirect_targets(&segment));

        match shell_words::split(&segment) {
            Ok(tokens) => {
                for token in tokens {
                    if token.starts_with('/') {
                        paths.push(token);
                    }
                }
            }
            Err(_) => {
                // Fall back to whitespace splitting if shell-words can't parse the segment
                for token in segment.split_whitespace() {
                    if token.starts_with('/') {
                        paths.push(token.to_string());
                    }
                }
            }
        }
    }

    paths
}

/// Extracts file paths from redirect operators in a shell command segment.
/// Handles: `>`, `>>`, `2>`, `2>>`, `&>`, `&>>`, `<` — both spaced (`> /path`)
/// and attached (`2>/path`) forms.
fn extract_redirect_targets(segment: &str) -> Vec<String> {
    let mut targets = Vec::new();
    let mut chars = segment.chars().peekable();
    let mut in_single_quote = false;
    let mut in_double_quote = false;

    while let Some(ch) = chars.next() {
        match ch {
            '\'' if !in_double_quote => { in_single_quote = !in_single_quote; }
            '"' if !in_single_quote => { in_double_quote = !in_double_quote; }
            '\\' if !in_single_quote => { chars.next(); }
            _ if in_single_quote || in_double_quote => {}
            // &> or &>>
            '&' if chars.peek() == Some(&'>') => {
                chars.next(); // consume '>'
                if chars.peek() == Some(&'>') {
                    chars.next(); // consume second '>'
                }
                if let Some(path) = consume_redirect_target(&mut chars) {
                    targets.push(path);
                }
            }
            // Numeric redirect: 2> or 2>>
            '0'..='9' if chars.peek() == Some(&'>') => {
                chars.next(); // consume '>'
                if chars.peek() == Some(&'>') {
                    chars.next(); // consume second '>'
                }
                // Skip >&N (fd duplication like 2>&1)
                if chars.peek() == Some(&'&') {
                    // fd dup — skip, not a file target
                    continue;
                }
                if let Some(path) = consume_redirect_target(&mut chars) {
                    targets.push(path);
                }
            }
            // > or >> or < (not preceded by digit — those are caught above)
            '>' | '<' => {
                if ch == '>' && chars.peek() == Some(&'>') {
                    chars.next(); // consume second '>'
                }
                // Skip >&N (fd duplication)
                if ch == '>' && chars.peek() == Some(&'&') {
                    continue;
                }
                if let Some(path) = consume_redirect_target(&mut chars) {
                    targets.push(path);
                }
            }
            _ => {}
        }
    }

    targets
}

/// After consuming a redirect operator, skip whitespace and collect the target path.
fn consume_redirect_target(chars: &mut std::iter::Peekable<std::str::Chars>) -> Option<String> {
    // Skip whitespace
    while chars.peek() == Some(&' ') || chars.peek() == Some(&'\t') {
        chars.next();
    }

    let mut target = String::new();
    while let Some(&ch) = chars.peek() {
        if ch == ' ' || ch == '\t' || ch == ';' || ch == '|' || ch == '&' || ch == '>' || ch == '<' {
            break;
        }
        target.push(ch);
        chars.next();
    }

    if target.is_empty() || !target.starts_with('/') {
        return None;
    }

    Some(target)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn home() -> String {
        std::env::var("HOME").unwrap_or_else(|_| "/home/testuser".to_string())
    }

    #[test]
    fn read_tool_extracts_file_path() {
        let input = serde_json::json!({"file_path": "/some/nonexistent/path"});
        let paths = extract_paths("Read", &input);
        assert_eq!(paths, vec!["/some/nonexistent/path".to_string()]);
    }

    #[test]
    fn bash_tilde_expansion() {
        let home = home();
        let input = serde_json::json!({"command": "cat ~/foo"});
        let paths = extract_paths("Bash", &input);
        let expected = format!("{}/foo", home);
        assert!(
            paths.contains(&expected),
            "expected {:?} in paths {:?}",
            expected,
            paths
        );
    }

    #[test]
    fn bash_home_var_expansion() {
        let home = home();
        let input = serde_json::json!({"command": "cat $HOME/foo"});
        let paths = extract_paths("Bash", &input);
        let expected = format!("{}/foo", home);
        assert!(
            paths.contains(&expected),
            "expected {:?} in paths {:?}",
            expected,
            paths
        );
    }

    #[test]
    fn bash_pipe_both_sides() {
        let input = serde_json::json!({"command": "cat /a | tee /b"});
        let paths = extract_paths("Bash", &input);
        assert!(paths.contains(&"/a".to_string()), "missing /a in {:?}", paths);
        assert!(paths.contains(&"/b".to_string()), "missing /b in {:?}", paths);
    }

    #[test]
    fn bash_and_chain() {
        let input = serde_json::json!({"command": "cmd1 /a && cmd2 /b"});
        let paths = extract_paths("Bash", &input);
        assert!(paths.contains(&"/a".to_string()), "missing /a in {:?}", paths);
        assert!(paths.contains(&"/b".to_string()), "missing /b in {:?}", paths);
    }

    #[test]
    fn unknown_tool_no_paths() {
        let input = serde_json::json!({"other": "value"});
        let paths = extract_paths("SomeTool", &input);
        assert!(paths.is_empty(), "expected empty, got {:?}", paths);
    }

    #[test]
    fn deduplication() {
        let input = serde_json::json!({"command": "cat /tmp/testfile && cat /tmp/testfile"});
        let paths = extract_paths("Bash", &input);
        let count = paths.iter().filter(|p| p.as_str() == "/tmp/testfile").count();
        assert_eq!(count, 1, "expected exactly one /tmp/testfile, got: {:?}", paths);
    }

    // ── Redirect target extraction ───────────────────────────

    #[test]
    fn redirect_output_spaced() {
        let targets = extract_redirect_targets("echo hello > /tmp/out.txt");
        assert!(targets.contains(&"/tmp/out.txt".to_string()), "got {:?}", targets);
    }

    #[test]
    fn redirect_output_no_space() {
        let targets = extract_redirect_targets("echo hello >/tmp/out.txt");
        assert!(targets.contains(&"/tmp/out.txt".to_string()), "got {:?}", targets);
    }

    #[test]
    fn redirect_append() {
        let targets = extract_redirect_targets("echo hello >> /tmp/log.txt");
        assert!(targets.contains(&"/tmp/log.txt".to_string()), "got {:?}", targets);
    }

    #[test]
    fn redirect_stderr() {
        let targets = extract_redirect_targets("cmd 2>/tmp/err.log");
        assert!(targets.contains(&"/tmp/err.log".to_string()), "got {:?}", targets);
    }

    #[test]
    fn redirect_stderr_append() {
        let targets = extract_redirect_targets("cmd 2>>/tmp/err.log");
        assert!(targets.contains(&"/tmp/err.log".to_string()), "got {:?}", targets);
    }

    #[test]
    fn redirect_combined() {
        let targets = extract_redirect_targets("cmd &>/tmp/all.log");
        assert!(targets.contains(&"/tmp/all.log".to_string()), "got {:?}", targets);
    }

    #[test]
    fn redirect_input() {
        let targets = extract_redirect_targets("cmd < /tmp/input.txt");
        assert!(targets.contains(&"/tmp/input.txt".to_string()), "got {:?}", targets);
    }

    #[test]
    fn redirect_fd_dup_ignored() {
        let targets = extract_redirect_targets("cmd 2>&1");
        assert!(targets.is_empty(), "fd dup should not produce paths, got {:?}", targets);
    }

    #[test]
    fn redirect_non_absolute_ignored() {
        let targets = extract_redirect_targets("echo hi > relative.txt");
        assert!(targets.is_empty(), "relative paths should be ignored, got {:?}", targets);
    }

    #[test]
    fn redirect_in_quotes_ignored() {
        let targets = extract_redirect_targets(r#"echo "data > /tmp/foo" hello"#);
        assert!(targets.is_empty(), "redirects in quotes should be ignored, got {:?}", targets);
    }

    #[test]
    fn redirect_multiple() {
        let targets = extract_redirect_targets("cmd > /tmp/out 2>/tmp/err");
        assert!(targets.contains(&"/tmp/out".to_string()), "missing /tmp/out in {:?}", targets);
        assert!(targets.contains(&"/tmp/err".to_string()), "missing /tmp/err in {:?}", targets);
    }

    #[test]
    fn redirect_paths_in_extract_paths() {
        let home = home();
        let input = serde_json::json!({"command": format!("echo secret > {home}/.ssh/test")});
        let paths = extract_paths("Bash", &input);
        assert!(
            paths.iter().any(|p| p.contains("/.ssh/test")),
            "expected path containing /.ssh/test in {:?}",
            paths
        );
    }
}
