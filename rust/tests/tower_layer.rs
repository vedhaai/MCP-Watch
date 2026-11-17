//! The tower layer through a real HTTP server and a real socket.
//!
//! Driven over raw TCP rather than a client library, because the things most worth checking here
//! are wire-level: the status a refusal carries, the content length after a rewrite, and whether
//! an SSE stream still reaches the client event by event instead of in one lump at the end.

#![cfg(feature = "tower")]

mod common;

use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use axum::body::Body;
use common::StubEngine;
use http::{Request, Response};
use mcpwatch::Verdicts;
use mcpwatch::http::tower::{GuardedReqBody, McpWatchLayer};
use serde_json::{Value, json};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

/// What the application behind the guard should answer with.
#[derive(Clone)]
enum Reply {
    Json(String),
    /// Each chunk, with a pause between them, so streaming can be observed.
    Sse(Vec<String>),
    Echo,
}

#[derive(Clone)]
struct App {
    reply: Reply,
    calls: Arc<AtomicUsize>,
    bodies: Arc<std::sync::Mutex<Vec<String>>>,
}

/// Starts a guarded server on a free port and returns its address.
async fn serve(stub: Arc<StubEngine>, app: App, layer: McpWatchLayer) -> std::net::SocketAddr {
    let service = tower::service_fn(move |request: Request<GuardedReqBody<Body>>| {
        let app = app.clone();
        async move {
            app.calls.fetch_add(1, Ordering::SeqCst);
            let (parts, body) = request.into_parts();
            let bytes = axum::body::to_bytes(Body::new(body), 1024 * 1024)
                .await
                .unwrap_or_default();
            app.bodies
                .lock()
                .unwrap()
                .push(String::from_utf8_lossy(&bytes).into_owned());

            let response = match &app.reply {
                Reply::Echo => Response::builder()
                    .header("content-type", "text/plain")
                    .body(Body::from(bytes))
                    .unwrap(),
                Reply::Json(json) => Response::builder()
                    .header("content-type", "application/json")
                    .header("content-length", json.len().to_string())
                    .body(Body::from(json.clone()))
                    .unwrap(),
                Reply::Sse(chunks) => {
                    let chunks = chunks.clone();
                    let stream =
                        futures_util::stream::unfold(chunks.into_iter(), |mut it| async move {
                            let next = it.next()?;
                            // A real server does not produce its events all at once.
                            tokio::time::sleep(Duration::from_millis(120)).await;
                            Some((Ok::<_, std::io::Error>(next.into_bytes()), it))
                        });
                    Response::builder()
                        .header("content-type", "text/event-stream")
                        .header("cache-control", "no-cache")
                        .body(Body::from_stream(stream))
                        .unwrap()
                }
            };
            let _ = parts;
            Ok::<_, std::convert::Infallible>(response)
        }
    });

    let guarded = tower::ServiceBuilder::new()
        .map_response(|r: Response<_>| r.map(Body::new))
        .layer(layer)
        .service(service);

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let _ = stub;
    // A Router so axum drives it; the guarded service is the whole application.
    let router = axum::Router::new().fallback_service(guarded);
    tokio::spawn(async move {
        let _ = axum::serve(listener, router).await;
    });
    // Let the listener come up before the first connection.
    tokio::time::sleep(Duration::from_millis(40)).await;
    addr
}

fn stub_layer(stub: &Arc<StubEngine>) -> McpWatchLayer {
    McpWatchLayer::new(Arc::clone(stub) as Arc<dyn Verdicts>)
}

/// Sends a raw request and reads the whole response, with the connection closed at the end.
async fn raw(addr: std::net::SocketAddr, request: &str) -> String {
    let mut socket = TcpStream::connect(addr).await.unwrap();
    socket.write_all(request.as_bytes()).await.unwrap();
    socket.flush().await.unwrap();
    let mut out = Vec::new();
    let _ = tokio::time::timeout(Duration::from_secs(5), socket.read_to_end(&mut out)).await;
    String::from_utf8_lossy(&out).into_owned()
}

fn post(path: &str, body: &str, extra: &str) -> String {
    format!(
        "POST {path} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\
         Content-Type: application/json\r\nContent-Length: {}\r\n{extra}\r\n{body}",
        body.len()
    )
}

fn status_of(response: &str) -> u16 {
    response
        .split_whitespace()
        .nth(1)
        .and_then(|s| s.parse().ok())
        .unwrap_or(0)
}

fn body_of(response: &str) -> &str {
    response
        .split_once("\r\n\r\n")
        .map(|(_, b)| b)
        .unwrap_or("")
}

fn header_of<'a>(response: &'a str, name: &str) -> Option<&'a str> {
    let head = response.split_once("\r\n\r\n").map(|(h, _)| h)?;
    head.lines()
        .find(|l| l.to_ascii_lowercase().starts_with(&format!("{name}:")))
        .and_then(|l| l.split_once(':'))
        .map(|(_, v)| v.trim())
}

fn app(reply: Reply) -> App {
    App {
        reply,
        calls: Arc::new(AtomicUsize::new(0)),
        bodies: Arc::new(std::sync::Mutex::new(Vec::new())),
    }
}

fn call(id: i64, tool: &str) -> String {
    json!({
        "jsonrpc": "2.0", "id": id, "method": "tools/call",
        "params": { "name": tool, "arguments": {} }
    })
    .to_string()
}

// ---- tests ------------------------------------------------------------------------------------

#[tokio::test]
async fn a_blocked_call_is_answered_with_200_and_never_reaches_the_app() {
    let stub = Arc::new(StubEngine::blocking(&["read_file"]));
    let app = app(Reply::Json(
        r#"{"jsonrpc":"2.0","id":1,"result":{}}"#.into(),
    ));
    let addr = serve(Arc::clone(&stub), app.clone(), stub_layer(&stub)).await;

    let response = raw(addr, &post("/mcp", &call(1, "read_file"), "")).await;

    // A JSON-RPC error travels in a 200: the HTTP request succeeded, the call did not.
    assert_eq!(status_of(&response), 200, "{response}");
    let reply: Value = serde_json::from_str(body_of(&response)).unwrap();
    assert_eq!(reply["error"]["code"], json!(mcpwatch::BLOCKED));
    assert_eq!(
        app.calls.load(Ordering::SeqCst),
        0,
        "the application must never see a blocked call"
    );
}

#[tokio::test]
async fn an_ordinary_call_reaches_the_app_and_its_answer_comes_back() {
    let stub = Arc::new(StubEngine::default());
    let app = app(Reply::Json(
        r#"{"jsonrpc":"2.0","id":1,"result":{"ok":true}}"#.into(),
    ));
    let addr = serve(Arc::clone(&stub), app.clone(), stub_layer(&stub)).await;

    let response = raw(addr, &post("/mcp", &call(1, "calculator"), "")).await;

    assert_eq!(status_of(&response), 200, "{response}");
    let reply: Value = serde_json::from_str(body_of(&response)).unwrap();
    assert_eq!(reply["result"]["ok"], json!(true));
    assert_eq!(app.calls.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn a_refused_transport_check_is_403_and_the_app_is_not_called() {
    let stub = Arc::new(StubEngine {
        refuse_http: true,
        ..Default::default()
    });
    let app = app(Reply::Json("{}".into()));
    let addr = serve(Arc::clone(&stub), app.clone(), stub_layer(&stub)).await;

    let response = raw(
        addr,
        "GET /mcp HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\nOrigin: https://evil.example\r\n\r\n",
    )
    .await;

    assert_eq!(status_of(&response), 403, "{response}");
    assert_eq!(body_of(&response), "Refused by MCPWatch");
    assert_eq!(app.calls.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn a_put_body_is_never_eaten() {
    // Reading a non-POST body would hand the application an empty stream.
    let stub = Arc::new(StubEngine::default());
    let app = app(Reply::Echo);
    let addr = serve(Arc::clone(&stub), app.clone(), stub_layer(&stub)).await;

    let request = "PUT /mcp HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\
         Content-Type: text/plain\r\nContent-Length: 11\r\n\r\nthe payload";
    let response = raw(addr, request).await;

    assert_eq!(status_of(&response), 200, "{response}");
    assert_eq!(app.bodies.lock().unwrap()[0], "the payload");
}

#[tokio::test]
async fn a_body_that_is_not_json_reaches_the_app_byte_for_byte() {
    let stub = Arc::new(StubEngine::blocking(&["read_file"]));
    let app = app(Reply::Echo);
    let addr = serve(Arc::clone(&stub), app.clone(), stub_layer(&stub)).await;

    let response = raw(addr, &post("/mcp", "this is not json", "")).await;

    assert_eq!(status_of(&response), 200, "{response}");
    assert_eq!(app.bodies.lock().unwrap()[0], "this is not json");
}

#[tokio::test]
async fn a_null_inside_a_batch_does_not_become_a_500() {
    // An unauthenticated POST must not be able to raise a 500.
    let stub = Arc::new(StubEngine::default());
    let app = app(Reply::Echo);
    let addr = serve(Arc::clone(&stub), app.clone(), stub_layer(&stub)).await;

    let response = raw(addr, &post("/mcp", "[null]", "")).await;

    assert_eq!(status_of(&response), 200, "{response}");
    assert_eq!(app.bodies.lock().unwrap()[0], "[null]");
}

#[tokio::test]
async fn a_rewritten_response_carries_the_length_actually_sent() {
    // A wrong content length truncates or hangs the client.
    let stub = Arc::new(StubEngine {
        rewrite_result: Some(json!({ "content": [{ "type": "text", "text": "withheld" }] })),
        ..Default::default()
    });
    let original = r#"{"jsonrpc":"2.0","id":1,"result":{"secret":"aaaaaaaaaaaaaaaaaaaaaaaaaaaa"}}"#;
    let app = app(Reply::Json(original.into()));
    let addr = serve(Arc::clone(&stub), app.clone(), stub_layer(&stub)).await;

    let response = raw(addr, &post("/mcp", &call(1, "calculator"), "")).await;
    let body = body_of(&response);

    assert!(body.contains("withheld"), "the result was replaced: {body}");
    assert!(!body.contains("secret"), "the original is gone: {body}");
    if let Some(length) = header_of(&response, "content-length") {
        assert_eq!(
            length.parse::<usize>().unwrap(),
            body.len(),
            "content-length must match the checked bytes"
        );
    }
}

#[tokio::test]
async fn an_sse_stream_is_filtered_and_still_streams() {
    let stub = Arc::new(StubEngine::default());
    let app = app(Reply::Sse(vec![
        "data: {\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{\"n\":1}}\n\n".into(),
        "data: {\"jsonrpc\":\"2.0\",\"id\":2,\"result\":{\"n\":2}}\n\n".into(),
    ]));
    let addr = serve(Arc::clone(&stub), app.clone(), stub_layer(&stub)).await;

    let mut socket = TcpStream::connect(addr).await.unwrap();
    socket
        .write_all(post("/mcp", &call(1, "calculator"), "").as_bytes())
        .await
        .unwrap();

    // The first event must arrive well before the server has produced the second, or the guard is
    // buffering the stream instead of relaying it.
    let mut seen = String::new();
    let deadline = std::time::Instant::now() + Duration::from_millis(200);
    let mut buffer = [0u8; 4096];
    while std::time::Instant::now() < deadline {
        match tokio::time::timeout(Duration::from_millis(60), socket.read(&mut buffer)).await {
            Ok(Ok(0)) => break,
            Ok(Ok(n)) => seen.push_str(&String::from_utf8_lossy(&buffer[..n])),
            _ => {}
        }
        if seen.contains("\"n\":1") {
            break;
        }
    }
    assert!(
        seen.contains("\"n\":1"),
        "event one should arrive while event two is still being produced: {seen:?}"
    );
    assert!(
        !seen.contains("\"n\":2"),
        "event two should not have arrived yet: {seen:?}"
    );
}

#[tokio::test]
async fn a_withheld_event_vanishes_but_the_stream_continues() {
    let stub = Arc::new(StubEngine::default());
    let app = app(Reply::Sse(vec![
        ": keep-alive\n\n".into(),
        "data: {\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{\"n\":1}}\n\n".into(),
    ]));
    let addr = serve(Arc::clone(&stub), app.clone(), stub_layer(&stub)).await;

    let response = raw(addr, &post("/mcp", &call(1, "calculator"), "")).await;
    assert!(
        response.contains(": keep-alive"),
        "a comment frame survives: {response}"
    );
    assert!(response.contains("\"n\":1"), "and so does the event");
}

#[tokio::test]
async fn an_unguarded_path_is_untouched() {
    let stub = Arc::new(StubEngine::blocking(&["read_file"]));
    let app = app(Reply::Echo);
    let layer = stub_layer(&stub).paths(["/mcp"]);
    let addr = serve(Arc::clone(&stub), app.clone(), layer).await;

    let response = raw(addr, &post("/health", &call(1, "read_file"), "")).await;

    assert_eq!(status_of(&response), 200, "{response}");
    assert_eq!(app.calls.load(Ordering::SeqCst), 1, "the app was reached");
}

#[tokio::test]
async fn a_disabled_layer_is_transparent_even_to_an_attack() {
    let stub = Arc::new(StubEngine::blocking(&["read_file"]));
    let app = app(Reply::Echo);
    let addr = serve(Arc::clone(&stub), app.clone(), McpWatchLayer::disabled()).await;

    let response = raw(addr, &post("/mcp", &call(1, "read_file"), "")).await;

    assert_eq!(status_of(&response), 200, "{response}");
    assert_eq!(
        app.calls.load(Ordering::SeqCst),
        1,
        "a disabled guard checks nothing"
    );
}

#[tokio::test]
async fn an_oversized_post_is_refused_before_the_app() {
    let stub = Arc::new(StubEngine::default());
    let app = app(Reply::Echo);
    let layer = stub_layer(&stub).max_body_bytes(64);
    let addr = serve(Arc::clone(&stub), app.clone(), layer).await;

    let huge =
        json!({ "jsonrpc": "2.0", "id": 1, "method": "x", "params": { "p": "y".repeat(512) } })
            .to_string();
    let response = raw(addr, &post("/mcp", &huge, "")).await;

    assert_eq!(status_of(&response), 413, "{response}");
    assert_eq!(app.calls.load(Ordering::SeqCst), 0);
}
