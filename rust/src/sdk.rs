//! Guarding a server built with the official Rust MCP SDK (`rmcp`).
//!
//! ```no_run
//! # use rmcp::{ServiceExt, handler::server::ServerHandler};
//! # async fn example<S: ServerHandler + Send + 'static>(server: S) -> Result<(), Box<dyn std::error::Error>> {
//! use mcpwatch::{McpWatch, McpWatchOptions};
//!
//! let watch = McpWatch::start("my-tools", McpWatchOptions::new()).await;
//! let running = server.serve(watch.guard_stdio()).await?;   // the only line changed
//! running.waiting().await?;
//! # Ok(()) }
//! ```
//!
//! This covers **stdio** and anything else that is a byte stream. For **Streamable HTTP**, guard
//! the endpoint with the tower layer instead: the request headers that the transport rules
//! MW030–MW036 need are only available there.
//!
//! The guard owns the newline-delimited JSON framing itself, which buys the thing that matters
//! most: a message the engine **rewrote** — a tool stripped from `tools/list`, a redacted secret —
//! goes to the wire exactly as the engine wrote it, instead of being rebuilt through a typed model
//! that has no place to put a field it does not know.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};

use rmcp::model::{ClientJsonRpcMessage, ServerJsonRpcMessage};
use rmcp::service::RoleServer;
use rmcp::transport::Transport;
use serde_json::Value;
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncWrite, AsyncWriteExt, BufReader};
use tokio::sync::mpsc;

use crate::engine::Engine;
use crate::error::GuardError;

/// What the writer task should put on the wire.
enum Outbound {
    /// A message from the server, to be checked on its way out.
    ///
    /// Boxed because a `ServerJsonRpcMessage` is far larger than a refusal, and every item in the
    /// channel would otherwise be padded to its size.
    Checked(Box<ServerJsonRpcMessage>),
    /// The guard's own answer. It is **not** checked again: re-judging our own refusal could see
    /// it dropped, and then the client would wait forever for an answer that was already decided.
    Raw(Value),
}

/// A guarded byte-stream transport for `rmcp`.
///
/// `send` is a channel push, so the future it returns owns nothing but a sender — which is what
/// the `Transport` trait requires, since that future must be `'static` and cannot borrow the
/// transport.
pub struct GuardedTransport {
    outbound: mpsc::Sender<Outbound>,
    inbound: mpsc::Receiver<ClientJsonRpcMessage>,
    /// Replies the guard owes the *server*, pushed back in as though the client had sent them.
    ///
    /// Unbounded, and deliberately so. If this shared the bounded inbound channel, a full inbound
    /// queue plus a server blocked on a full outbound queue plus a writer blocked on the inbound
    /// queue is a three-way deadlock. Injections are rare and bounded by the number of in-flight
    /// server requests, so an unbounded channel costs nothing and breaks the cycle.
    inject: mpsc::UnboundedReceiver<ClientJsonRpcMessage>,
}

impl GuardedTransport {
    fn start<R, W>(read: R, write: W, engine: Option<Engine>, capacity: usize) -> Self
    where
        R: AsyncRead + Send + Unpin + 'static,
        W: AsyncWrite + Send + Unpin + 'static,
    {
        let session = Arc::new(provisional_session());
        let dropped = Arc::new(AtomicBool::new(false));

        let (inbound_tx, inbound) = mpsc::channel::<ClientJsonRpcMessage>(capacity);
        let (outbound_tx, outbound_rx) = mpsc::channel::<Outbound>(capacity);
        let (inject_tx, inject) = mpsc::unbounded_channel::<ClientJsonRpcMessage>();

        spawn_reader(
            read,
            engine.clone(),
            Arc::clone(&session),
            inbound_tx,
            outbound_tx.clone(),
            Arc::clone(&dropped),
        );
        spawn_writer(write, engine, session, outbound_rx, inject_tx, dropped);

        Self {
            outbound: outbound_tx,
            inbound,
            inject,
        }
    }
}

/// Reads client messages, checks each one, and hands on what survives.
///
/// Strictly sequential: line *n+1* is not read while check *n* is in flight. That head-of-line
/// blocking **is** the ordering guarantee — a `tools/list` judged before its own `initialize` would
/// be judged without the session state it depends on.
fn spawn_reader<R>(
    read: R,
    engine: Option<Engine>,
    session: Arc<String>,
    inbound: mpsc::Sender<ClientJsonRpcMessage>,
    outbound: mpsc::Sender<Outbound>,
    dropped: Arc<AtomicBool>,
) where
    R: AsyncRead + Send + Unpin + 'static,
{
    tokio::spawn(async move {
        let mut lines = BufReader::new(read).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            if line.trim().is_empty() {
                continue;
            }
            let Ok(message) = serde_json::from_str::<Value>(&line) else {
                // Not JSON: not ours to judge. The SDK's own parser will reject it.
                log::debug!("[mcpwatch] a client line was not JSON");
                continue;
            };

            let forward = match &engine {
                None => Some(message),
                Some(engine) => {
                    let outcome = engine.check_from_client(&session, message, None).await;
                    if let Some(reply) = outcome.reply
                        && outbound.send(Outbound::Raw(reply)).await.is_err()
                    {
                        break;
                    }
                    outcome.forward.into_message()
                }
            };

            let Some(forward) = forward else { continue };
            match serde_json::from_value::<ClientJsonRpcMessage>(forward) {
                Ok(typed) => {
                    if inbound.send(typed).await.is_err() {
                        break;
                    }
                }
                Err(e) => log::warn!("[mcpwatch] a client message could not be read: {e}"),
            }
        }
        drop_once(&engine, &session, &dropped);
    });
}

/// Checks server messages on their way out and writes what survives.
fn spawn_writer<W>(
    write: W,
    engine: Option<Engine>,
    session: Arc<String>,
    mut outbound: mpsc::Receiver<Outbound>,
    inject: mpsc::UnboundedSender<ClientJsonRpcMessage>,
    dropped: Arc<AtomicBool>,
) where
    W: AsyncWrite + Send + Unpin + 'static,
{
    tokio::spawn(async move {
        let mut write = write;
        while let Some(item) = outbound.recv().await {
            let bytes = match item {
                Outbound::Raw(value) => Some(value),
                Outbound::Checked(typed) => {
                    let Ok(message) = serde_json::to_value(&typed) else {
                        // A message we cannot even describe to the engine is one the rules get no
                        // say on. Passing it is the Java and Python behaviour; bricking a server
                        // over a serde quirk would be the wrong default.
                        log::warn!("[mcpwatch] a server message could not be encoded; passing it");
                        continue;
                    };
                    match &engine {
                        None => Some(message),
                        Some(engine) => {
                            // `strict` is false in process: there is no forgeable channel here, so
                            // MW037 would only ever flag the server's own messages.
                            let outcome = engine.check_from_server(&session, message, false).await;
                            if let Some(reply) = outcome.reply {
                                reply_to_server(&inject, reply);
                            }
                            outcome.forward.into_message()
                        }
                    }
                }
            };

            let Some(value) = bytes else { continue };
            let Ok(mut line) = serde_json::to_vec(&value) else {
                continue;
            };
            line.push(b'\n');
            if write.write_all(&line).await.is_err() || write.flush().await.is_err() {
                log::warn!("[mcpwatch] the client connection closed while writing");
                break;
            }
        }
        // Whatever is still queued cannot be written; let senders fail rather than hang.
        outbound.close();
        drop_once(&engine, &session, &dropped);
    });
}

/// Pushes the guard's refusal back into the server, so its pending request resolves rather than
/// timing out.
fn reply_to_server(inject: &mpsc::UnboundedSender<ClientJsonRpcMessage>, reply: Value) {
    let method = reply
        .get("method")
        .and_then(Value::as_str)
        .unwrap_or("a request")
        .to_string();
    match serde_json::from_value::<ClientJsonRpcMessage>(reply) {
        Ok(typed) => {
            let _ = inject.send(typed);
        }
        Err(_) => log::warn!("[mcpwatch] refused {method} from the server; it gets no answer here"),
    }
}

fn drop_once(engine: &Option<Engine>, session: &str, dropped: &AtomicBool) {
    if let Some(engine) = engine
        && !dropped.swap(true, Ordering::SeqCst)
    {
        use crate::engine::Verdicts;
        engine.drop_session(session);
    }
}

/// A connection id, unique within this process, which is all a `conn-` id has to be.
fn provisional_session() -> String {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let n = COUNTER.fetch_add(1, Ordering::Relaxed);
    let seed = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(0);
    format!("conn-{:08x}", (seed ^ (n.wrapping_mul(0x9E37_79B9))) as u32)
}

impl Transport<RoleServer> for GuardedTransport {
    type Error = GuardError;

    fn send(
        &mut self,
        item: ServerJsonRpcMessage,
    ) -> impl Future<Output = Result<(), Self::Error>> + Send + 'static {
        // The only thing captured is a sender, so the future borrows nothing.
        let outbound = self.outbound.clone();
        async move {
            outbound
                .send(Outbound::Checked(Box::new(item)))
                .await
                .map_err(|_| GuardError::Closed)
        }
    }

    async fn receive(&mut self) -> Option<ClientJsonRpcMessage> {
        tokio::select! {
            // A refusal the server is waiting on must never queue behind client traffic.
            biased;
            Some(injected) = self.inject.recv() => Some(injected),
            message = self.inbound.recv() => message,
        }
    }

    async fn close(&mut self) -> Result<(), Self::Error> {
        self.inbound.close();
        self.inject.close();
        Ok(())
    }
}

impl crate::McpWatch {
    /// Guards a byte-stream transport: stdio, a socket, anything `AsyncRead + AsyncWrite`.
    ///
    /// Returns a transport that passes everything through untouched when MCPWatch is off.
    pub fn guard_io<R, W>(&self, read: R, write: W) -> GuardedTransport
    where
        R: AsyncRead + Send + Unpin + 'static,
        W: AsyncWrite + Send + Unpin + 'static,
    {
        let capacity = self
            .engine
            .as_ref()
            .map(|e| e.channel_capacity())
            .unwrap_or(64);
        GuardedTransport::start(read, write, self.engine.clone(), capacity)
    }

    /// Guards this process's stdin and stdout: the usual way to run a local MCP server.
    pub fn guard_stdio(&self) -> GuardedTransport {
        self.guard_io(tokio::io::stdin(), tokio::io::stdout())
    }
}
