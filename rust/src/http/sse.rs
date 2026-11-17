//! Incremental server-sent-event filtering.
//!
//! A port of the Node HTTP proxy's `relaySse`, as the Python and Java adapters are. Every awkward
//! case here is one a real stream produces, and getting any of them wrong means either a stream
//! that stalls or an event the guard never sees the end of — which is an event it never checks.

use std::sync::Arc;

use serde_json::Value;

use crate::engine::Verdicts;

/// The stream grew past the cap without completing an event.
#[derive(Debug)]
pub struct SseOverflow {
    pub buffered: usize,
}

impl std::fmt::Display for SseOverflow {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "an SSE event grew past the limit ({} bytes buffered)",
            self.buffered
        )
    }
}

impl std::error::Error for SseOverflow {}

/// Decodes UTF-8 across chunk boundaries.
///
/// A multi-byte character can be split between two reads, so the tail of an incomplete sequence is
/// held back until the next chunk completes it. Malformed bytes become U+FFFD rather than an
/// error: a stream must not be killed by one bad byte, and the replacement is what the Java
/// adapter's `CharsetDecoder` produces, so all three languages see the same text.
#[derive(Default)]
pub(crate) struct Utf8Stream {
    tail: Vec<u8>,
}

impl Utf8Stream {
    pub(crate) fn decode(&mut self, chunk: &[u8], last: bool) -> String {
        let mut bytes = std::mem::take(&mut self.tail);
        bytes.extend_from_slice(chunk);

        let mut out = String::with_capacity(bytes.len());
        let mut rest = &bytes[..];
        loop {
            match std::str::from_utf8(rest) {
                Ok(text) => {
                    out.push_str(text);
                    break;
                }
                Err(e) => {
                    let valid = e.valid_up_to();
                    // SAFETY-free: `valid_up_to` is by definition a valid boundary.
                    out.push_str(std::str::from_utf8(&rest[..valid]).unwrap_or(""));
                    match e.error_len() {
                        // Incomplete at the end: keep it for the next chunk.
                        None => {
                            if last {
                                out.push('\u{FFFD}');
                            } else {
                                self.tail = rest[valid..].to_vec();
                            }
                            break;
                        }
                        Some(bad) => {
                            out.push('\u{FFFD}');
                            rest = &rest[valid + bad..];
                        }
                    }
                }
            }
        }
        out
    }
}

/// The length of a line terminator at `at`: 2 for CRLF, 1 for a lone CR or LF, 0 for anything else.
fn terminator_at(bytes: &[u8], at: usize) -> usize {
    match bytes.get(at) {
        Some(b'\r') => {
            if bytes.get(at + 1) == Some(&b'\n') {
                2
            } else {
                1
            }
        }
        Some(b'\n') => 1,
        _ => 0,
    }
}

/// Where the first complete event ends, and how many bytes its boundary takes.
///
/// An event ends wherever **any two terminators run together**, which accepts `\n\n`, `\r\n\r\n`,
/// `\r\r`, `\r\n\n`, `\n\r\n` and `\r\r\n`. Matching only the three common forms leaves `\r\n\n`
/// and `\n\r\n` unrecognised, and then the guard simply never sees that event end.
fn end_of_event(bytes: &[u8]) -> Option<(usize, usize)> {
    for i in 0..bytes.len() {
        let first = terminator_at(bytes, i);
        if first == 0 {
            continue;
        }
        let second = terminator_at(bytes, i + first);
        if second > 0 {
            return Some((i, first + second));
        }
    }
    None
}

/// Splits an event into lines on CRLF, LF or a bare CR, keeping a trailing empty segment.
fn split_lines(event: &str) -> Vec<&str> {
    let bytes = event.as_bytes();
    let mut lines = Vec::new();
    let mut start = 0;
    let mut i = 0;
    while i < bytes.len() {
        let len = terminator_at(bytes, i);
        if len > 0 {
            lines.push(&event[start..i]);
            i += len;
            start = i;
        } else {
            i += 1;
        }
    }
    lines.push(&event[start..]);
    lines
}

/// Filters one SSE stream, event by event.
pub(crate) struct SseFilter {
    engine: Arc<dyn Verdicts>,
    session: String,
    strict: bool,
    decoder: Utf8Stream,
    buf: String,
    /// True when the last event's boundary ended on a CR with nothing after it, so a leading LF in
    /// the next chunk belongs to that CR rather than opening a blank line.
    swallow_lf: bool,
    max_bytes: usize,
}

impl SseFilter {
    pub(crate) fn new(
        engine: Arc<dyn Verdicts>,
        session: String,
        strict: bool,
        max_bytes: usize,
    ) -> Self {
        Self {
            engine,
            session,
            strict,
            decoder: Utf8Stream::default(),
            buf: String::new(),
            swallow_lf: false,
            max_bytes,
        }
    }

    /// Feeds a chunk and returns whatever complete events it finished, already checked.
    ///
    /// An empty return means nothing is ready yet; the caller must not write a zero-length chunk,
    /// which on the wire is the terminal chunk and would end the stream.
    pub(crate) async fn feed(&mut self, chunk: &[u8]) -> Result<String, SseOverflow> {
        let decoded = self.decoder.decode(chunk, false);
        self.push(&decoded);

        if self.buf.len() > self.max_bytes {
            return Err(SseOverflow {
                buffered: self.buf.len(),
            });
        }

        let mut out = String::new();
        while let Some((end, boundary)) = end_of_event(self.buf.as_bytes()) {
            let event = self.buf[..end].to_string();
            let consumed = end + boundary;
            // Did the boundary itself end on a CR? Then a following LF completes it.
            let ended_on_cr = self.buf.as_bytes()[consumed - 1] == b'\r';
            self.buf.drain(..consumed);
            // Released straight away rather than held to disambiguate: holding it stalls the
            // stream, and the orphaned LF is dealt with on the next chunk instead.
            self.swallow_lf = ended_on_cr && self.buf.is_empty();
            out.push_str(&self.check(&event).await);
        }
        Ok(out)
    }

    /// Whatever is left when the stream ends: a final event with no terminating blank line.
    pub(crate) async fn end(&mut self) -> String {
        let decoded = self.decoder.decode(&[], true);
        self.push(&decoded);
        let rest = std::mem::take(&mut self.buf);
        if rest.trim().is_empty() {
            return String::new();
        }
        self.check(&rest).await
    }

    fn push(&mut self, decoded: &str) {
        let mut text = decoded;
        if self.swallow_lf {
            if let Some(stripped) = text.strip_prefix('\n') {
                text = stripped;
            }
            self.swallow_lf = false;
        }
        self.buf.push_str(text);
    }

    /// One event, checked.
    async fn check(&self, event: &str) -> String {
        let lines = split_lines(event);
        let mut kept: Vec<&str> = Vec::new();
        let mut data: Vec<&str> = Vec::new();

        for line in &lines {
            if let Some(id) = line.strip_prefix("id:") {
                let id = id.trim();
                // Recorded before any decision, so a dropped event's id still counts as sent: the
                // client may resume from it, and MW037 has to know it was legitimately issued.
                if !id.is_empty() {
                    self.engine.note_event_id(&self.session, id);
                }
                kept.push(line);
            } else if let Some(rest) = line.strip_prefix("data:") {
                // Exactly one leading space is part of the framing; a second one is data.
                data.push(rest.strip_prefix(' ').unwrap_or(rest));
            } else {
                kept.push(line);
            }
        }

        if data.is_empty() {
            // A comment, a bare `event:` or `retry:`, a keep-alive. Not ours to judge.
            return format!("{event}\n\n");
        }
        let payload = data.join("\n");
        let Ok(message) = serde_json::from_str::<Value>(&payload) else {
            return format!("{event}\n\n");
        };
        if !message.is_object() {
            return format!("{event}\n\n");
        }

        let outcome = self
            .engine
            .from_server(&self.session, message, self.strict)
            .await;
        if let Some(reply) = outcome.reply {
            // An HTTP response is one-way: there is no channel back to the server here. The SDK
            // transport guard can answer; this cannot.
            log::warn!(
                "[mcpwatch] refused {} from the server; it gets no answer here",
                reply
                    .get("method")
                    .and_then(Value::as_str)
                    .unwrap_or("a request")
            );
        }
        let Some(forward) = outcome.forward.into_message() else {
            // The whole event vanishes, its `id:` line with it, and the stream keeps running.
            return String::new();
        };

        let mut out = String::new();
        for line in kept {
            out.push_str(line);
            out.push('\n');
        }
        out.push_str("data: ");
        out.push_str(&serde_json::to_string(&forward).unwrap_or_default());
        out.push_str("\n\n");
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recognises_every_boundary_form() {
        // Matching only `\n\n`, `\r\n\r\n` and `\r\r` would miss the last three.
        for sep in ["\n\n", "\r\n\r\n", "\r\r", "\r\n\n", "\n\r\n", "\r\r\n"] {
            let text = format!("data: 1{sep}data: 2{sep}");
            let (end, boundary) = end_of_event(text.as_bytes())
                .unwrap_or_else(|| panic!("{sep:?} should end an event"));
            assert_eq!(&text[..end], "data: 1", "for {sep:?}");
            assert_eq!(boundary, sep.len(), "for {sep:?}");
        }
    }

    #[test]
    fn a_partial_event_is_not_an_event() {
        assert!(end_of_event(b"data: {\"a\":1}\n").is_none());
    }

    #[test]
    fn splits_on_every_line_ending() {
        assert_eq!(split_lines("a\r\nb\nc\rd"), vec!["a", "b", "c", "d"]);
    }

    #[test]
    fn keeps_a_trailing_empty_line() {
        assert_eq!(split_lines("a\n"), vec!["a", ""]);
    }

    #[test]
    fn decodes_a_character_split_across_chunks() {
        let mut decoder = Utf8Stream::default();
        let emoji = "🐎".as_bytes();
        let first = decoder.decode(&emoji[..2], false);
        assert_eq!(first, "", "an incomplete character waits");
        let second = decoder.decode(&emoji[2..], false);
        assert_eq!(second, "🐎");
    }

    #[test]
    fn a_malformed_byte_becomes_a_replacement() {
        let mut decoder = Utf8Stream::default();
        let out = decoder.decode(&[b'a', 0x80, b'b'], false);
        assert_eq!(out, "a\u{FFFD}b");
    }

    #[test]
    fn an_incomplete_tail_at_the_end_is_replaced() {
        let mut decoder = Utf8Stream::default();
        assert_eq!(decoder.decode(&"🐎".as_bytes()[..2], true), "\u{FFFD}");
    }
}
