use std::path::Path;

use serde::Deserialize;

const DEFAULT_MODEL: &str = "claude-haiku-4-5-20251001";

#[derive(Debug, Deserialize)]
pub struct ScriptEntry {
    pub path: String,
    #[allow(dead_code)]
    pub description: String,
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default = "default_timeout")]
    pub timeout: u64,
}

fn default_true() -> bool {
    true
}

fn default_timeout() -> u64 {
    10
}

#[derive(Debug, Deserialize, Default)]
pub struct SieveConfig {
    #[serde(default)]
    scripts: Vec<ScriptEntry>,
    summarizer_model: Option<String>,
}

impl SieveConfig {
    pub fn load(path: &Path) -> Result<Self, String> {
        let text = std::fs::read_to_string(path)
            .map_err(|e| format!("Failed to read {}: {e}", path.display()))?;
        let config: SieveConfig = serde_yaml::from_str(&text)
            .map_err(|e| format!("Invalid YAML in {}: {e}", path.display()))?;
        Ok(config)
    }

    pub fn scripts(&self) -> Vec<&ScriptEntry> {
        self.scripts.iter().filter(|s| s.enabled).collect()
    }

    pub fn summarizer_model(&self) -> &str {
        self.summarizer_model.as_deref().unwrap_or(DEFAULT_MODEL)
    }
}
