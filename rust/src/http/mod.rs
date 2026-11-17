//! Guarding MCP over HTTP (Streamable HTTP and SSE), whatever the web framework.
//!
//! This module names no framework type at all, so the tower layer and the actix-web middleware
//! share one implementation and one test suite. It is a port of the Node HTTP proxy, as the Python
//! and Java adapters are: the POST body carries client messages, and the response is either JSON or
//! an SSE stream of server messages.

mod sse;

#[cfg(feature = "tower")]
#[cfg_attr(docsrs, doc(cfg(feature = "tower")))]
pub mod tower;

#[cfg(feature = "actix")]
#[cfg_attr(docsrs, doc(cfg(feature = "actix")))]
pub mod actix;

use std::sync::Arc;

use serde_json::Value;

use crate::engine::Verdicts;
use crate::outcome::{BLOCKED, HttpInfo, error_reply};

use sse::SseFilter;
pub use sse::SseOverflow;

/// The body the guard refuses a request with.
pub const REFUSED_BODY: &str = "Refused by MCPWatch";

/// What the adapter must do with a request.
#[derive(Debug, Clone, PartialEq)]
pub enum Decision {
    /// 403 `text/plain`, body [`REFUSED_BODY`]. The application is never called.
    Refuse,
    /// 200 `application/json` with these bytes. The application is never called.
    ///
    /// A JSON-RPC error travels in a 200: the HTTP request succeeded, the call did not.
    Reply(Vec<u8>),
    /// Carry on. `rewritten` is `Some` only when the guard changed the body; `None` means hand the
    /// application exactly the bytes that arrived.
    Pass { rewritten: Option<Vec<u8>> },
}

/// What the guard learned about one request, carried through to its response.
#[derive(Debug, Clone)]
pub struct RequestCheck {
    session: String,
    strict: bool,
    method: String,
    pub decision: Decision,
}

impl RequestCheck {
    pub fn session(&self) -> &str {
        &self.session
    }

    /// True when the request carried an `Mcp-Session-Id`.
    ///
    /// Such a request is one the guard can hold to account: a server message answering nothing the
    /// client asked for is forged (MW037). An in-process guard is never strict, because there is no
    /// forgeable channel inside the process.
    pub fn strict(&self) -> bool {
        self.strict
    }

    pub fn method(&self) -> &str {
        &self.method
    }
}

/// Which of the three shapes a response body is.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Json,
    Sse,
    Raw,
}

/// Decides what happens to MCP traffic over HTTP.
pub struct HttpGuard {
    engine: Arc<dyn Verdicts>,
    paths: Vec<String>,
    max_body_bytes: usize,
}

impl HttpGuard {
    /// Guards the given paths. An empty list, or `*`, guards every path.
    pub fn new<I, S>(engine: Arc<dyn Verdicts>, paths: I) -> Self
    where
        I: IntoIterator<Item = S>,
        S: Into<String>,
    {
        let paths: Vec<String> = paths.into_iter().map(Into::into).collect();
        Self {
            engine: engine.clone(),
            paths: if paths.iter().any(|p| p == "*") {
                Vec::new()
            } else {
                paths.into_iter().map(|p| trim_slash(&p)).collect()
            },
            max_body_bytes: 10_000_000,
        }
    }

    pub fn max_body_bytes(mut self, bytes: usize) -> Self {
        self.max_body_bytes = bytes;
        self
    }

    /// `/mcp` guards /mcp and anything under it; an empty list or `*` guards every path.
    pub fn matches(&self, path: &str) -> bool {
        if self.paths.is_empty() {
            return true;
        }
        let path = trim_slash(path);
        self.paths.iter().any(|prefix| {
            prefix == "/" || path == *prefix || path.starts_with(&format!("{prefix}/"))
        })
    }

    /// Checks a request before the application sees it: the transport rules for every method, and
    /// every client message in a POST body.
    pub async fn check_request(&self, method: &str, http: &HttpInfo, body: &[u8]) -> RequestCheck {
        let header = http.get("mcp-session-id");
        // All four adapters treat an *empty* session header as absent for naming, while `strict`
        // follows the header's presence. Kept verbatim so the languages agree bit for bit.
        let session = match header {
            Some(id) if !id.is_empty() => id.to_string(),
            _ => format!(
                "http-{}",
                http.remote_address.as_deref().unwrap_or("unknown")
            ),
        };
        let method = method.to_ascii_uppercase();
        let mut check = RequestCheck {
            session,
            strict: header.is_some(),
            method: method.clone(),
            decision: Decision::Pass { rewritten: None },
        };

        if method != "POST" {
            if self.engine.from_http(&check.session, http, &method).await {
                check.decision = Decision::Refuse;
            }
            return check;
        }

        let Ok(parsed) = serde_json::from_slice::<Value>(body) else {
            // Not JSON: not ours to judge. The application's own parser can reject it.
            return check;
        };

        let batch = parsed.is_array();
        let messages: Vec<Value> = match &parsed {
            Value::Array(items) => items.clone(),
            other => vec![other.clone()],
        };

        let mut forwards: Vec<Value> = Vec::with_capacity(messages.len());
        let mut replies: Vec<Value> = Vec::new();
        for message in &messages {
            if !message.is_object() {
                // A null or a bare number in a batch. The rules get no say on it, so keep it
                // exactly as it came: dropping it, or writing a null in its place, would rewrite a
                // client's batch into something it never sent.
                forwards.push(message.clone());
                continue;
            }
            let outcome = self
                .engine
                .from_client(&check.session, message.clone(), Some(http))
                .await;
            if let Some(reply) = outcome.reply {
                replies.push(reply);
            }
            if let Some(forward) = outcome.forward.into_message() {
                forwards.push(forward);
            }
        }

        if !replies.is_empty() {
            check.decision = Decision::Reply(self.refusal(&messages, &replies, batch));
            return check;
        }
        if forwards != messages {
            let out = if batch {
                Value::Array(forwards)
            } else {
                forwards
                    .into_iter()
                    .next()
                    .unwrap_or(Value::Object(Default::default()))
            };
            check.decision = Decision::Pass {
                rewritten: Some(serde_json::to_vec(&out).unwrap_or_default()),
            };
        }
        check
    }

    /// Answers blocked calls ourselves.
    ///
    /// In a batch the rest are refused too, so nothing is left waiting for a reply the application
    /// will never produce. Entries with no id get no answer, because nothing is waiting on them.
    fn refusal(&self, messages: &[Value], replies: &[Value], batch: bool) -> Vec<u8> {
        if !batch {
            return serde_json::to_vec(&replies[0]).unwrap_or_default();
        }
        let mut out: Vec<Value> = Vec::new();
        for message in messages {
            let Some(id) = message.get("id") else {
                continue;
            };
            if id.is_null() {
                continue;
            }
            let own = replies.iter().find(|r| r.get("id") == Some(id));
            out.push(match own {
                Some(reply) => reply.clone(),
                None => error_reply(id, BLOCKED, "Batch refused by MCPWatch"),
            });
        }
        serde_json::to_vec(&Value::Array(out)).unwrap_or_default()
    }

    /// Call once the application has started its response.
    ///
    /// A session id first handed out here is moved over, so the state gathered during `initialize`
    /// — when the client had no id to send — is kept rather than stranded.
    pub fn response(
        &self,
        check: &mut RequestCheck,
        response_headers: &HttpInfo,
    ) -> ResponseFilter {
        if let Some(new_session) = response_headers.get("mcp-session-id")
            && !new_session.is_empty()
            && new_session != check.session
        {
            self.engine.rename_session(&check.session, new_session);
            check.session = new_session.to_string();
        }
        let content_type = response_headers.get("content-type").unwrap_or("");
        let kind = if content_type.contains("text/event-stream") {
            Kind::Sse
        } else if content_type.contains("application/json") {
            Kind::Json
        } else {
            Kind::Raw
        };
        ResponseFilter {
            engine: Arc::clone(&self.engine),
            session: check.session.clone(),
            strict: check.strict,
            kind,
            sse: (kind == Kind::Sse).then(|| {
                SseFilter::new(
                    Arc::clone(&self.engine),
                    check.session.clone(),
                    check.strict,
                    self.max_body_bytes,
                )
            }),
        }
    }

    /// After the response: a DELETE ends the session.
    pub fn finished(&self, check: &RequestCheck) {
        if check.method == "DELETE" {
            self.engine.drop_session(&check.session);
        }
    }
}

/// Checks a response body, whole for JSON and chunk by chunk for SSE.
pub struct ResponseFilter {
    engine: Arc<dyn Verdicts>,
    session: String,
    strict: bool,
    kind: Kind,
    sse: Option<SseFilter>,
}

impl ResponseFilter {
    pub fn kind(&self) -> Kind {
        self.kind
    }

    /// A whole JSON body, checked. Anything that is not JSON comes back untouched.
    pub async fn json(&mut self, body: &[u8]) -> Vec<u8> {
        if self.kind != Kind::Json {
            return body.to_vec();
        }
        let Ok(parsed) = serde_json::from_slice::<Value>(body) else {
            // Unparseable: hand it back exactly as it came rather than guess at it.
            return body.to_vec();
        };
        let batch = parsed.is_array();
        let messages: Vec<Value> = match &parsed {
            Value::Array(items) => items.clone(),
            other => vec![other.clone()],
        };

        let mut out: Vec<Value> = Vec::new();
        for message in messages {
            if !message.is_object() {
                out.push(message);
                continue;
            }
            let outcome = self
                .engine
                .from_server(&self.session, message, self.strict)
                .await;
            if let Some(forward) = outcome.forward.into_message() {
                out.push(forward);
            }
        }

        let value = if batch {
            Value::Array(out)
        } else {
            // A single message that was withheld leaves an empty object, which is what the Node
            // proxy sends: the client gets a well-formed body rather than a truncated one.
            out.into_iter()
                .next()
                .unwrap_or(Value::Object(Default::default()))
        };
        serde_json::to_vec(&value).unwrap_or_else(|_| body.to_vec())
    }

    /// SSE: the complete events in this chunk, checked. Empty means nothing is ready yet.
    pub async fn feed(&mut self, chunk: &[u8]) -> Result<Vec<u8>, SseOverflow> {
        match &mut self.sse {
            Some(sse) => sse.feed(chunk).await.map(String::into_bytes),
            None => Ok(chunk.to_vec()),
        }
    }

    /// Whatever is left when the stream ends.
    pub async fn end(&mut self) -> Vec<u8> {
        match &mut self.sse {
            Some(sse) => sse.end().await.into_bytes(),
            None => Vec::new(),
        }
    }
}

fn trim_slash(path: &str) -> String {
    let mut out = path;
    while out.len() > 1 && out.ends_with('/') {
        out = &out[..out.len() - 1];
    }
    out.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_path_guards_itself_and_what_is_under_it() {
        let guard = HttpGuard::new(stub(), ["/mcp"]);
        assert!(guard.matches("/mcp"));
        assert!(guard.matches("/mcp/"));
        assert!(guard.matches("/mcp/messages"));
        assert!(!guard.matches("/mcpx"));
        assert!(!guard.matches("/health"));
    }

    #[test]
    fn a_star_or_an_empty_list_guards_everything() {
        assert!(HttpGuard::new(stub(), ["*"]).matches("/anything"));
        assert!(HttpGuard::new(stub(), Vec::<String>::new()).matches("/anything"));
    }

    /// A guard that is never asked anything, for the path-matching tests.
    fn stub() -> Arc<dyn Verdicts> {
        struct Never;
        impl Verdicts for Never {
            fn from_client<'a>(
                &'a self,
                _: &'a str,
                msg: Value,
                _: Option<&'a HttpInfo>,
            ) -> crate::BoxFuture<'a, crate::Outcome> {
                Box::pin(async move { crate::Outcome::pass(msg) })
            }
            fn from_server<'a>(
                &'a self,
                _: &'a str,
                msg: Value,
                _: bool,
            ) -> crate::BoxFuture<'a, crate::Outcome> {
                Box::pin(async move { crate::Outcome::pass(msg) })
            }
            fn from_http<'a>(
                &'a self,
                _: &'a str,
                _: &'a HttpInfo,
                _: &'a str,
            ) -> crate::BoxFuture<'a, bool> {
                Box::pin(async { false })
            }
            fn rename_session(&self, _: &str, _: &str) {}
            fn drop_session(&self, _: &str) {}
            fn note_event_id(&self, _: &str, _: &str) {}
        }
        Arc::new(Never)
    }
}
