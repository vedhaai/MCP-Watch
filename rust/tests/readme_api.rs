//! The builder calls the README shows must actually exist. A README that does not compile is
//! worse than no README: it costs the reader their time and their trust.

use mcpwatch::{Clients, McpWatchOptions, Mode};

#[test]
fn every_builder_method_the_readme_documents_exists() {
    let _ = McpWatchOptions::builder()
        .project_key("mw_x")
        .server("http://127.0.0.1:9100")
        .enabled(true)
        .mode(Mode::Enforce)
        .fail_open(false)
        .deny_tools(["run_command"])
        .allow_tools(["calculator"])
        .allowed_origins(["https://app.example.com"])
        .allowed_hosts(["example.com"])
        .require_auth(true)
        .expected_audience("my-server")
        .window_seconds(60)
        .throttle_at(3)
        .block_at(6)
        .max_calls_per_window(30)
        .max_arg_bytes(100_000)
        .max_result_bytes(5_000_000)
        .ai(false)
        .ai_settings(serde_json::json!({ "enabled": false }))
        .clients(Clients::default())
        .events_file("/tmp/e.jsonl".into())
        .pins_file("/tmp/p.json".into())
        .registry_file("/tmp/r.json".into())
        .engine_command(["node", "cli.js"])
        .start_timeout(std::time::Duration::from_secs(120))
        .call_timeout(std::time::Duration::from_secs(60))
        .channel_capacity(64)
        .option("someFutureEngineKey", serde_json::json!(true))
        .build();
}

#[test]
fn the_modes_the_readme_lists_all_parse() {
    for name in ["off", "observe", "protect", "enforce"] {
        let mode = Mode::parse(name).unwrap_or_else(|| panic!("{name} should be a mode"));
        assert_eq!(mode.as_str(), name);
    }
}
