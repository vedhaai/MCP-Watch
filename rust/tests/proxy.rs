//! The `mcpwatch-proxy` binary, run for real against a real child server and the real engine.

#![cfg(all(feature = "proxy", unix))]

mod common;

use std::process::Stdio;
use std::time::Duration;

use common::*;
use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

/// A stand-in MCP server: it answers every request, and records what reached it.
const FAKE_SERVER: &str = r#"
const seen = [];
process.stdin.setEncoding("utf8");
let buf = "";
process.stdin.on("data", (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf("\n")) !== -1) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    let msg; try { msg = JSON.parse(line); } catch { continue; }
    seen.push(msg.method || "?");
    if (msg.id !== undefined && msg.method) {
      process.stdout.write(JSON.stringify({
        jsonrpc: "2.0", id: msg.id,
        result: { reached: true, method: msg.method, seen: seen.length },
      }) + "\n");
    }
  }
});
"#;

struct Proxy {
    child: tokio::process::Child,
    lines: tokio::io::Lines<BufReader<tokio::process::ChildStdout>>,
    stdin: tokio::process::ChildStdin,
}

impl Proxy {
    async fn start(tmp: &TempDir, mode: &str) -> Self {
        let server = tmp.path().join("fake-server.js");
        std::fs::write(&server, FAKE_SERVER).unwrap();

        let mut child = tokio::process::Command::new(env!("CARGO_BIN_EXE_mcpwatch-proxy"))
            .args(["--name", "rust-proxy-test", "--mode", mode, "--"])
            .arg("node")
            .arg(&server)
            // Point the guard at this checkout's engine, never npx.
            .env(
                "MCPWATCH_ENGINE",
                format!("node {}", engine_cli().display()),
            )
            .env("MCPWATCH_EVENTS", tmp.path().join("events.jsonl"))
            .env("MCPWATCH_PINS", tmp.path().join("pins.json"))
            .env_remove("MCPWATCH_PROJECT_KEY")
            .env_remove("MCPWATCH_AI")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .kill_on_drop(true)
            .spawn()
            .expect("the proxy starts");

        let stdin = child.stdin.take().unwrap();
        let lines = BufReader::new(child.stdout.take().unwrap()).lines();
        Self {
            child,
            lines,
            stdin,
        }
    }

    async fn send(&mut self, message: &Value) {
        let mut line = serde_json::to_vec(message).unwrap();
        line.push(b'\n');
        self.stdin.write_all(&line).await.unwrap();
        self.stdin.flush().await.unwrap();
    }

    async fn send_raw(&mut self, raw: &str) {
        self.stdin.write_all(raw.as_bytes()).await.unwrap();
        self.stdin.flush().await.unwrap();
    }

    async fn next(&mut self) -> Option<Value> {
        match tokio::time::timeout(Duration::from_secs(10), self.lines.next_line()).await {
            Ok(Ok(Some(line))) => serde_json::from_str(&line).ok(),
            _ => None,
        }
    }

    async fn expect_silence(&mut self) {
        let quiet = tokio::time::timeout(Duration::from_millis(600), self.lines.next_line()).await;
        assert!(quiet.is_err(), "nothing should have come back");
    }
}

impl Drop for Proxy {
    fn drop(&mut self) {
        let _ = self.child.start_kill();
    }
}

#[tokio::test]
async fn a_benign_call_reaches_the_server_and_its_answer_comes_back() {
    require_engine!();
    let tmp = TempDir::new("proxy-benign");
    let mut proxy = Proxy::start(&tmp, "enforce").await;

    proxy
        .send(&tool_call(1, "calculator", json!({ "expr": "2+2" })))
        .await;

    let reply = proxy.next().await.expect("the server answers");
    assert_eq!(reply["id"], json!(1));
    assert_eq!(reply["result"]["reached"], json!(true));
}

#[tokio::test]
async fn a_blocked_call_is_answered_by_the_proxy_and_never_reaches_the_server() {
    require_engine!();
    let tmp = TempDir::new("proxy-blocked");
    let mut proxy = Proxy::start(&tmp, "enforce").await;

    proxy
        .send(&tool_call(
            7,
            "read_file",
            json!({ "path": "../../../../etc/passwd" }),
        ))
        .await;

    let reply = proxy.next().await.expect("the proxy answers");
    assert_eq!(reply["id"], json!(7));
    assert_eq!(error_code(&reply), Some(mcpwatch::BLOCKED));
    assert!(
        rules(&reply).contains(&"MW002".to_string()),
        "expected MW002, got {:?}",
        rules(&reply)
    );
    assert!(
        reply["result"].is_null(),
        "the server never produced a result: {reply}"
    );

    // And the next benign call shows the server's counter never saw the blocked one.
    proxy
        .send(&tool_call(8, "calculator", json!({ "expr": "1+1" })))
        .await;
    let next = proxy.next().await.expect("the server answers");
    assert_eq!(
        next["result"]["seen"],
        json!(1),
        "the server should have seen exactly one message: {next}"
    );
}

#[tokio::test]
async fn a_line_that_is_not_json_is_forwarded_untouched() {
    require_engine!();
    let tmp = TempDir::new("proxy-nonjson");
    let mut proxy = Proxy::start(&tmp, "enforce").await;

    // The fake server ignores it; what matters is that the proxy does not answer or crash.
    proxy.send_raw("this is not json\n").await;
    proxy.expect_silence().await;

    proxy
        .send(&tool_call(1, "calculator", json!({ "expr": "2+2" })))
        .await;
    assert!(proxy.next().await.is_some(), "the session still works");
}

#[tokio::test]
async fn a_message_split_across_writes_is_reassembled() {
    require_engine!();
    let tmp = TempDir::new("proxy-split");
    let mut proxy = Proxy::start(&tmp, "enforce").await;

    let message =
        serde_json::to_string(&tool_call(3, "calculator", json!({ "expr": "2+2" }))).unwrap();
    let (first, second) = message.split_at(message.len() / 2);
    proxy.send_raw(first).await;
    tokio::time::sleep(Duration::from_millis(120)).await;
    proxy.send_raw(&format!("{second}\n")).await;

    let reply = proxy.next().await.expect("the halves make one message");
    assert_eq!(reply["id"], json!(3));
}

#[tokio::test]
async fn crlf_line_endings_are_understood() {
    require_engine!();
    let tmp = TempDir::new("proxy-crlf");
    let mut proxy = Proxy::start(&tmp, "enforce").await;

    let message =
        serde_json::to_string(&tool_call(4, "calculator", json!({ "expr": "2+2" }))).unwrap();
    proxy.send_raw(&format!("{message}\r\n")).await;

    let reply = proxy.next().await.expect("a CRLF line is still a line");
    assert_eq!(reply["id"], json!(4));
}

#[tokio::test]
async fn observe_mode_lets_an_attack_through() {
    require_engine!();
    let tmp = TempDir::new("proxy-observe");
    let mut proxy = Proxy::start(&tmp, "observe").await;

    proxy
        .send(&tool_call(
            5,
            "read_file",
            json!({ "path": "../../../../etc/passwd" }),
        ))
        .await;

    let reply = proxy.next().await.expect("the server answers");
    assert_eq!(
        reply["result"]["reached"],
        json!(true),
        "observe reports but never refuses: {reply}"
    );
}
