use serde::Serialize;
use serde_json::Value;

/// The JSON-RPC error code for a message the guard refused.
pub const BLOCKED: i64 = -32001;

/// The JSON-RPC error code for a message the guard throttled.
pub const THROTTLED: i64 = -32002;

/// What to do with the message that was checked.
///
/// The two directions do not mean the same thing by this, and getting them confused is the easiest
/// way to write a guard that leaks exactly what it was asked to remove:
///
/// - **client → server**: the engine never rewrites. It is [`Forward`](Verdict::Forward) of the
///   message as it came, or [`Drop`](Verdict::Drop) with a `reply` for the client.
/// - **server → client**: [`Replace`](Verdict::Replace) is common — a tool stripped from
///   `tools/list`, a redacted secret, an oversize result swapped for an error. Treat it as an
///   opaque replacement, never as a pass/fail flag.
#[derive(Debug, Clone, PartialEq)]
pub enum Verdict {
    /// Pass the message on exactly as it arrived.
    Forward(Value),
    /// Pass this *different* message on instead.
    Replace(Value),
    /// Send nothing at all.
    Drop,
}

impl Verdict {
    /// The message to pass on, if any.
    pub fn message(&self) -> Option<&Value> {
        match self {
            Self::Forward(v) | Self::Replace(v) => Some(v),
            Self::Drop => None,
        }
    }

    /// The message to pass on, taken by value.
    pub fn into_message(self) -> Option<Value> {
        match self {
            Self::Forward(v) | Self::Replace(v) => Some(v),
            Self::Drop => None,
        }
    }

    /// True when the engine handed back something other than what it was given.
    pub fn is_replaced(&self) -> bool {
        matches!(self, Self::Replace(_))
    }
}

/// What the guard decided about one message.
///
/// `reply` travels back the way the message came: a refused client request is answered to the
/// **client**, and a refused `sampling/createMessage` or `elicitation/create` is answered to the
/// **server**, so the server's pending request resolves instead of timing out.
#[derive(Debug, Clone, PartialEq)]
pub struct Outcome {
    pub forward: Verdict,
    pub reply: Option<Value>,
}

impl Outcome {
    /// Pass a message through untouched.
    pub fn pass(message: Value) -> Self {
        Self {
            forward: Verdict::Forward(message),
            reply: None,
        }
    }
}

/// A JSON-RPC error reply, built as JSON rather than from a typed model.
///
/// One code path, byte-identical to what the Node, Python and Java guards emit, and immune to a
/// future change in any SDK's structs.
pub fn error_reply(id: &Value, code: i64, message: &str) -> Value {
    serde_json::json!({
        "jsonrpc": "2.0",
        "id": id,
        "error": { "code": code, "message": message },
    })
}

/// What the HTTP transport rules need to see.
///
/// Two of these fields are feature switches rather than metadata, and both are easy to get wrong:
///
/// - `remote_address` present turns on MW037 stream-resumption checking, which only a guard that
///   relays SSE can satisfy. An in-process guard must leave it out.
/// - `encrypted` must be exactly `Some(false)` to raise MW034's second clause. `None` means "we do
///   not know", which is the right answer behind a TLS-terminating proxy.
///
/// Both are skipped when `None` rather than sent as JSON null, because the engine tests
/// `remoteAddress !== undefined` — a null would switch MW037 on with a useless address.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HttpInfo {
    /// Header names **must** already be lower-cased: the engine never normalises them.
    pub headers: std::collections::BTreeMap<String, String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub remote_address: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub encrypted: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub insecure_upstream: Option<bool>,
}

impl HttpInfo {
    /// Builds the header map, lower-casing every name on the way in.
    ///
    /// Repeated headers are joined with `", "`, as they would have arrived on the wire.
    pub fn from_headers<I, K, V>(pairs: I) -> Self
    where
        I: IntoIterator<Item = (K, V)>,
        K: AsRef<str>,
        V: AsRef<str>,
    {
        let mut headers: std::collections::BTreeMap<String, String> = Default::default();
        for (name, value) in pairs {
            let name = name.as_ref().to_ascii_lowercase();
            let value = value.as_ref();
            headers
                .entry(name)
                .and_modify(|existing| {
                    existing.push_str(", ");
                    existing.push_str(value);
                })
                .or_insert_with(|| value.to_string());
        }
        Self {
            headers,
            ..Default::default()
        }
    }

    pub fn get(&self, lower_name: &str) -> Option<&str> {
        self.headers.get(lower_name).map(String::as_str)
    }
}
