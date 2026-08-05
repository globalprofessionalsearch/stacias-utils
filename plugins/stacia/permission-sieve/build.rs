use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

fn main() {
    let hash = Command::new("git")
        .args(["rev-parse", "--short", "HEAD"])
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .unwrap_or_else(|| "unknown".to_string());

    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs().to_string())
        .unwrap_or_else(|_| "0".to_string());

    println!("cargo:rustc-env=SIEVE_BUILD_HASH={hash}");
    println!("cargo:rustc-env=SIEVE_BUILD_TS={ts}");
    println!("cargo:rerun-if-changed=build.rs");
    println!("cargo:rerun-if-changed=src/");
    println!("cargo:rerun-if-changed=.git/HEAD");
}
