use criterion::{criterion_group, criterion_main, Criterion};
use permission_sieve::config::discover_rules;
use permission_sieve::sieve::{create_lua, set_request};

fn bench_empty_sieve_no_api(c: &mut Criterion) {
    let dir = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(dir.path().join("rules")).unwrap();

    let input = serde_json::json!({
        "tool_name": "Bash",
        "tool_input": {"command": "ls -la", "description": "List files"},
        "session_id": "bench-session",
        "hook_event_name": "PreToolUse"
    });
    let input_str = serde_json::to_string(&input).unwrap();

    c.bench_function("empty_sieve_discover_rules", |b| {
        b.iter(|| {
            let _ = discover_rules(dir.path());
        });
    });

    c.bench_function("empty_sieve_full_parse", |b| {
        b.iter(|| {
            let _event: serde_json::Value = serde_json::from_str(&input_str).unwrap();
            let _ = discover_rules(dir.path());
        });
    });

    c.bench_function("empty_sieve_with_lua_init", |b| {
        b.iter(|| {
            let event: serde_json::Value = serde_json::from_str(&input_str).unwrap();
            let _ = discover_rules(dir.path());
            let lua = create_lua();
            set_request(&lua, &event, &[]);
        });
    });
}

criterion_group!(benches, bench_empty_sieve_no_api);
criterion_main!(benches);
