use std::env;

use serde::{Deserialize, Serialize};

use crate::config::SummarizerConfig;

const API_VERSION: &str = "2023-06-01";

#[derive(Serialize)]
struct ApiRequest<'a> {
    model: &'a str,
    max_tokens: u32,
    messages: Vec<Message>,
}

#[derive(Serialize)]
struct Message {
    role: String,
    content: String,
}

#[derive(Deserialize)]
struct ApiResponse {
    content: Vec<ContentBlock>,
}

#[derive(Deserialize)]
struct ContentBlock {
    text: String,
}

fn fmt_with_commas(n: usize) -> String {
    let s = n.to_string();
    let chars: Vec<char> = s.chars().collect();
    let len = chars.len();
    chars.iter().enumerate().fold(String::new(), |mut acc, (i, c)| {
        if i > 0 && (len - i) % 3 == 0 {
            acc.push(',');
        }
        acc.push(*c);
        acc
    })
}

pub fn summarize(tool_name: &str, tool_input: &serde_json::Value, cfg: &SummarizerConfig) -> Result<String, String> {
    let api_key = env::var("ANTHROPIC_API_KEY")
        .map_err(|_| "ANTHROPIC_API_KEY not set".to_string())?;

    let (input_summary, input_header) = {
        let full = serde_json::to_string(tool_input).unwrap_or_default();
        let full_len = full.len();
        if full_len > cfg.input_truncation_length {
            let truncated = &full[..full.floor_char_boundary(cfg.input_truncation_length)];
            let summary = format!("{truncated}...");
            let header = format!(
                "Input ({} of {} characters):",
                fmt_with_commas(cfg.input_truncation_length),
                fmt_with_commas(full_len),
            );
            (summary, header)
        } else {
            (full, "Input:".to_string())
        }
    };

    let prompt = format!(
        "{}\n\nTool: {}\n{}\n{}",
        cfg.prompt, tool_name, input_header, input_summary
    );

    let body = ApiRequest {
        model: &cfg.model,
        max_tokens: cfg.max_tokens,
        messages: vec![Message {
            role: "user".into(),
            content: prompt,
        }],
    };

    let agent = ureq::Agent::new_with_config(
        ureq::config::Config::builder()
            .timeout_global(Some(std::time::Duration::from_secs(cfg.timeout_seconds)))
            .build(),
    );

    let json_body = serde_json::to_vec(&body)
        .map_err(|e| format!("Failed to serialize request: {e}"))?;

    let mut resp = agent
        .post(&cfg.api_url)
        .header("x-api-key", &api_key)
        .header("anthropic-version", API_VERSION)
        .content_type("application/json")
        .send(&json_body)
        .map_err(|e| format!("Summarizer API call failed: {e}"))?;

    let api_resp: ApiResponse = resp
        .body_mut()
        .read_json()
        .map_err(|e| format!("Failed to parse summarizer response: {e}"))?;

    if api_resp.content.is_empty() {
        return Err("Summarizer returned empty response".to_string());
    }

    Ok(api_resp.content[0].text.clone())
}
