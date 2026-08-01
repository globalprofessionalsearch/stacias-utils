use std::path::{Path, PathBuf};

const DEFAULT_MODEL: &str = "claude-haiku-4-5-20251001";
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

pub fn summarizer_model() -> &'static str {
    DEFAULT_MODEL
}
