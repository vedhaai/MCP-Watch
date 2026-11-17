//! The actix-web middleware, over the same guard the tower layer uses.
//!
//! These mirror the tower suite case for case, because the two adapters must behave identically —
//! the whole point of the framework-free core is that there is only one set of rules to get wrong.

#![cfg(feature = "actix")]

mod common;

use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use actix_web::{App, HttpResponse, test, web};
use common::StubEngine;
use mcpwatch::Verdicts;
use mcpwatch::http::actix::McpWatch;
use serde_json::{Value, json};

fn call(id: i64, tool: &str) -> String {
    json!({
        "jsonrpc": "2.0", "id": id, "method": "tools/call",
        "params": { "name": tool, "arguments": {} }
    })
    .to_string()
}

#[actix_web::test]
async fn a_blocked_call_is_answered_and_never_reaches_the_app() {
    let stub = Arc::new(StubEngine::blocking(&["read_file"]));
    let calls = Arc::new(AtomicUsize::new(0));
    let seen = Arc::clone(&calls);

    let app = test::init_service(
        App::new()
            .wrap(McpWatch::new(Arc::clone(&stub) as Arc<dyn Verdicts>))
            .route(
                "/mcp",
                web::post().to(move || {
                    let seen = Arc::clone(&seen);
                    async move {
                        seen.fetch_add(1, Ordering::SeqCst);
                        HttpResponse::Ok()
                            .content_type("application/json")
                            .body(r#"{"jsonrpc":"2.0","id":1,"result":{}}"#)
                    }
                }),
            ),
    )
    .await;

    let request = test::TestRequest::post()
        .uri("/mcp")
        .insert_header(("content-type", "application/json"))
        .set_payload(call(1, "read_file"))
        .to_request();
    let response = test::call_service(&app, request).await;

    // A JSON-RPC error travels in a 200.
    assert_eq!(response.status(), 200);
    let body: Value = serde_json::from_slice(&test::read_body(response).await).unwrap();
    assert_eq!(body["error"]["code"], json!(mcpwatch::BLOCKED));
    assert_eq!(
        calls.load(Ordering::SeqCst),
        0,
        "the application must never see a blocked call"
    );
}

#[actix_web::test]
async fn an_ordinary_call_reaches_the_app() {
    let stub = Arc::new(StubEngine::default());
    let calls = Arc::new(AtomicUsize::new(0));
    let seen = Arc::clone(&calls);

    let app = test::init_service(
        App::new()
            .wrap(McpWatch::new(Arc::clone(&stub) as Arc<dyn Verdicts>))
            .route(
                "/mcp",
                web::post().to(move || {
                    let seen = Arc::clone(&seen);
                    async move {
                        seen.fetch_add(1, Ordering::SeqCst);
                        HttpResponse::Ok()
                            .content_type("application/json")
                            .body(r#"{"jsonrpc":"2.0","id":1,"result":{"ok":true}}"#)
                    }
                }),
            ),
    )
    .await;

    let request = test::TestRequest::post()
        .uri("/mcp")
        .insert_header(("content-type", "application/json"))
        .set_payload(call(1, "calculator"))
        .to_request();
    let response = test::call_service(&app, request).await;

    assert_eq!(response.status(), 200);
    let body: Value = serde_json::from_slice(&test::read_body(response).await).unwrap();
    assert_eq!(body["result"]["ok"], json!(true));
    assert_eq!(calls.load(Ordering::SeqCst), 1);
}

#[actix_web::test]
async fn a_refused_transport_check_is_403() {
    let stub = Arc::new(StubEngine {
        refuse_http: true,
        ..Default::default()
    });
    let calls = Arc::new(AtomicUsize::new(0));
    let seen = Arc::clone(&calls);

    let app = test::init_service(
        App::new()
            .wrap(McpWatch::new(Arc::clone(&stub) as Arc<dyn Verdicts>))
            .route(
                "/mcp",
                web::get().to(move || {
                    let seen = Arc::clone(&seen);
                    async move {
                        seen.fetch_add(1, Ordering::SeqCst);
                        HttpResponse::Ok().body("")
                    }
                }),
            ),
    )
    .await;

    let request = test::TestRequest::get()
        .uri("/mcp")
        .insert_header(("origin", "https://evil.example"))
        .to_request();
    let response = test::call_service(&app, request).await;

    assert_eq!(response.status(), 403);
    assert_eq!(
        test::read_body(response).await.as_ref(),
        b"Refused by MCPWatch"
    );
    assert_eq!(calls.load(Ordering::SeqCst), 0);
}

#[actix_web::test]
async fn a_put_body_is_never_eaten() {
    // actix gives no way to un-take a payload, so a non-POST body must never be touched at all.
    let stub = Arc::new(StubEngine::default());
    let app = test::init_service(
        App::new()
            .wrap(McpWatch::new(Arc::clone(&stub) as Arc<dyn Verdicts>))
            .route(
                "/mcp",
                web::put().to(|body: web::Bytes| async move {
                    HttpResponse::Ok().content_type("text/plain").body(body)
                }),
            ),
    )
    .await;

    let request = test::TestRequest::put()
        .uri("/mcp")
        .set_payload("the payload")
        .to_request();
    let response = test::call_service(&app, request).await;

    assert_eq!(response.status(), 200);
    assert_eq!(test::read_body(response).await.as_ref(), b"the payload");
}

#[actix_web::test]
async fn a_body_that_is_not_json_reaches_the_app_byte_for_byte() {
    let stub = Arc::new(StubEngine::blocking(&["read_file"]));
    let app = test::init_service(
        App::new()
            .wrap(McpWatch::new(Arc::clone(&stub) as Arc<dyn Verdicts>))
            .route(
                "/mcp",
                web::post().to(|body: web::Bytes| async move {
                    HttpResponse::Ok().content_type("text/plain").body(body)
                }),
            ),
    )
    .await;

    let request = test::TestRequest::post()
        .uri("/mcp")
        .set_payload("this is not json")
        .to_request();
    let response = test::call_service(&app, request).await;

    assert_eq!(
        test::read_body(response).await.as_ref(),
        b"this is not json"
    );
}

#[actix_web::test]
async fn a_rewritten_response_reaches_the_client() {
    let stub = Arc::new(StubEngine {
        rewrite_result: Some(json!({ "content": [{ "type": "text", "text": "withheld" }] })),
        ..Default::default()
    });
    let app = test::init_service(
        App::new()
            .wrap(McpWatch::new(Arc::clone(&stub) as Arc<dyn Verdicts>))
            .route(
                "/mcp",
                web::post().to(|| async {
                    HttpResponse::Ok()
                        .content_type("application/json")
                        .body(r#"{"jsonrpc":"2.0","id":1,"result":{"secret":"xyzzy"}}"#)
                }),
            ),
    )
    .await;

    let request = test::TestRequest::post()
        .uri("/mcp")
        .insert_header(("content-type", "application/json"))
        .set_payload(call(1, "calculator"))
        .to_request();
    let response = test::call_service(&app, request).await;
    let body = test::read_body(response).await;
    let text = String::from_utf8_lossy(&body);

    assert!(text.contains("withheld"), "the result was replaced: {text}");
    assert!(!text.contains("xyzzy"), "the original is gone: {text}");
}

#[actix_web::test]
async fn a_disabled_middleware_is_transparent_even_to_an_attack() {
    let calls = Arc::new(AtomicUsize::new(0));
    let seen = Arc::clone(&calls);

    let app = test::init_service(App::new().wrap(McpWatch::disabled()).route(
        "/mcp",
        web::post().to(move || {
            let seen = Arc::clone(&seen);
            async move {
                seen.fetch_add(1, Ordering::SeqCst);
                HttpResponse::Ok().body("")
            }
        }),
    ))
    .await;

    let request = test::TestRequest::post()
        .uri("/mcp")
        .set_payload(call(1, "read_file"))
        .to_request();
    let response = test::call_service(&app, request).await;

    assert_eq!(response.status(), 200);
    assert_eq!(calls.load(Ordering::SeqCst), 1);
}

#[actix_web::test]
async fn an_unguarded_path_is_untouched() {
    let stub = Arc::new(StubEngine::blocking(&["read_file"]));
    let calls = Arc::new(AtomicUsize::new(0));
    let seen = Arc::clone(&calls);

    let app = test::init_service(
        App::new()
            .wrap(McpWatch::new(Arc::clone(&stub) as Arc<dyn Verdicts>).paths(["/mcp"]))
            .route(
                "/health",
                web::post().to(move || {
                    let seen = Arc::clone(&seen);
                    async move {
                        seen.fetch_add(1, Ordering::SeqCst);
                        HttpResponse::Ok().body("ok")
                    }
                }),
            ),
    )
    .await;

    let request = test::TestRequest::post()
        .uri("/health")
        .set_payload(call(1, "read_file"))
        .to_request();
    let response = test::call_service(&app, request).await;

    assert_eq!(response.status(), 200);
    assert_eq!(calls.load(Ordering::SeqCst), 1, "the app was reached");
}
