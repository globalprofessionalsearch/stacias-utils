use std::path::{Path, PathBuf};

use serde::Deserialize;

const DEFAULT_TIMEOUT: u64 = 10;

pub struct RuleEntry {
    pub path: PathBuf,
    pub timeout: u64,
}

pub fn discover_rules(config_dir: &Path) -> Vec<RuleEntry> {
    let rules_dir = config_dir.join("rules");
    let mut entries: Vec<RuleEntry> = match std::fs::read_dir(&rules_dir) {
        Ok(iter) => iter
            .filter_map(|e| e.ok())
            .map(|e| e.path())
            .filter(|p| p.extension().is_some_and(|ext| ext == "lua"))
            .map(|p| RuleEntry { path: p, timeout: DEFAULT_TIMEOUT })
            .collect(),
        Err(_) => vec![],
    };
    entries.sort_by(|a, b| a.path.cmp(&b.path));
    entries
}

fn default_prompt() -> String {
    "Describe what this tool call is attempting in two sentences. Be specific and use plain language.".to_string()
}

fn default_model() -> String {
    "claude-haiku-4-5-20251001".to_string()
}

fn default_max_tokens() -> u32 {
    150
}

fn default_timeout_seconds() -> u64 {
    15
}

fn default_api_url() -> String {
    "https://api.anthropic.com/v1/messages".to_string()
}

fn default_input_truncation_length() -> usize {
    200
}

#[derive(Deserialize)]
pub struct SummarizerConfig {
    #[serde(default = "default_prompt")]
    pub prompt: String,
    #[serde(default = "default_model")]
    pub model: String,
    #[serde(default = "default_max_tokens")]
    pub max_tokens: u32,
    #[serde(default = "default_timeout_seconds")]
    pub timeout_seconds: u64,
    #[serde(default = "default_api_url")]
    pub api_url: String,
    #[serde(default = "default_input_truncation_length")]
    pub input_truncation_length: usize,
}

impl Default for SummarizerConfig {
    fn default() -> Self {
        Self {
            prompt: default_prompt(),
            model: default_model(),
            max_tokens: default_max_tokens(),
            timeout_seconds: default_timeout_seconds(),
            api_url: default_api_url(),
            input_truncation_length: default_input_truncation_length(),
        }
    }
}

#[derive(Deserialize, Default)]
pub struct SieveConfig {
    #[serde(default)]
    pub summarizer: SummarizerConfig,
}

pub fn load_config(config_dir: &Path) -> SieveConfig {
    let path = config_dir.join("sieve.yaml");
    if !path.exists() {
        return SieveConfig::default();
    }
    match std::fs::read_to_string(&path) {
        Ok(contents) => match serde_yaml::from_str(&contents) {
            Ok(cfg) => cfg,
            Err(_) => SieveConfig::default(),
        },
        Err(_) => SieveConfig::default(),
    }
}
