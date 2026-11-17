//! The twin of the Java package's `TestEngine` and Python's `conftest.py`.
//!
//! Every test runs against **this checkout's** engine (`engine/dist/cli.js`), never `npx`, so a
//! test can neither reach the network nor report into a developer's real dashboard.

#![allow(dead_code)]

use std::path::PathBuf;

use mcpwatch::{Engine, McpWatchOptions, Mode};
use serde_json::{Value, json};

/// Where the built engine lives, relative to this crate.
pub fn engine_cli() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("engine")
        .join("dist")
        .join("cli.js")
}

/// True when the engine has been built. Tests that need a verdict call [`require_engine`].
pub fn engine_is_built() -> bool {
    engine_cli().is_file()
}

/// Fails with the same wording the Python suite uses, unless skipping was asked for explicitly.
///
/// `cargo test` has no way to skip a test, and a suite that silently passes without checking
/// anything is worse than one that fails. `MCPWATCH_SKIP_ENGINE_TESTS=1` makes it possible to skip
/// deliberately, and prints a line so it stays visible in a log.
#[macro_export]
macro_rules! require_engine {
    () => {
        if !$crate::common::engine_is_built() {
            if std::env::var("MCPWATCH_SKIP_ENGINE_TESTS").as_deref() == Ok("1") {
                eprintln!("SKIPPED: {} needs engine/dist/cli.js", module_path!());
                return;
            }
            panic!(
                "engine/dist/cli.js is missing: run `npm ci && npm run build -w engine` in the \
                 repository root (or set MCPWATCH_SKIP_ENGINE_TESTS=1)"
            );
        }
    };
}

/// An engine wired to this checkout, writing its state into the test's own temporary directory.
pub async fn start_engine(name: &str, mode: Mode, tmp: &TempDir) -> Engine {
    // No project key: nothing is reported to, or fetched from, a dashboard.
    for leaked in [
        "MCPWATCH_PROJECT_KEY",
        "MCPWATCH_PROJECT_KEY_FILE",
        "MCPWATCH_AI",
        "MCPWATCH_MODE",
        "MCPWATCH_ENABLED",
    ] {
        unsafe { std::env::remove_var(leaked) };
    }

    let options = McpWatchOptions::builder()
        .engine_command(["node", &engine_cli().to_string_lossy()])
        .mode(mode)
        .events_file(tmp.path().join("events.jsonl"))
        .pins_file(tmp.path().join("pins.json"))
        .registry_file(tmp.path().join("registry.json"))
        .start_timeout(std::time::Duration::from_secs(60))
        .call_timeout(std::time::Duration::from_secs(30))
        .build();

    let engine = Engine::new(name, options).expect("the options encode");
    engine.start().await.expect("the engine starts");
    engine
}

/// A temporary directory that cleans itself up, without pulling in `tempfile`.
pub struct TempDir(PathBuf);

impl TempDir {
    pub fn new(label: &str) -> Self {
        let mut path = std::env::temp_dir();
        let unique = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        path.push(format!(
            "mcpwatch-rs-{label}-{unique}-{}",
            std::process::id()
        ));
        std::fs::create_dir_all(&path).expect("a temporary directory");
        Self(path)
    }

    pub fn path(&self) -> &std::path::Path {
        &self.0
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

// ---- message builders ---------------------------------------------------------------------

pub fn tool_call(id: i64, tool: &str, arguments: Value) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "method": "tools/call",
        "params": { "name": tool, "arguments": arguments },
    })
}

pub fn text_result(id: i64, text: &str) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "result": { "content": [{ "type": "text", "text": text }] },
    })
}

/// The rule ids carried by a refusal.
pub fn rules(reply: &Value) -> Vec<String> {
    reply
        .get("error")
        .and_then(|e| e.get("data"))
        .and_then(|d| d.get("rules"))
        .and_then(Value::as_array)
        .map(|rules| {
            rules
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

pub fn error_code(reply: &Value) -> Option<i64> {
    reply.get("error")?.get("code")?.as_i64()
}

// ---- a stub engine, for the behaviour that needs no verdict ---------------------------------

use std::sync::Mutex;

use mcpwatch::{BoxFuture, HttpInfo, Outcome, Verdict, Verdicts};

/// A guard that answers from a script rather than from the rules.
///
/// Most of the HTTP adapter is framing — batches, SSE boundaries, UTF-8, content lengths — and
/// none of it needs a real verdict. Running those against a stub means they need neither Node nor
/// a built engine, so they stay green on a fresh checkout.
#[derive(Default)]
pub struct StubEngine {
    /// Tool names to refuse with -32001.
    pub blocked_tools: Vec<String>,
    /// Server messages to withhold entirely.
    pub withhold_server: bool,
    /// Replace a server message's `result` with this.
    pub rewrite_result: Option<Value>,
    /// What `from_http` answers.
    pub refuse_http: bool,
    /// A reply the guard owes the server, returned once for a server message.
    pub server_reply: Option<Value>,
    /// Every bookkeeping call, in order: `rename:a>b`, `drop:s`, `event:s/id`.
    pub notes: Mutex<Vec<String>>,
}

impl StubEngine {
    pub fn blocking(tools: &[&str]) -> Self {
        Self {
            blocked_tools: tools.iter().map(|t| t.to_string()).collect(),
            ..Default::default()
        }
    }

    pub fn notes(&self) -> Vec<String> {
        self.notes.lock().unwrap().clone()
    }

    fn tool_of(message: &Value) -> Option<&str> {
        message.get("params")?.get("name")?.as_str()
    }
}

impl Verdicts for StubEngine {
    fn from_client<'a>(
        &'a self,
        _session: &'a str,
        msg: Value,
        _http: Option<&'a HttpInfo>,
    ) -> BoxFuture<'a, Outcome> {
        Box::pin(async move {
            let blocked = Self::tool_of(&msg)
                .is_some_and(|tool| self.blocked_tools.iter().any(|b| b == tool));
            if blocked {
                let id = msg.get("id").cloned().unwrap_or(Value::Null);
                return Outcome {
                    forward: Verdict::Drop,
                    reply: Some(mcpwatch::error_reply(
                        &id,
                        mcpwatch::BLOCKED,
                        "Blocked by MCPWatch: MW002 stubbed",
                    )),
                };
            }
            Outcome::pass(msg)
        })
    }

    fn from_server<'a>(
        &'a self,
        _session: &'a str,
        msg: Value,
        _strict: bool,
    ) -> BoxFuture<'a, Outcome> {
        Box::pin(async move {
            if self.withhold_server {
                return Outcome {
                    forward: Verdict::Drop,
                    reply: self.server_reply.clone(),
                };
            }
            if let Some(result) = &self.rewrite_result {
                let mut rewritten = msg.clone();
                if let Some(object) = rewritten.as_object_mut() {
                    object.insert("result".into(), result.clone());
                }
                return Outcome {
                    forward: Verdict::Replace(rewritten),
                    reply: None,
                };
            }
            Outcome {
                forward: Verdict::Forward(msg),
                reply: self.server_reply.clone(),
            }
        })
    }

    fn from_http<'a>(
        &'a self,
        _session: &'a str,
        _http: &'a HttpInfo,
        _method: &'a str,
    ) -> BoxFuture<'a, bool> {
        Box::pin(async move { self.refuse_http })
    }

    fn rename_session(&self, from: &str, to: &str) {
        self.notes
            .lock()
            .unwrap()
            .push(format!("rename:{from}>{to}"));
    }

    fn drop_session(&self, session: &str) {
        self.notes.lock().unwrap().push(format!("drop:{session}"));
    }

    fn note_event_id(&self, session: &str, event_id: &str) {
        self.notes
            .lock()
            .unwrap()
            .push(format!("event:{session}/{event_id}"));
    }
}
