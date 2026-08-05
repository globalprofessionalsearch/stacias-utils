/// Splits a shell command on `|`, `||`, `&&`, `;`, and `&` operators, respecting single and double
/// quotes and heredocs so operators inside them are not treated as delimiters.
pub fn split_on_shell_operators(command: &str) -> Vec<String> {
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
                current.push(ch);
                if let Some(next) = chars.next() {
                    current.push(next);
                }
            }
            '<' if !in_single_quote && chars.peek() == Some(&'<') => {
                current.push(ch);
                current.push(chars.next().unwrap()); // second '<'
                consume_heredoc(&mut chars, &mut current);
            }
            '|' if !in_single_quote && !in_double_quote => {
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
                // >&N or N>&M is fd duplication (e.g. 2>&1), not a shell operator
                if current.ends_with('>') {
                    current.push(ch);
                } else if chars.peek() == Some(&'>') {
                    // &> is a combined redirect operator, not a separator
                    current.push(ch);
                } else if chars.peek() == Some(&'&') {
                    chars.next();
                    let seg = current.trim().to_string();
                    if !seg.is_empty() {
                        segments.push(seg);
                    }
                    current.clear();
                } else {
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

/// After consuming `<<`, extract the heredoc delimiter and consume everything
/// (including the terminator line) into `current`.
fn consume_heredoc(chars: &mut std::iter::Peekable<std::str::Chars>, current: &mut String) {
    // Optional `-` for <<- (strip leading tabs)
    if chars.peek() == Some(&'-') {
        current.push(chars.next().unwrap());
    }

    // Extract delimiter, stripping optional quotes
    let mut delimiter = String::new();
    let mut hit_newline = false;
    while let Some(&ch) = chars.peek() {
        if ch == '\n' || ch == ' ' || ch == '\t' {
            break;
        }
        current.push(chars.next().unwrap());
        if ch != '\'' && ch != '"' {
            delimiter.push(ch);
        }
    }

    if delimiter.is_empty() {
        return;
    }

    // Consume until we find a line that matches the delimiter exactly
    while let Some(ch) = chars.next() {
        current.push(ch);
        if ch == '\n' {
            hit_newline = true;
            // Check if the next line matches the delimiter
            let mut line = String::new();
            while let Some(&next) = chars.peek() {
                if next == '\n' {
                    break;
                }
                line.push(next);
                chars.next();
                current.push(next);
            }
            let trimmed = line.trim();
            if trimmed == delimiter {
                return;
            }
        }
    }
    let _ = hit_newline;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn simple_command() {
        assert_eq!(split_on_shell_operators("ls /tmp"), vec!["ls /tmp"]);
    }

    #[test]
    fn pipe() {
        assert_eq!(
            split_on_shell_operators("cat file | grep test"),
            vec!["cat file", "grep test"]
        );
    }

    #[test]
    fn and_chain() {
        assert_eq!(
            split_on_shell_operators("cmd1 && cmd2"),
            vec!["cmd1", "cmd2"]
        );
    }

    #[test]
    fn or_chain() {
        assert_eq!(
            split_on_shell_operators("cmd1 || cmd2"),
            vec!["cmd1", "cmd2"]
        );
    }

    #[test]
    fn semicolon() {
        assert_eq!(
            split_on_shell_operators("echo a; echo b"),
            vec!["echo a", "echo b"]
        );
    }

    #[test]
    fn background_operator() {
        assert_eq!(
            split_on_shell_operators("cmd1 & cmd2"),
            vec!["cmd1", "cmd2"]
        );
    }

    #[test]
    fn quoted_operators_preserved() {
        assert_eq!(
            split_on_shell_operators(r#"echo "a && b" | grep test"#),
            vec![r#"echo "a && b""#, "grep test"]
        );
    }

    #[test]
    fn single_quoted_operators_preserved() {
        assert_eq!(
            split_on_shell_operators("echo 'a | b'; ls"),
            vec!["echo 'a | b'", "ls"]
        );
    }

    #[test]
    fn escaped_operator() {
        assert_eq!(
            split_on_shell_operators(r"echo a\;b; ls"),
            vec![r"echo a\;b", "ls"]
        );
    }

    #[test]
    fn fd_duplication_not_split() {
        assert_eq!(
            split_on_shell_operators("git rebase --onto abc def ghi 2>&1"),
            vec!["git rebase --onto abc def ghi 2>&1"]
        );
    }

    #[test]
    fn combined_redirect_not_split() {
        assert_eq!(
            split_on_shell_operators("cmd &>/tmp/out"),
            vec!["cmd &>/tmp/out"]
        );
    }

    #[test]
    fn fd_dup_with_real_operator() {
        assert_eq!(
            split_on_shell_operators("cmd1 2>&1 && cmd2"),
            vec!["cmd1 2>&1", "cmd2"]
        );
    }

    #[test]
    fn empty_string() {
        let result: Vec<String> = split_on_shell_operators("");
        assert!(result.is_empty());
    }

    #[test]
    fn complex_chain() {
        assert_eq!(
            split_on_shell_operators("ls /tmp && grep test /etc/hosts || echo fail; pwd"),
            vec!["ls /tmp", "grep test /etc/hosts", "echo fail", "pwd"]
        );
    }

    #[test]
    fn heredoc_not_split() {
        let cmd = "git commit -m \"$(cat <<'EOF'\nsome && content\nEOF\n)\"";
        assert_eq!(split_on_shell_operators(cmd), vec![cmd]);
    }

    #[test]
    fn heredoc_in_double_quotes_not_split() {
        // Matches exactly what the Python integration test sends
        let cmd = "git commit -m \"$(cat <<'EOF'\nfeat: deny push to main\n\ngit push to main blocked\nEOF\n)\"";
        let result = split_on_shell_operators(cmd);
        assert_eq!(result.len(), 1, "heredoc inside double-quoted $() should not split: {:?}", result);
    }

    #[test]
    fn heredoc_unquoted_not_split() {
        let cmd = "cat <<EOF\nfoo | bar\nEOF";
        assert_eq!(split_on_shell_operators(cmd), vec![cmd]);
    }

    #[test]
    fn heredoc_with_real_operator_after() {
        let cmd = "cat <<EOF\nfoo\nEOF\n&& echo done";
        let result = split_on_shell_operators(cmd);
        // Treating the entire thing as one segment is acceptable (fail safe)
        assert!(result.len() <= 2, "heredoc body should not produce extra segments: {:?}", result);
        assert!(result[0].contains("cat <<EOF"), "first segment should contain the heredoc: {:?}", result);
    }

    #[test]
    fn heredoc_double_quoted() {
        let cmd = "cmd <<\"EOF\"\nstuff; things\nEOF";
        assert_eq!(split_on_shell_operators(cmd), vec![cmd]);
    }

    #[test]
    fn heredoc_with_dash() {
        let cmd = "cat <<-EOF\n\tfoo && bar\n\tEOF";
        assert_eq!(split_on_shell_operators(cmd), vec![cmd]);
    }
}
