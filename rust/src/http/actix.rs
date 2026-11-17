//! actix-web middleware, over the same framework-free guard the tower layer uses.
//!
//! ```no_run
//! # use std::sync::Arc;
//! # fn example(engine: Arc<dyn mcpwatch::Verdicts>) {
//! use actix_web::{App, web};
//! use mcpwatch::http::actix::McpWatch;
//!
//! let app = App::new()
//!     .wrap(McpWatch::new(engine))
//!     .route("/mcp", web::post().to(|| async { "" }));
//! # }
//! ```
//!
//! **The guard must be the innermost middleware.** `actix_web::middleware::Compress` registered
//! inside it would hand the guard gzip bytes, which parse as neither JSON nor SSE.
//!
//! One thing this adapter cannot do that [`crate::sdk`] can: when the guard refuses a request the
//! *server* sent (`sampling/createMessage`, `elicitation/create`), there is no way to answer the
//! server from inside a response filter, so the message is dropped and logged and the server sees
//! it time out. A server that sends those should be guarded at its transport instead.

use std::future::{Ready, ready};
use std::rc::Rc;
use std::sync::Arc;

use actix_web::body::{BodyStream, BoxBody, EitherBody, MessageBody, to_bytes};
use actix_web::dev::{Service, ServiceRequest, ServiceResponse, Transform};
use actix_web::http::StatusCode;
use actix_web::{Error, HttpMessage, HttpResponse};
use bytes::{Bytes, BytesMut};
use futures_util::StreamExt;
use futures_util::future::LocalBoxFuture;

use crate::engine::Verdicts;
use crate::http::{Decision, HttpGuard, Kind, REFUSED_BODY};
use crate::outcome::HttpInfo;

#[derive(Clone)]
struct Config {
    max_body_bytes: usize,
    paths: Vec<String>,
}

/// Wraps an actix-web application so every MCP message through it is checked.
#[derive(Clone)]
pub struct McpWatch {
    engine: Option<Arc<dyn Verdicts>>,
    config: Config,
}

impl McpWatch {
    pub fn new(engine: Arc<dyn Verdicts>) -> Self {
        Self {
            engine: Some(engine),
            config: Config {
                max_body_bytes: 10_000_000,
                paths: Vec::new(),
            },
        }
    }

    /// Middleware that does nothing at all, for when MCPWatch is switched off.
    pub fn disabled() -> Self {
        Self {
            engine: None,
            config: Config {
                max_body_bytes: 10_000_000,
                paths: Vec::new(),
            },
        }
    }

    /// Builds the middleware from a guard, on or off, in one step.
    pub fn from_watch(watch: &crate::McpWatch) -> Self {
        match watch.engine() {
            Some(engine) => Self::new(Arc::new(engine.clone())),
            None => Self::disabled(),
        }
    }

    /// Only guard these paths. The default is every path.
    pub fn paths<I, S>(mut self, paths: I) -> Self
    where
        I: IntoIterator<Item = S>,
        S: Into<String>,
    {
        self.config.paths = paths.into_iter().map(Into::into).collect();
        self
    }

    pub fn max_body_bytes(mut self, bytes: usize) -> Self {
        self.config.max_body_bytes = bytes;
        self
    }

    /// Built here rather than in the constructor, so every builder method above reaches it.
    fn build_guard(&self) -> Option<Arc<HttpGuard>> {
        let engine = self.engine.clone()?;
        let paths: Vec<String> = if self.config.paths.is_empty() {
            vec!["*".to_string()]
        } else {
            self.config.paths.clone()
        };
        Some(Arc::new(
            HttpGuard::new(engine, paths).max_body_bytes(self.config.max_body_bytes),
        ))
    }
}

impl<S, B> Transform<S, ServiceRequest> for McpWatch
where
    S: Service<ServiceRequest, Response = ServiceResponse<B>, Error = Error> + 'static,
    B: MessageBody + 'static,
{
    type Response = ServiceResponse<EitherBody<BoxBody, B>>;
    type Error = Error;
    type Transform = McpWatchMiddleware<S>;
    type InitError = ();
    type Future = Ready<Result<Self::Transform, Self::InitError>>;

    fn new_transform(&self, service: S) -> Self::Future {
        ready(Ok(McpWatchMiddleware {
            service: Rc::new(service),
            guard: self.build_guard(),
            config: self.config.clone(),
        }))
    }
}

/// The guarded application.
pub struct McpWatchMiddleware<S> {
    service: Rc<S>,
    guard: Option<Arc<HttpGuard>>,
    config: Config,
}

impl<S, B> Service<ServiceRequest> for McpWatchMiddleware<S>
where
    S: Service<ServiceRequest, Response = ServiceResponse<B>, Error = Error> + 'static,
    B: MessageBody + 'static,
{
    type Response = ServiceResponse<EitherBody<BoxBody, B>>;
    type Error = Error;
    type Future = LocalBoxFuture<'static, Result<Self::Response, Self::Error>>;

    actix_web::dev::forward_ready!(service);

    fn call(&self, mut request: ServiceRequest) -> Self::Future {
        let service = Rc::clone(&self.service);
        let Some(guard) = self.guard.clone() else {
            return Box::pin(async move { Ok(service.call(request).await?.map_into_right_body()) });
        };
        if !guard.matches(request.path()) {
            return Box::pin(async move { Ok(service.call(request).await?.map_into_right_body()) });
        }
        let max_body_bytes = self.config.max_body_bytes;

        Box::pin(async move {
            let mut http = HttpInfo::from_headers(
                request
                    .headers()
                    .iter()
                    .filter_map(|(k, v)| v.to_str().ok().map(|v| (k.as_str(), v))),
            );
            http.remote_address = request.peer_addr().map(|a| a.ip().to_string());
            // The listener's own TLS state, not `connection_info().scheme()`, which trusts
            // spoofable forwarding headers. The engine weighs `x-forwarded-proto` itself.
            http.encrypted = Some(request.app_config().secure());

            let method = request.method().as_str().to_string();
            let is_post = method.eq_ignore_ascii_case("POST");

            // Only a POST body is read. actix gives no way to un-take a payload, so touching any
            // other method's body would hand the application an empty stream for good.
            let body = if is_post {
                match read_payload(&mut request, max_body_bytes).await {
                    Ok(bytes) => bytes,
                    Err(response) => {
                        return Ok(request.into_response(*response).map_into_left_body());
                    }
                }
            } else {
                Bytes::new()
            };

            let mut check = guard.check_request(&method, &http, &body).await;
            let decision =
                std::mem::replace(&mut check.decision, Decision::Pass { rewritten: None });

            let forwarded = match decision {
                Decision::Refuse => {
                    let response = HttpResponse::Forbidden()
                        .content_type("text/plain; charset=utf-8")
                        .body(REFUSED_BODY);
                    return Ok(request.into_response(response).map_into_left_body());
                }
                Decision::Reply(reply) => {
                    // A JSON-RPC error travels in a 200: the HTTP request succeeded, the call did
                    // not.
                    let response = HttpResponse::Ok()
                        .content_type("application/json")
                        .body(reply);
                    return Ok(request.into_response(response).map_into_left_body());
                }
                Decision::Pass { rewritten } => rewritten.map(Bytes::from).unwrap_or(body),
            };

            if is_post {
                restore_payload(&mut request, forwarded);
            }

            let response = service.call(request).await?;
            let (request, response) = response.into_parts();
            let (response, body) = response.into_parts();

            let headers = HttpInfo::from_headers(
                response
                    .headers()
                    .iter()
                    .filter_map(|(k, v)| v.to_str().ok().map(|v| (k.as_str(), v))),
            );
            let mut filter = guard.response(&mut check, &headers);

            let checked = match filter.kind() {
                Kind::Raw => {
                    guard.finished(&check);
                    return Ok(ServiceResponse::new(request, response.set_body(body))
                        .map_into_right_body());
                }
                Kind::Json => {
                    let collected = match to_bytes(body).await {
                        Ok(bytes) => bytes,
                        Err(_) => {
                            guard.finished(&check);
                            log::warn!("[mcpwatch] a response body could not be read");
                            let refusal = HttpResponse::build(StatusCode::BAD_GATEWAY)
                                .content_type("text/plain; charset=utf-8")
                                .body("MCPWatch could not check the response");
                            return Ok(ServiceResponse::new(request, refusal).map_into_left_body());
                        }
                    };
                    let checked = filter.json(&collected).await;
                    guard.finished(&check);
                    // actix derives Content-Length from the body's own size, so handing it the
                    // checked bytes is all that is needed.
                    Bytes::from(checked)
                }
                Kind::Sse => {
                    let stream = sse_stream(body, filter, Arc::clone(&guard), check);
                    let response = response.set_body(BoxBody::new(BodyStream::new(stream)));
                    return Ok(ServiceResponse::new(request, response).map_into_left_body());
                }
            };

            Ok(
                ServiceResponse::new(request, response.set_body(BoxBody::new(checked)))
                    .map_into_left_body(),
            )
        })
    }
}

/// Reads a POST body, refusing one that is too large rather than buffering it.
async fn read_payload(
    request: &mut ServiceRequest,
    max_bytes: usize,
) -> Result<Bytes, Box<HttpResponse>> {
    let mut payload = request.take_payload();
    let mut bytes = BytesMut::new();
    while let Some(chunk) = payload.next().await {
        let Ok(chunk) = chunk else {
            return Err(Box::new(
                HttpResponse::BadRequest()
                    .content_type("text/plain; charset=utf-8")
                    .body("MCPWatch could not read the request body"),
            ));
        };
        if bytes.len() + chunk.len() > max_bytes {
            return Err(Box::new(
                HttpResponse::build(StatusCode::PAYLOAD_TOO_LARGE)
                    .content_type("text/plain; charset=utf-8")
                    .body("Request too large for MCPWatch"),
            ));
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes.freeze())
}

/// Gives the application back a readable body, which is the only way after `take_payload`.
fn restore_payload(request: &mut ServiceRequest, body: Bytes) {
    let (_, mut payload) = actix_http::h1::Payload::create(true);
    payload.unread_data(body);
    request.set_payload(payload.into());
}

/// Filters an SSE body, writing each event as soon as it is complete.
fn sse_stream<B>(
    body: B,
    filter: crate::http::ResponseFilter,
    guard: Arc<HttpGuard>,
    check: crate::http::RequestCheck,
) -> impl futures_util::Stream<Item = Result<Bytes, Box<dyn std::error::Error>>>
where
    B: MessageBody + 'static,
{
    struct State<B> {
        body: std::pin::Pin<Box<B>>,
        filter: crate::http::ResponseFilter,
        guard: Arc<HttpGuard>,
        check: Option<crate::http::RequestCheck>,
        done: bool,
    }

    let state = State {
        body: Box::pin(body),
        filter,
        guard,
        check: Some(check),
        done: false,
    };

    futures_util::stream::unfold(state, |mut state| async move {
        if state.done {
            return None;
        }
        loop {
            match futures_util::future::poll_fn(|cx| state.body.as_mut().poll_next(cx)).await {
                Some(Ok(chunk)) => match state.filter.feed(&chunk).await {
                    // A zero-length chunk is the terminal chunk on the wire, so an empty result
                    // must never be yielded as one.
                    Ok(out) if out.is_empty() => continue,
                    Ok(out) => return Some((Ok(Bytes::from(out)), state)),
                    Err(e) => {
                        state.done = true;
                        finish(&mut state.guard, &mut state.check);
                        let error: Box<dyn std::error::Error> = Box::new(e);
                        return Some((Err(error), state));
                    }
                },
                Some(Err(_)) => {
                    state.done = true;
                    finish(&mut state.guard, &mut state.check);
                    return None;
                }
                None => {
                    state.done = true;
                    let rest = state.filter.end().await;
                    finish(&mut state.guard, &mut state.check);
                    if !rest.is_empty() {
                        return Some((Ok(Bytes::from(rest)), state));
                    }
                    return None;
                }
            }
        }
    })
}

fn finish(guard: &mut Arc<HttpGuard>, check: &mut Option<crate::http::RequestCheck>) {
    if let Some(check) = check.take() {
        guard.finished(&check);
    }
}
