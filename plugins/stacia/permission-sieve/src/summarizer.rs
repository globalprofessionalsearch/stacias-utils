use std::{env, process};

use serde::{Deserialize, Serialize};

const API_URL: &str = "https://api.anthropic.com/v1/messages";
const API_VERSION: &str = "2023-06-01";
const MAX_TOKENS: u32 = 150;
const TIMEOUT_SECS: u64 = 15;

fn die(msg: &str) -> ! {
    eprintln!("{msg}");
    process::exit(2);
}

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

pub fn summarize(tool_name: &str, tool_input: &serde_json::Value, model: &str) -> String {
    let api_key =
        env::var("ANTHROPIC_API_KEY").unwrap_or_else(|_| die("ANTHROPIC_API_KEY not set"));

    let input_summary: String = {
        let full = serde_json::to_string(tool_input).unwrap_or_default();
        if full.len() > 200 {
            let truncated = &full[..full.floor_char_boundary(200)];
            format!("{truncated}...")
        } else {
            full
        }
    };

    let prompt = format!(
        "Describe what this tool call is attempting in two sentences. \
         Be specific and use plain language.\n\n\
         Tool: {tool_name}\n\
         Input: {input_summary}"
    );

    let body = ApiRequest {
        model,
        max_tokens: MAX_TOKENS,
        messages: vec![Message {
            role: "user".into(),
            content: prompt,
        }],
    };

    let agent = ureq::Agent::new_with_config(
        ureq::config::Config::builder()
            .timeout_global(Some(std::time::Duration::from_secs(TIMEOUT_SECS)))
            .build(),
    );

    let json_body = serde_json::to_vec(&body).unwrap_or_else(|e| die(&format!("Failed to serialize request: {e}")));

    let response = agent
        .post(API_URL)
        .header("x-api-key", &api_key)
        .header("anthropic-version", API_VERSION)
        .content_type("application/json")
        .send(&json_body);

    match response {
        Ok(mut resp) => {
            let api_resp: ApiResponse = resp
                .body_mut()
                .read_json()
                .unwrap_or_else(|e| die(&format!("Failed to parse summarizer response: {e}")));
            if api_resp.content.is_empty() {
                die("Summarizer returned empty response");
            }
            api_resp.content[0].text.clone()
        }
        Err(e) => die(&format!("Summarizer API call failed: {e}")),
    }
}
