/// Splits a shell command on `|`, `||`, `&&`, `;`, and `&` operators, respecting single and double
/// quotes so operators inside quoted strings are not treated as delimiters.
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
}
