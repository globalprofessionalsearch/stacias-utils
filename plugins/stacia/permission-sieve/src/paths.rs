use std::collections::HashSet;

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

/// Splits a shell command on `|`, `||`, `&&`, and `;` operators, respecting single and double
/// quotes so operators inside quoted strings are not treated as delimiters.
fn split_on_shell_operators(command: &str) -> Vec<String> {
    let mut segments = Vec::new();
    let mut current = String::new();
    let mut chars = command.chars().peekable();
    let mut in_single_quote = false;
    let mut in_double_quote = false;

    while let Some(ch) = chars.next() {
        match ch {
            '\'' if !in_double_quote => {
                in_single_quote = !in_single_quote;
                current.push(ch);
            }
            '"' if !in_single_quote => {
                in_double_quote = !in_double_quote;
                current.push(ch);
            }
            '\\' if !in_single_quote => {
                // Escape: keep both the backslash and the next char
                current.push(ch);
                if let Some(next) = chars.next() {
                    current.push(next);
                }
            }
            '|' if !in_single_quote && !in_double_quote => {
                // Consume second `|` for `||`
                if chars.peek() == Some(&'|') {
                    chars.next();
                }
                let seg = current.trim().to_string();
                if !seg.is_empty() {
                    segments.push(seg);
                }
                current.clear();
            }
            '&' if !in_single_quote && !in_double_quote => {
                if chars.peek() == Some(&'&') {
                    chars.next();
                    let seg = current.trim().to_string();
                    if !seg.is_empty() {
                        segments.push(seg);
                    }
                    current.clear();
                } else {
                    // Single `&` (background operator) — treat as separator
                    let seg = current.trim().to_string();
                    if !seg.is_empty() {
                        segments.push(seg);
                    }
                    current.clear();
                }
            }
            ';' if !in_single_quote && !in_double_quote => {
                let seg = current.trim().to_string();
                if !seg.is_empty() {
                    segments.push(seg);
                }
                current.clear();
            }
            _ => current.push(ch),
        }
    }

    let seg = current.trim().to_string();
    if !seg.is_empty() {
        segments.push(seg);
    }

    segments
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
}
