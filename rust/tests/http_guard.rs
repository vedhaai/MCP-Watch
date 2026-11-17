//! The framework-free HTTP guard: batches, refusals, SSE framing, session bookkeeping.
//!
//! These run against a stub rather than the engine, because none of this is about a verdict — it
//! is about whether the guard moves bytes correctly. That means they need neither Node nor a built
//! engine, and they stay green on a fresh checkout.

mod common;

use std::sync::Arc;

use common::StubEngine;
use mcpwatch::HttpInfo;
use mcpwatch::http::{Decision, HttpGuard, Kind, REFUSED_BODY};
use serde_json::{Value, json};

fn guard(stub: StubEngine) -> (Arc<StubEngine>, HttpGuard) {
    let stub = Arc::new(stub);
    let guard = HttpGuard::new(Arc::clone(&stub) as Arc<dyn mcpwatch::Verdicts>, ["*"]);
    (stub, guard)
}

fn request_info() -> HttpInfo {
    let mut info = HttpInfo::from_headers([("Content-Type", "application/json")]);
    info.remote_address = Some("127.0.0.1".into());
    info
}

fn call(id: i64, tool: &str) -> Value {
    json!({
        "jsonrpc": "2.0", "id": id, "method": "tools/call",
        "params": { "name": tool, "arguments": {} }
    })
}

// ---- requests ---------------------------------------------------------------------------------

#[tokio::test]
async fn an_ordinary_post_is_not_rewritten() {
    let (_stub, guard) = guard(StubEngine::default());
    let body = serde_json::to_vec(&call(1, "calculator")).unwrap();
    let check = guard.check_request("POST", &request_info(), &body).await;
    assert_eq!(check.decision, Decision::Pass { rewritten: None });
}

#[tokio::test]
async fn a_blocked_call_is_answered_here() {
    let (_stub, guard) = guard(StubEngine::blocking(&["read_file"]));
    let body = serde_json::to_vec(&call(7, "read_file")).unwrap();
    let check = guard.check_request("POST", &request_info(), &body).await;

    let Decision::Reply(bytes) = check.decision else {
        panic!("a blocked call must be answered by the guard");
    };
    let reply: Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(reply["id"], json!(7));
    assert_eq!(reply["error"]["code"], json!(mcpwatch::BLOCKED));
}

#[tokio::test]
async fn a_body_that_is_not_json_is_not_ours_to_judge() {
    let (_stub, guard) = guard(StubEngine::blocking(&["read_file"]));
    let check = guard
        .check_request("POST", &request_info(), b"this is not json")
        .await;
    assert_eq!(check.decision, Decision::Pass { rewritten: None });
}

#[tokio::test]
async fn every_entry_of_a_refused_batch_is_answered() {
    // Nothing may be left waiting for a reply the application will never produce.
    let (_stub, guard) = guard(StubEngine::blocking(&["read_file"]));
    let body = serde_json::to_vec(&json!([call(1, "calculator"), call(2, "read_file")])).unwrap();
    let check = guard.check_request("POST", &request_info(), &body).await;

    let Decision::Reply(bytes) = check.decision else {
        panic!("a batch with a blocked call is answered by the guard");
    };
    let replies: Vec<Value> = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(replies.len(), 2, "both entries get an answer");
    for reply in &replies {
        assert_eq!(reply["error"]["code"], json!(mcpwatch::BLOCKED));
    }
}

#[tokio::test]
async fn rubbish_inside_a_batch_survives_untouched() {
    // Dropping these, or writing a null in their place, would rewrite a client's batch into
    // something it never sent.
    let (_stub, guard) = guard(StubEngine::default());
    for body in [json!([null]), json!([1, 2])] {
        let bytes = serde_json::to_vec(&body).unwrap();
        let check = guard.check_request("POST", &request_info(), &bytes).await;
        assert_eq!(
            check.decision,
            Decision::Pass { rewritten: None },
            "for {body}"
        );
    }
}

#[tokio::test]
async fn only_an_entry_with_an_id_gets_an_answer() {
    let (_stub, guard) = guard(StubEngine::blocking(&["read_file"]));
    let body = serde_json::to_vec(&json!([null, call(2, "read_file")])).unwrap();
    let check = guard.check_request("POST", &request_info(), &body).await;

    let Decision::Reply(bytes) = check.decision else {
        panic!("the blocked entry is answered");
    };
    let replies: Vec<Value> = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(replies.len(), 1, "the null has nothing waiting on it");
}

#[tokio::test]
async fn a_get_is_refused_when_the_transport_rules_say_so() {
    let (_stub, guard) = guard(StubEngine {
        refuse_http: true,
        ..Default::default()
    });
    let check = guard.check_request("GET", &request_info(), &[]).await;
    assert_eq!(check.decision, Decision::Refuse);
    assert_eq!(REFUSED_BODY, "Refused by MCPWatch");
}

#[tokio::test]
async fn the_session_falls_back_to_the_remote_address() {
    let (_stub, guard) = guard(StubEngine::default());
    let check = guard.check_request("GET", &request_info(), &[]).await;
    assert_eq!(check.session(), "http-127.0.0.1");
    assert!(!check.strict(), "no session header means not strict");
}

#[tokio::test]
async fn a_session_header_names_the_session_and_makes_it_strict() {
    let (_stub, guard) = guard(StubEngine::default());
    let mut info = request_info();
    info.headers
        .insert("mcp-session-id".into(), "abc123".into());
    let check = guard.check_request("GET", &info, &[]).await;
    assert_eq!(check.session(), "abc123");
    assert!(check.strict());
}

#[tokio::test]
async fn an_empty_session_header_still_makes_the_request_strict() {
    // The asymmetry is deliberate and shared with the other adapters: the name falls back, but a
    // header that was sent at all is a claim the guard can hold the server to.
    let (_stub, guard) = guard(StubEngine::default());
    let mut info = request_info();
    info.headers.insert("mcp-session-id".into(), String::new());
    let check = guard.check_request("GET", &info, &[]).await;
    assert_eq!(check.session(), "http-127.0.0.1");
    assert!(check.strict());
}

#[tokio::test]
async fn header_names_are_lower_cased_for_the_engine() {
    let info = HttpInfo::from_headers([("Mcp-Session-Id", "X"), ("ORIGIN", "https://e.example")]);
    assert_eq!(info.get("mcp-session-id"), Some("X"));
    assert_eq!(info.get("origin"), Some("https://e.example"));
    assert!(
        info.headers
            .keys()
            .all(|k| k.chars().all(|c| !c.is_uppercase()))
    );
}

#[tokio::test]
async fn an_unknown_remote_address_is_left_out_entirely() {
    // Present-but-null would switch MW037 on with a useless address.
    let info = HttpInfo::from_headers([("host", "localhost")]);
    let json = serde_json::to_value(&info).unwrap();
    assert!(json.get("remoteAddress").is_none());
    assert!(json.get("encrypted").is_none());
}

// ---- responses --------------------------------------------------------------------------------

fn response_info(content_type: &str) -> HttpInfo {
    HttpInfo::from_headers([("Content-Type", content_type)])
}

#[tokio::test]
async fn a_new_session_id_in_the_response_renames_the_session() {
    let (stub, guard) = guard(StubEngine::default());
    let mut check = guard.check_request("POST", &request_info(), b"{}").await;
    assert_eq!(check.session(), "http-127.0.0.1");

    let mut headers = response_info("application/json");
    headers
        .headers
        .insert("mcp-session-id".into(), "new-session".into());
    let _filter = guard.response(&mut check, &headers);

    assert_eq!(check.session(), "new-session");
    assert_eq!(stub.notes(), vec!["rename:http-127.0.0.1>new-session"]);
}

#[tokio::test]
async fn a_delete_drops_the_session() {
    let (stub, guard) = guard(StubEngine::default());
    let check = guard.check_request("DELETE", &request_info(), &[]).await;
    guard.finished(&check);
    assert_eq!(stub.notes(), vec!["drop:http-127.0.0.1"]);
}

#[tokio::test]
async fn an_unparseable_json_response_comes_back_untouched() {
    let (_stub, guard) = guard(StubEngine::default());
    let mut check = guard.check_request("POST", &request_info(), b"{}").await;
    let mut filter = guard.response(&mut check, &response_info("application/json"));
    assert_eq!(filter.kind(), Kind::Json);
    assert_eq!(filter.json(b"not json at all").await, b"not json at all");
}

#[tokio::test]
async fn a_withheld_single_json_message_becomes_an_empty_object() {
    let (_stub, guard) = guard(StubEngine {
        withhold_server: true,
        ..Default::default()
    });
    let mut check = guard.check_request("POST", &request_info(), b"{}").await;
    let mut filter = guard.response(&mut check, &response_info("application/json"));
    let out = filter
        .json(br#"{"jsonrpc":"2.0","id":1,"result":{}}"#)
        .await;
    assert_eq!(String::from_utf8(out).unwrap(), "{}");
}

#[tokio::test]
async fn a_rewritten_json_response_carries_the_replacement() {
    let (_stub, guard) = guard(StubEngine {
        rewrite_result: Some(json!({ "content": [{ "type": "text", "text": "withheld" }] })),
        ..Default::default()
    });
    let mut check = guard.check_request("POST", &request_info(), b"{}").await;
    let mut filter = guard.response(&mut check, &response_info("application/json"));
    let out = filter
        .json(br#"{"jsonrpc":"2.0","id":1,"result":{"secret":"x"}}"#)
        .await;
    let value: Value = serde_json::from_slice(&out).unwrap();
    assert_eq!(value["result"]["content"][0]["text"], json!("withheld"));
}

#[tokio::test]
async fn a_non_json_non_sse_response_is_raw() {
    let (_stub, guard) = guard(StubEngine::default());
    let mut check = guard.check_request("GET", &request_info(), &[]).await;
    let mut filter = guard.response(&mut check, &response_info("text/html"));
    assert_eq!(filter.kind(), Kind::Raw);
    assert_eq!(filter.feed(b"<html>").await.unwrap(), b"<html>");
    assert!(filter.end().await.is_empty());
}

// ---- SSE --------------------------------------------------------------------------------------

async fn sse_filter(stub: StubEngine) -> (Arc<StubEngine>, mcpwatch::http::ResponseFilter) {
    let (stub, guard) = guard(stub);
    let mut check = guard.check_request("POST", &request_info(), b"{}").await;
    let filter = guard.response(&mut check, &response_info("text/event-stream"));
    (stub, filter)
}

#[tokio::test]
async fn an_event_split_across_chunks_waits_for_its_end() {
    let (_stub, mut filter) = sse_filter(StubEngine::default()).await;
    let half = filter
        .feed(b"id: 1\ndata: {\"jsonrpc\":\"2.0\"")
        .await
        .unwrap();
    assert!(half.is_empty(), "half an event is not an event");

    let rest = filter.feed(b",\"id\":1,\"result\":{}}\n\n").await.unwrap();
    let text = String::from_utf8(rest).unwrap();
    assert!(text.contains("id: 1"), "the id line is kept: {text:?}");
    assert!(text.ends_with("\n\n"), "the event is terminated: {text:?}");
}

#[tokio::test]
async fn a_withheld_event_emits_nothing_at_all() {
    let (stub, mut filter) = sse_filter(StubEngine {
        withhold_server: true,
        ..Default::default()
    })
    .await;
    let out = filter
        .feed(b"id: 9\ndata: {\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{}}\n\n")
        .await
        .unwrap();
    assert!(out.is_empty(), "the whole event vanishes, id line and all");
    // But the id was still recorded: the client may resume from it.
    assert!(
        stub.notes().iter().any(|n| n == "event:http-127.0.0.1/9"),
        "the id is noted before any decision: {:?}",
        stub.notes()
    );
}

#[tokio::test]
async fn a_keep_alive_comment_passes_verbatim() {
    let (_stub, mut filter) = sse_filter(StubEngine {
        withhold_server: true,
        ..Default::default()
    })
    .await;
    // No data line, so there is nothing for the rules to judge: it must survive even though the
    // stub would withhold any message it was given.
    let out = filter.feed(b": keep-alive\n\n").await.unwrap();
    assert_eq!(String::from_utf8(out).unwrap(), ": keep-alive\n\n");
}

#[tokio::test]
async fn an_event_without_json_data_passes_verbatim() {
    let (_stub, mut filter) = sse_filter(StubEngine {
        withhold_server: true,
        ..Default::default()
    })
    .await;
    let out = filter.feed(b"data: not json\n\n").await.unwrap();
    assert_eq!(String::from_utf8(out).unwrap(), "data: not json\n\n");
}

#[tokio::test]
async fn multi_line_data_is_reassembled_into_one_line() {
    let (_stub, mut filter) = sse_filter(StubEngine::default()).await;
    let out = filter
        .feed(b"data: {\"jsonrpc\":\"2.0\",\ndata: \"id\":1,\"result\":{}}\n\n")
        .await
        .unwrap();
    let text = String::from_utf8(out).unwrap();
    assert_eq!(
        text.matches("data:").count(),
        1,
        "exactly one data line comes back: {text:?}"
    );
}

#[tokio::test]
async fn a_crlf_split_across_chunks_does_not_open_a_blank_event() {
    let (_stub, mut filter) = sse_filter(StubEngine::default()).await;
    // The boundary is `\r\n\r\n`, but the chunk ends between the last CR and LF.
    let first = filter
        .feed(b"data: {\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{}}\r\n\r")
        .await
        .unwrap();
    assert!(!first.is_empty(), "the event is released immediately");

    let second = filter
        .feed(b"\ndata: {\"jsonrpc\":\"2.0\",\"id\":2,\"result\":{}}\n\n")
        .await
        .unwrap();
    let text = String::from_utf8(second).unwrap();
    assert!(
        text.starts_with("data:"),
        "the orphaned LF must not open event two with a blank line: {text:?}"
    );
}

#[tokio::test]
async fn a_trailing_event_with_no_blank_line_is_still_checked() {
    let (_stub, mut filter) = sse_filter(StubEngine {
        withhold_server: true,
        ..Default::default()
    })
    .await;
    let fed = filter
        .feed(b"data: {\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{}}")
        .await
        .unwrap();
    assert!(fed.is_empty(), "no boundary yet");
    let rest = filter.end().await;
    assert!(rest.is_empty(), "the last event is judged, and withheld");
}

#[tokio::test]
async fn an_oversized_event_is_refused_rather_than_truncated() {
    let (stub, _) = guard(StubEngine::default());
    let guard = HttpGuard::new(stub as Arc<dyn mcpwatch::Verdicts>, ["*"]).max_body_bytes(64);
    let mut check = guard.check_request("POST", &request_info(), b"{}").await;
    let mut filter = guard.response(&mut check, &response_info("text/event-stream"));

    let huge = format!("data: {}", "x".repeat(512));
    assert!(
        filter.feed(huge.as_bytes()).await.is_err(),
        "a truncated-but-clean-looking stream is worse than a visibly broken one"
    );
}
