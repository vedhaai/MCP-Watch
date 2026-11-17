//! A tower layer, for axum and anything else that speaks tower.
//!
//! ```no_run
//! # use std::sync::Arc;
//! # fn example(engine: Arc<dyn mcpwatch::Verdicts>) {
//! use axum::body::Body;
//! use mcpwatch::http::tower::{GuardedReqBody, McpWatchLayer};
//!
//! // Your MCP endpoint: `StreamableHttpService` from rmcp, or any tower service.
//! let mcp = tower::service_fn(|_: http::Request<GuardedReqBody<Body>>| async {
//!     Ok::<_, std::convert::Infallible>(http::Response::new(Body::empty()))
//! });
//!
//! let guarded = tower::ServiceBuilder::new()
//!     .map_response(|r: http::Response<_>| r.map(Body::new))
//!     .layer(McpWatchLayer::new(engine))
//!     .service(mcp);
//!
//! let app: axum::Router = axum::Router::new().nest_service("/mcp", guarded);
//! # }
//! ```
//!
//! **The guard must be the innermost layer.** A compression layer applied inside it would hand the
//! guard gzip bytes, which parse as neither JSON nor SSE, and the body would pass through
//! unchecked.

use std::pin::Pin;
use std::sync::Arc;
use std::task::{Context, Poll};

use bytes::Bytes;
use http::{HeaderMap, Request, Response, StatusCode};
use http_body::{Body, Frame};
use http_body_util::{BodyExt, Full, Limited, StreamBody};
use tower_layer::Layer;
use tower_service::Service;

use crate::engine::Verdicts;
use crate::http::{Decision, HttpGuard, Kind, REFUSED_BODY, RequestCheck, ResponseFilter};
use crate::outcome::HttpInfo;

type BoxError = Box<dyn std::error::Error + Send + Sync>;
type BoxFuture<T> = Pin<Box<dyn Future<Output = T> + Send>>;

/// Marks a request a guard has already seen, so two guards never check it twice.
#[derive(Clone, Copy)]
struct Seen;

#[derive(Clone)]
struct Config {
    max_body_bytes: usize,
    encrypted: Option<bool>,
    paths: Vec<String>,
}

/// Wraps an MCP endpoint so every message through it is checked.
///
/// The guard is built when the layer is applied rather than when it is constructed, so that every
/// builder method below actually reaches it. Building it up front meant `paths` quietly did
/// nothing, which is the worst way for a security setting to be wrong.
#[derive(Clone)]
pub struct McpWatchLayer {
    engine: Option<Arc<dyn Verdicts>>,
    config: Config,
}

impl McpWatchLayer {
    pub fn new(engine: Arc<dyn Verdicts>) -> Self {
        Self {
            engine: Some(engine),
            config: Config {
                max_body_bytes: 10_000_000,
                encrypted: None,
                paths: Vec::new(),
            },
        }
    }

    /// A layer that does nothing at all, for when MCPWatch is switched off.
    pub fn disabled() -> Self {
        Self {
            engine: None,
            config: Config {
                max_body_bytes: 10_000_000,
                encrypted: None,
                paths: Vec::new(),
            },
        }
    }

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

    /// Builds the layer from a guard, on or off, in one step.
    pub fn from_watch(watch: &crate::McpWatch) -> Self {
        match watch.engine() {
            Some(engine) => Self::new(Arc::new(engine.clone())),
            None => Self::disabled(),
        }
    }

    /// Only guard these paths. The default is every path the layer sees, which is right when it is
    /// mounted with `nest_service`, since the prefix has already been stripped by then.
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

    /// Whether this listener is TLS.
    ///
    /// Left unset the guard says "we do not know", which is right behind a TLS-terminating proxy:
    /// claiming plain HTTP there would raise MW034 on every session.
    pub fn encrypted(mut self, yes: bool) -> Self {
        self.config.encrypted = Some(yes);
        self
    }
}

impl<S> Layer<S> for McpWatchLayer {
    type Service = McpWatchService<S>;

    fn layer(&self, inner: S) -> Self::Service {
        McpWatchService {
            inner,
            guard: self.build_guard(),
            config: self.config.clone(),
        }
    }
}

/// The guarded endpoint.
#[derive(Clone)]
pub struct McpWatchService<S> {
    inner: S,
    guard: Option<Arc<HttpGuard>>,
    config: Config,
}

/// The request body the application sees.
pub enum GuardedReqBody<B> {
    /// Never read by the guard: anything but a POST keeps its own body untouched.
    Passthrough(B),
    /// A POST body the guard read, and possibly rewrote.
    Buffered(Full<Bytes>),
}

impl<B> Body for GuardedReqBody<B>
where
    B: Body<Data = Bytes> + Unpin,
    B::Error: Into<BoxError>,
{
    type Data = Bytes;
    type Error = BoxError;

    fn poll_frame(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
    ) -> Poll<Option<Result<Frame<Bytes>, Self::Error>>> {
        match self.get_mut() {
            Self::Passthrough(body) => Pin::new(body)
                .poll_frame(cx)
                .map(|o| o.map(|r| r.map_err(Into::into))),
            Self::Buffered(body) => Pin::new(body)
                .poll_frame(cx)
                .map(|o| o.map(|r| r.map_err(|e| match e {}))),
        }
    }

    fn size_hint(&self) -> http_body::SizeHint {
        match self {
            Self::Passthrough(body) => body.size_hint(),
            Self::Buffered(body) => body.size_hint(),
        }
    }

    fn is_end_stream(&self) -> bool {
        match self {
            Self::Passthrough(body) => body.is_end_stream(),
            Self::Buffered(body) => body.is_end_stream(),
        }
    }
}

/// The response body the client sees.
pub enum McpWatchBody<B> {
    /// A refusal, or a JSON body the guard checked whole.
    Fixed(Full<Bytes>),
    /// Neither JSON nor SSE: not ours to judge.
    Raw(B),
    /// An SSE stream, filtered event by event.
    Sse(StreamBody<SseStream>),
}

type SseStream = Pin<Box<dyn futures_util::Stream<Item = Result<Frame<Bytes>, BoxError>> + Send>>;

impl<B> Body for McpWatchBody<B>
where
    B: Body<Data = Bytes> + Unpin,
    B::Error: Into<BoxError>,
{
    type Data = Bytes;
    type Error = BoxError;

    fn poll_frame(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
    ) -> Poll<Option<Result<Frame<Bytes>, Self::Error>>> {
        match self.get_mut() {
            Self::Fixed(body) => Pin::new(body)
                .poll_frame(cx)
                .map(|o| o.map(|r| r.map_err(|e| match e {}))),
            Self::Raw(body) => Pin::new(body)
                .poll_frame(cx)
                .map(|o| o.map(|r| r.map_err(Into::into))),
            Self::Sse(body) => Pin::new(body).poll_frame(cx),
        }
    }

    fn size_hint(&self) -> http_body::SizeHint {
        match self {
            Self::Fixed(body) => body.size_hint(),
            Self::Raw(body) => body.size_hint(),
            // A filtered stream's length is not the inner one's.
            Self::Sse(_) => http_body::SizeHint::default(),
        }
    }
}

/// Runs `finished` when the response body is done, or when the client hangs up mid-stream.
struct Finish {
    guard: Arc<HttpGuard>,
    check: RequestCheck,
}

impl Drop for Finish {
    fn drop(&mut self) {
        self.guard.finished(&self.check);
    }
}

impl<S, B, ResB> Service<Request<B>> for McpWatchService<S>
where
    S: Service<Request<GuardedReqBody<B>>, Response = Response<ResB>> + Clone + Send + 'static,
    S::Future: Send + 'static,
    S::Error: Send + 'static,
    B: Body<Data = Bytes> + Send + Unpin + 'static,
    B::Error: Into<BoxError> + Send,
    ResB: Body<Data = Bytes> + Send + Unpin + 'static,
    ResB::Error: Into<BoxError> + Send,
{
    type Response = Response<McpWatchBody<ResB>>;
    // The guard never invents an error kind: everything it refuses is an HTTP response. A tower
    // error here would abort the connection and tell the client nothing.
    type Error = S::Error;
    type Future = BoxFuture<Result<Self::Response, S::Error>>;

    fn poll_ready(&mut self, cx: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
        self.inner.poll_ready(cx)
    }

    fn call(&mut self, mut request: Request<B>) -> Self::Future {
        // `self.inner` is the copy that was polled ready; a fresh clone has no reserved permit and
        // would panic or deadlock behind a Buffer or ConcurrencyLimit.
        let not_ready = self.inner.clone();
        let mut inner = std::mem::replace(&mut self.inner, not_ready);

        let Some(guard) = self.guard.clone() else {
            return Box::pin(async move {
                Ok(inner
                    .call(request.map(GuardedReqBody::Passthrough))
                    .await?
                    .map(McpWatchBody::Raw))
            });
        };

        let path = request.uri().path().to_string();
        let already_seen = request.extensions().get::<Seen>().is_some();
        if already_seen || !guard.matches(&path) {
            return Box::pin(async move {
                Ok(inner
                    .call(request.map(GuardedReqBody::Passthrough))
                    .await?
                    .map(McpWatchBody::Raw))
            });
        }
        request.extensions_mut().insert(Seen);

        let config = self.config.clone();
        Box::pin(async move {
            let mut http = HttpInfo::from_headers(
                request
                    .headers()
                    .iter()
                    .filter_map(|(k, v)| v.to_str().ok().map(|v| (k.as_str(), v))),
            );
            http.encrypted = config.encrypted;
            http.remote_address = remote_address(&request);

            let method = request.method().as_str().to_string();
            let is_post = method.eq_ignore_ascii_case("POST");

            // Only a POST body is read. Touching any other body would hand the application an
            // empty stream.
            let (parts, body) = request.into_parts();
            let (body, bytes) = if is_post {
                match Limited::new(body, config.max_body_bytes).collect().await {
                    Ok(collected) => {
                        let bytes = collected.to_bytes();
                        (None, bytes)
                    }
                    Err(_) => {
                        return Ok(too_large());
                    }
                }
            } else {
                (Some(body), Bytes::new())
            };

            let mut check = guard.check_request(&method, &http, &bytes).await;
            match std::mem::replace(&mut check.decision, Decision::Pass { rewritten: None }) {
                Decision::Refuse => Ok(refused()),
                Decision::Reply(reply) => Ok(replied(reply)),
                Decision::Pass { rewritten } => {
                    let request = match body {
                        Some(body) => Request::from_parts(parts, GuardedReqBody::Passthrough(body)),
                        None => {
                            let mut parts = parts;
                            let bytes = rewritten.map(Bytes::from).unwrap_or(bytes);
                            // The application must be told the length it is actually getting.
                            set_length(&mut parts.headers, bytes.len());
                            Request::from_parts(parts, GuardedReqBody::Buffered(Full::new(bytes)))
                        }
                    };

                    let response = inner.call(request).await?;
                    Ok(filter_response(guard, check, response, config).await)
                }
            }
        })
    }
}

/// Checks the application's response on its way back out.
async fn filter_response<ResB>(
    guard: Arc<HttpGuard>,
    mut check: RequestCheck,
    response: Response<ResB>,
    config: Config,
) -> Response<McpWatchBody<ResB>>
where
    ResB: Body<Data = Bytes> + Send + Unpin + 'static,
    ResB::Error: Into<BoxError> + Send,
{
    let (mut parts, body) = response.into_parts();
    let headers = HttpInfo::from_headers(
        parts
            .headers
            .iter()
            .filter_map(|(k, v)| v.to_str().ok().map(|v| (k.as_str(), v))),
    );
    let mut filter = guard.response(&mut check, &headers);
    let finish = Finish {
        guard: Arc::clone(&guard),
        check,
    };

    match filter.kind() {
        Kind::Raw => {
            drop(finish);
            Response::from_parts(parts, McpWatchBody::Raw(body))
        }
        Kind::Json => {
            let collected = match Limited::new(body, config.max_body_bytes).collect().await {
                Ok(collected) => collected.to_bytes(),
                Err(_) => {
                    // The original bytes are gone by now, so passing something unchecked is not an
                    // option. Refusing is the right direction to fail in.
                    drop(finish);
                    log::warn!("[mcpwatch] a response was too large to check");
                    return oversized_response();
                }
            };
            let checked = filter.json(&collected).await;
            drop(finish);
            set_length(&mut parts.headers, checked.len());
            Response::from_parts(parts, McpWatchBody::Fixed(Full::new(Bytes::from(checked))))
        }
        Kind::Sse => {
            // A filtered stream is not the length the application claimed.
            parts.headers.remove(http::header::CONTENT_LENGTH);
            let stream = sse_stream(body, filter, finish);
            Response::from_parts(parts, McpWatchBody::Sse(StreamBody::new(stream)))
        }
    }
}

/// Filters an SSE body, writing each event as soon as it is complete.
fn sse_stream<ResB>(body: ResB, filter: ResponseFilter, finish: Finish) -> SseStream
where
    ResB: Body<Data = Bytes> + Send + Unpin + 'static,
    ResB::Error: Into<BoxError> + Send,
{
    struct State<ResB> {
        body: ResB,
        filter: ResponseFilter,
        finish: Option<Finish>,
        done: bool,
    }

    let state = State {
        body,
        filter,
        finish: Some(finish),
        done: false,
    };

    Box::pin(futures_util::stream::unfold(
        state,
        |mut state| async move {
            if state.done {
                return None;
            }
            loop {
                match state.body.frame().await {
                    Some(Ok(frame)) => match frame.into_data() {
                        Ok(chunk) => match state.filter.feed(&chunk).await {
                            Ok(out) if out.is_empty() => continue,
                            // A zero-length chunk is the terminal chunk on the wire, so an empty
                            // result must never be yielded as one.
                            Ok(out) => return Some((Ok(Frame::data(Bytes::from(out))), state)),
                            Err(e) => {
                                state.done = true;
                                let error: BoxError = Box::new(e);
                                return Some((Err(error), state));
                            }
                        },
                        // Trailers: flush whatever is left, then pass them on.
                        Err(frame) => {
                            state.done = true;
                            let rest = state.filter.end().await;
                            state.finish.take();
                            if !rest.is_empty() {
                                return Some((Ok(Frame::data(Bytes::from(rest))), state));
                            }
                            return Some((Ok(frame), state));
                        }
                    },
                    Some(Err(e)) => {
                        state.done = true;
                        state.finish.take();
                        return Some((Err(e.into()), state));
                    }
                    None => {
                        state.done = true;
                        let rest = state.filter.end().await;
                        state.finish.take();
                        if !rest.is_empty() {
                            return Some((Ok(Frame::data(Bytes::from(rest))), state));
                        }
                        return None;
                    }
                }
            }
        },
    ))
}

fn remote_address<B>(request: &Request<B>) -> Option<String> {
    request
        .extensions()
        .get::<std::net::SocketAddr>()
        .map(|a| a.ip().to_string())
}

fn set_length(headers: &mut HeaderMap, length: usize) {
    headers.remove(http::header::TRANSFER_ENCODING);
    if let Ok(value) = http::HeaderValue::from_str(&length.to_string()) {
        headers.insert(http::header::CONTENT_LENGTH, value);
    }
}

fn text<B>(status: StatusCode, body: &'static str) -> Response<McpWatchBody<B>> {
    let mut response = Response::new(McpWatchBody::<B>::Fixed(Full::new(Bytes::from_static(
        body.as_bytes(),
    ))));
    *response.status_mut() = status;
    response.headers_mut().insert(
        http::header::CONTENT_TYPE,
        http::HeaderValue::from_static("text/plain; charset=utf-8"),
    );
    set_length(response.headers_mut(), body.len());
    response
}

fn refused<B>() -> Response<McpWatchBody<B>> {
    text(StatusCode::FORBIDDEN, REFUSED_BODY)
}

fn too_large<B>() -> Response<McpWatchBody<B>> {
    text(
        StatusCode::PAYLOAD_TOO_LARGE,
        "Request too large for MCPWatch",
    )
}

fn oversized_response<B>() -> Response<McpWatchBody<B>> {
    text(
        StatusCode::BAD_GATEWAY,
        "MCPWatch could not check an oversized response",
    )
}

/// A JSON-RPC error travels in a 200: the HTTP request succeeded, the call did not.
fn replied<B>(reply: Vec<u8>) -> Response<McpWatchBody<B>> {
    let length = reply.len();
    let mut response = Response::new(McpWatchBody::Fixed(Full::new(Bytes::from(reply))));
    response.headers_mut().insert(
        http::header::CONTENT_TYPE,
        http::HeaderValue::from_static("application/json"),
    );
    set_length(response.headers_mut(), length);
    response
}
