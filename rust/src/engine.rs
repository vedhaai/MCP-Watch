use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::Value;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::{Mutex as AsyncMutex, mpsc, oneshot, watch};

use crate::error::EngineUnavailable;
use crate::options::{McpWatchOptions, Mode};
use crate::outcome::{BLOCKED, HttpInfo, Outcome, Verdict, error_reply};

/// A boxed future, so the check traits stay usable behind `dyn`.
///
/// Hand-rolled rather than taken from `async-trait`: a proc-macro crate in every host's build graph
/// is not worth the few lines it saves, and this crate is injected into someone else's server.
pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// What a guard needs to ask about a message.
///
/// [`Engine`] is the real implementation. The trait exists so the HTTP guard and the transport
/// guard can be tested against a stub with no Node and no engine build at all — the framing, SSE
/// and batch behaviour is most of the code and none of it needs a real verdict.
// `from_client` / `from_server` / `from_http` are the engine's own names, in Node, Python and
// Java alike. Renaming them here to satisfy a naming lint would make the one adapter that reads
// differently from the other three, for no gain.
#[allow(clippy::wrong_self_convention)]
pub trait Verdicts: Send + Sync + 'static {
    fn from_client<'a>(
        &'a self,
        session: &'a str,
        msg: Value,
        http: Option<&'a HttpInfo>,
    ) -> BoxFuture<'a, Outcome>;

    fn from_server<'a>(
        &'a self,
        session: &'a str,
        msg: Value,
        strict: bool,
    ) -> BoxFuture<'a, Outcome>;

    fn from_http<'a>(
        &'a self,
        session: &'a str,
        http: &'a HttpInfo,
        method: &'a str,
    ) -> BoxFuture<'a, bool>;

    /// Session bookkeeping that nobody waits for. Sync and infallible on purpose: these are called
    /// from `Drop` and from inside the SSE hot path.
    fn rename_session(&self, from: &str, to: &str);
    fn drop_session(&self, session: &str);
    fn note_event_id(&self, session: &str, event_id: &str);
}

// ---- the pending-call registry ------------------------------------------------------------------

/// What is waiting on the engine that is running now.
///
/// Each spawn gets a fresh map, so a crashed engine's reader can only ever fail the calls that were
/// made to *it*. The replacement's calls are unreachable from the dead reader by construction: it
/// holds an `Arc` to the old map and has no way to name the new one.
#[derive(Default)]
struct PendingMap(StdMutex<HashMap<u64, oneshot::Sender<Value>>>);

impl PendingMap {
    fn insert(&self, id: u64, tx: oneshot::Sender<Value>) {
        if let Ok(mut map) = self.0.lock() {
            map.insert(id, tx);
        }
    }

    fn take(&self, id: u64) -> Option<oneshot::Sender<Value>> {
        self.0.lock().ok()?.remove(&id)
    }

    fn remove(&self, id: u64) {
        if let Ok(mut map) = self.0.lock() {
            map.remove(&id);
        }
    }

    /// Drops every waiting sender, which resolves each receiver to an error. Nothing to construct,
    /// and no chance of a synthetic answer being mistaken for a real one.
    fn fail_all(&self) {
        if let Ok(mut map) = self.0.lock() {
            map.clear();
        }
    }
}

/// Removes a pending entry on every exit path, including a timeout or a cancelled call.
struct PendingGuard {
    pending: Arc<PendingMap>,
    id: u64,
    done: bool,
}

impl Drop for PendingGuard {
    fn drop(&mut self) {
        if !self.done {
            self.pending.remove(self.id);
        }
    }
}

// ---- the engine ---------------------------------------------------------------------------------

struct Running {
    stdin: ChildStdin,
    pending: Arc<PendingMap>,
    exited: watch::Receiver<Option<i32>>,
}

#[derive(Default)]
struct StartState {
    running: Option<Running>,
    last_start: Option<Instant>,
    notes_started: bool,
}

struct EngineInner {
    name: String,
    options: McpWatchOptions,
    wire_options: Vec<u8>,
    ids: AtomicU64,
    /// Held to start the engine and to write one request, so lines never interleave on the pipe.
    ///
    /// An async mutex because it is held across awaits, and because waiting for it must be
    /// abandonable: a restart waits for the handshake, which may take the whole start timeout, and
    /// every message arriving meanwhile would otherwise block for exactly as long. A guard that
    /// stops answering is worse than one that refuses.
    start: AsyncMutex<StartState>,
    mode: StdMutex<Mode>,
    last_warning: StdMutex<Option<Instant>>,
    closed: AtomicBool,
    notes: mpsc::UnboundedSender<(String, Value)>,
    notes_rx: StdMutex<Option<mpsc::UnboundedReceiver<(String, Value)>>>,
}

/// The MCPWatch engine, run as a Node sidecar (`mcpwatch engine`).
///
/// Every rule, the AI reviewer and the dashboard reporting live in the Node package; this type
/// starts it as a child process and asks it about each JSON-RPC message, one JSON object per line
/// each way. Rust guards stay thin, and a server in Rust gets exactly the verdicts a Node one
/// would.
///
/// One engine per guarded server, shared by every connection to it. Cheap to clone.
///
/// Checks never fail outwards: if the engine cannot be reached, a request is refused with `-32001`
/// (the default), or passed on unchanged when `fail_open` is set.
#[derive(Clone)]
pub struct Engine(Arc<EngineInner>);

impl Engine {
    /// Builds an engine for one guarded server. Nothing is spawned until [`start`](Self::start) or
    /// the first message.
    pub fn new(
        name: impl Into<String>,
        options: McpWatchOptions,
    ) -> Result<Self, serde_json::Error> {
        let name = name.into();
        let wire_options = options.to_engine_options(&name)?;
        let mode = options.requested_mode();
        let (notes, notes_rx) = mpsc::unbounded_channel();
        Ok(Self(Arc::new(EngineInner {
            name,
            options,
            wire_options,
            ids: AtomicU64::new(0),
            start: AsyncMutex::new(StartState::default()),
            mode: StdMutex::new(mode),
            last_warning: StdMutex::new(None),
            closed: AtomicBool::new(false),
            notes,
            notes_rx: StdMutex::new(Some(notes_rx)),
        })))
    }

    /// The engine for one guarded server, started, or `None` when MCPWatch is off
    /// (`enabled(false)` or `MCPWATCH_ENABLED=0`).
    ///
    /// A guard that cannot start its engine is not an error the caller has to handle: it is logged,
    /// and `fail_open` decides what happens to messages until the engine comes up.
    pub async fn create_if_enabled(
        name: impl Into<String>,
        options: McpWatchOptions,
    ) -> Option<Self> {
        if !options.is_enabled() {
            return None;
        }
        let fail_open = options.is_fail_open();
        let engine = match Self::new(name, options) {
            Ok(engine) => engine,
            Err(e) => {
                log::error!("[mcpwatch] the options could not be encoded: {e}");
                return None;
            }
        };
        if let Err(e) = engine.start().await {
            let what = if fail_open {
                "messages pass unchecked"
            } else {
                "requests are refused"
            };
            log::error!("[mcpwatch] {e}; {what} until it starts");
        }
        Some(engine)
    }

    pub fn name(&self) -> &str {
        &self.0.name
    }

    /// The mode the engine reported, which with a project key is the dashboard's.
    pub fn mode(&self) -> Mode {
        *self.0.mode.lock().expect("mode lock")
    }

    fn fail_open(&self) -> bool {
        self.0.options.is_fail_open()
    }

    /// How many messages may wait in each direction of a guarded connection.
    pub fn channel_capacity(&self) -> usize {
        self.0.options.channel_capacity
    }

    /// Starts the engine now rather than on the first message (that one would wait for it).
    pub async fn start(&self) -> Result<(), EngineUnavailable> {
        let mut state = self.0.start.lock().await;
        self.ensure_started(&mut state).await.map(|_| ())
    }

    // ---- process ---------------------------------------------------------------------------

    async fn ensure_started(&self, state: &mut StartState) -> Result<(), EngineUnavailable> {
        if self.0.closed.load(Ordering::SeqCst) {
            return Err(EngineUnavailable::Closed);
        }
        if let Some(running) = &state.running
            && running.exited.borrow().is_none()
        {
            return Ok(());
        }
        // Don't respawn a crashing engine on every message.
        if let Some(last) = state.last_start {
            let backoff = self.0.options.restart_backoff;
            let since = last.elapsed();
            if state.running.is_some() && since < backoff {
                return Err(EngineUnavailable::RestartingSoon {
                    retry_in: backoff - since,
                });
            }
        }
        // Stamped before the attempt, so a spawn that itself fails also opens the window.
        state.last_start = Some(Instant::now());

        let command = crate::command::engine_command(self.0.options.engine_command.as_deref())?;
        let mut builder = Command::new(&command[0]);
        builder
            .args(&command[1..])
            .env(
                "MCPWATCH_ENGINE_OPTIONS",
                String::from_utf8_lossy(&self.0.wire_options).as_ref(),
            )
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            // The engine logs to stderr; let it reach the host application's own stderr.
            .stderr(Stdio::inherit())
            .kill_on_drop(true);

        let mut child: Child = builder.spawn().map_err(|source| EngineUnavailable::Spawn {
            command: command[0].clone(),
            source,
        })?;

        let stdin = child.stdin.take().expect("stdin was piped");
        let stdout = child.stdout.take().expect("stdout was piped");

        // Anything still waiting belonged to the engine that just died; dropping the old `Running`
        // below drops its map, and its reader fails whatever is left.
        let pending = Arc::new(PendingMap::default());
        let (ready_tx, ready_rx) = oneshot::channel::<Value>();
        pending.insert(0, ready_tx);

        let (exit_tx, exit_rx) = watch::channel::<Option<i32>>(None);

        // One reader per spawned child, holding only that child's map.
        let reader_pending = Arc::clone(&pending);
        tokio::spawn(async move {
            let mut lines = BufReader::new(stdout).lines();
            // Anything but a line — EOF or a read error — ends the loop, and everything still
            // waiting is failed below.
            while let Ok(Some(line)) = lines.next_line().await {
                if line.trim().is_empty() {
                    continue;
                }
                let Ok(answer) = serde_json::from_str::<Value>(&line) else {
                    log::warn!("[mcpwatch] the engine sent a line that is not JSON");
                    continue;
                };
                match answer.get("id").and_then(Value::as_u64) {
                    Some(id) => {
                        if let Some(tx) = reader_pending.take(id) {
                            let _ = tx.send(answer);
                        }
                    }
                    // `{"id":null,...}` cannot be matched to a call; the caller falls through to
                    // its own timeout.
                    None => {
                        if let Some(err) = answer.get("error") {
                            log::warn!("[mcpwatch] the engine refused a request: {err}");
                        }
                    }
                }
            }
            reader_pending.fail_all();
        });

        // A supervisor owns the child, so the start sequence can watch for an exit without racing
        // the reader for it.
        let name = self.0.name.clone();
        tokio::spawn(async move {
            let code = child.wait().await.ok().and_then(|s| s.code());
            if let Some(code) = code
                && code != 0
            {
                log::error!("[mcpwatch] the engine for \"{name}\" exited with code {code}");
            }
            let _ = exit_tx.send(Some(code.unwrap_or(-1)));
        });

        state.running = Some(Running {
            stdin,
            pending,
            exited: exit_rx.clone(),
        });

        self.await_handshake(ready_rx, exit_rx)
            .await
            .inspect_err(|_| {
                state.running = None;
            })?;

        self.spawn_notes_task(state);
        Ok(())
    }

    /// Waits for `{"id":0,"ready":true}`, but gives up the moment the child exits instead.
    ///
    /// A bad `MCPWATCH_ENGINE_OPTIONS` makes the engine print to stderr and exit 2 without ever
    /// sending a handshake. Waiting out the full start timeout for that would be two minutes of
    /// silence for a mistake the engine already diagnosed.
    async fn await_handshake(
        &self,
        ready: oneshot::Receiver<Value>,
        mut exited: watch::Receiver<Option<i32>>,
    ) -> Result<(), EngineUnavailable> {
        let hello = tokio::select! {
            biased;
            answer = ready => answer.map_err(|_| EngineUnavailable::DidNotStart {
                detail: "the engine stopped before the handshake".into(),
            })?,
            _ = exited.changed() => {
                let code = *exited.borrow();
                return Err(EngineUnavailable::DidNotStart {
                    detail: match code {
                        Some(c) => format!("it exited with code {c} before the handshake"),
                        None => "it exited before the handshake".into(),
                    },
                });
            }
            _ = tokio::time::sleep(self.0.options.start_timeout) => {
                return Err(EngineUnavailable::DidNotStart {
                    detail: format!("no handshake in {} ms", self.0.options.start_timeout.as_millis()),
                });
            }
        };
        if let Some(mode) = hello
            .get("mode")
            .and_then(Value::as_str)
            .and_then(Mode::parse)
        {
            *self.0.mode.lock().expect("mode lock") = mode;
        }
        Ok(())
    }

    /// Drains the fire-and-forget op queue. Started once, on the first successful start, so that a
    /// `drop_session` from a `Drop` impl never has to spawn anything itself.
    fn spawn_notes_task(&self, state: &mut StartState) {
        if state.notes_started {
            return;
        }
        let Some(mut rx) = self.0.notes_rx.lock().expect("notes lock").take() else {
            return;
        };
        state.notes_started = true;
        let engine = self.clone();
        tokio::spawn(async move {
            while let Some((op, fields)) = rx.recv().await {
                if let Err(e) = engine.send_note(&op, fields).await {
                    engine.warn_occasionally(&e);
                }
            }
        });
    }

    async fn send_note(&self, op: &str, fields: Value) -> Result<(), EngineUnavailable> {
        let id = self.0.ids.fetch_add(1, Ordering::SeqCst) + 1;
        let mut request = serde_json::Map::new();
        request.insert("id".into(), Value::from(id));
        request.insert("op".into(), Value::from(op));
        if let Value::Object(map) = fields {
            request.extend(map);
        }
        // The engine answers these too; the receiver is dropped immediately, and the reader simply
        // finds no one waiting.
        let (_guard, rx) = self.write(Value::Object(request), id).await?;
        drop(rx);
        Ok(())
    }

    /// Writes one request and registers the call. The lock is what keeps lines whole on the pipe.
    async fn write(
        &self,
        request: Value,
        id: u64,
    ) -> Result<(PendingGuard, oneshot::Receiver<Value>), EngineUnavailable> {
        let wait = self.0.options.call_timeout;
        let mut state = match tokio::time::timeout(wait, self.0.start.lock()).await {
            Ok(state) => state,
            // Another task is starting the engine and is taking longer than this caller is willing
            // to wait for an answer at all.
            Err(_) => return Err(EngineUnavailable::Busy { waited: wait }),
        };
        self.ensure_started(&mut state).await?;

        let running = state.running.as_mut().ok_or(EngineUnavailable::Closed)?;
        let (tx, rx) = oneshot::channel();
        running.pending.insert(id, tx);
        let guard = PendingGuard {
            pending: Arc::clone(&running.pending),
            id,
            done: false,
        };

        let mut line = serde_json::to_vec(&request).map_err(|e| EngineUnavailable::Refused {
            message: format!("the request could not be encoded: {e}"),
        })?;
        line.push(b'\n');

        if let Err(e) = running.stdin.write_all(&line).await {
            drop(guard);
            state.running = None;
            return Err(EngineUnavailable::Spawn {
                command: "the engine's stdin".into(),
                source: e,
            });
        }
        if let Err(e) = running.stdin.flush().await {
            drop(guard);
            state.running = None;
            return Err(EngineUnavailable::Spawn {
                command: "the engine's stdin".into(),
                source: e,
            });
        }
        Ok((guard, rx))
    }

    /// One request to the engine, waited for.
    async fn call<T: Serialize>(&self, op: &str, fields: &T) -> Result<Value, EngineUnavailable> {
        let id = self.0.ids.fetch_add(1, Ordering::SeqCst) + 1;
        let mut request = serde_json::to_value(fields).map_err(|e| EngineUnavailable::Refused {
            message: format!("the request could not be encoded: {e}"),
        })?;
        let map = request.as_object_mut().ok_or(EngineUnavailable::Refused {
            message: "the request is not a JSON object".into(),
        })?;
        map.insert("id".into(), Value::from(id));
        map.insert("op".into(), Value::from(op));

        let (mut guard, rx) = self.write(request, id).await?;
        let wait = self.0.options.call_timeout;
        let answer = match tokio::time::timeout(wait, rx).await {
            Ok(Ok(answer)) => {
                guard.done = true;
                answer
            }
            Ok(Err(_)) => return Err(EngineUnavailable::Exited { code: None }),
            Err(_) => return Err(EngineUnavailable::Timeout { waited: wait }),
        };

        // An op-level error has no message to forward; a check that the engine itself failed open
        // comes back as an ordinary answer.
        if let Some(error) = answer.get("error")
            && answer.get("forward").is_none()
        {
            return Err(EngineUnavailable::Refused {
                message: error.as_str().unwrap_or(&error.to_string()).to_string(),
            });
        }
        Ok(answer)
    }

    // ---- checks ----------------------------------------------------------------------------

    fn warn_occasionally(&self, cause: &EngineUnavailable) {
        let now = Instant::now();
        let mut last = self.0.last_warning.lock().expect("warning lock");
        let due = match *last {
            None => true,
            Some(then) => now.duration_since(then) > Duration::from_secs(60),
        };
        if due {
            *last = Some(now);
            drop(last);
            log::error!("[mcpwatch] guard error: {cause}");
        }
    }

    /// What happens to a message the engine could not judge.
    ///
    /// Fail-closed refuses **requests** only: a notification cannot be answered at all, and a
    /// response carries an id but no method, so it passes. That is surprising the first time, and
    /// it is exactly what the Node, Python and Java guards do.
    fn failed(&self, message: Value, cause: &EngineUnavailable) -> Outcome {
        self.warn_occasionally(cause);
        let is_request =
            message.get("id").is_some_and(|id| !id.is_null()) && message.get("method").is_some();
        if self.fail_open() || !is_request {
            return Outcome::pass(message);
        }
        let id = message.get("id").cloned().unwrap_or(Value::Null);
        Outcome {
            forward: Verdict::Drop,
            reply: Some(error_reply(&id, BLOCKED, "MCPWatch failed closed")),
        }
    }

    /// Turns the engine's answer into a verdict, keeping the original when nothing changed.
    ///
    /// The comparison is what makes the common path free: an unchanged message is forwarded as the
    /// very value that came in, so no caller ever has to rebuild a typed message it already had.
    fn verdict(answer: &Value, original: Value) -> Verdict {
        match answer.get("forward") {
            None | Some(Value::Null) => Verdict::Drop,
            Some(forward) if *forward == original => Verdict::Forward(original),
            Some(forward) => Verdict::Replace(forward.clone()),
        }
    }

    fn reply_of(answer: &Value) -> Option<Value> {
        match answer.get("reply") {
            None | Some(Value::Null) => None,
            Some(reply) => Some(reply.clone()),
        }
    }

    /// Checks a message on its way from the client to the server.
    pub async fn check_from_client(
        &self,
        session: &str,
        message: Value,
        http: Option<&HttpInfo>,
    ) -> Outcome {
        #[derive(Serialize)]
        struct Req<'a> {
            session: &'a str,
            msg: &'a Value,
            #[serde(skip_serializing_if = "Option::is_none")]
            http: Option<&'a HttpInfo>,
        }
        match self
            .call(
                "client",
                &Req {
                    session,
                    msg: &message,
                    http,
                },
            )
            .await
        {
            Ok(answer) => Outcome {
                forward: Self::verdict(&answer, message),
                reply: Self::reply_of(&answer),
            },
            Err(e) => self.failed(message, &e),
        }
    }

    /// Checks a message on its way from the server to the client.
    pub async fn check_from_server(&self, session: &str, message: Value, strict: bool) -> Outcome {
        #[derive(Serialize)]
        struct Req<'a> {
            session: &'a str,
            msg: &'a Value,
            strict: bool,
        }
        match self
            .call(
                "server",
                &Req {
                    session,
                    msg: &message,
                    strict,
                },
            )
            .await
        {
            Ok(answer) => Outcome {
                forward: Self::verdict(&answer, message),
                reply: Self::reply_of(&answer),
            },
            Err(e) => self.failed(message, &e),
        }
    }

    /// True when a request with no JSON-RPC body (GET, DELETE) must be refused.
    pub async fn check_from_http(&self, session: &str, http: &HttpInfo, method: &str) -> bool {
        #[derive(Serialize)]
        struct Req<'a> {
            session: &'a str,
            http: &'a HttpInfo,
            method: &'a str,
        }
        match self
            .call(
                "http",
                &Req {
                    session,
                    http,
                    method,
                },
            )
            .await
        {
            Ok(answer) => answer
                .get("refuse")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            Err(e) => {
                self.warn_occasionally(&e);
                !self.fail_open()
            }
        }
    }

    fn note(&self, op: &str, fields: Value) {
        let _ = self.0.notes.send((op.to_string(), fields));
    }

    /// Changes the mode at runtime; `Off` passes everything through.
    pub async fn set_mode(&self, mode: Mode) -> Result<(), EngineUnavailable> {
        #[derive(Serialize)]
        struct Req {
            mode: &'static str,
        }
        let answer = self
            .call(
                "mode",
                &Req {
                    mode: mode.as_str(),
                },
            )
            .await?;
        let reported = answer
            .get("mode")
            .and_then(Value::as_str)
            .and_then(Mode::parse)
            .unwrap_or(mode);
        *self.0.mode.lock().expect("mode lock") = reported;
        Ok(())
    }

    /// Lets the engine send its queued events and exit.
    ///
    /// Closing its stdin is what tells the engine to flush, so that is all this does, followed by a
    /// grace period. A host that wants the last events delivered must call this; dropping the
    /// engine is safe but may lose them.
    pub async fn shutdown(&self) {
        self.0.closed.store(true, Ordering::SeqCst);
        let mut state =
            match tokio::time::timeout(Duration::from_secs(5), self.0.start.lock()).await {
                Ok(state) => state,
                Err(_) => return,
            };
        let Some(running) = state.running.take() else {
            return;
        };
        let mut exited = running.exited.clone();
        drop(running.stdin);
        let _ = tokio::time::timeout(Duration::from_secs(5), exited.changed()).await;
    }
}

impl Verdicts for Engine {
    fn from_client<'a>(
        &'a self,
        session: &'a str,
        msg: Value,
        http: Option<&'a HttpInfo>,
    ) -> BoxFuture<'a, Outcome> {
        Box::pin(self.check_from_client(session, msg, http))
    }

    fn from_server<'a>(
        &'a self,
        session: &'a str,
        msg: Value,
        strict: bool,
    ) -> BoxFuture<'a, Outcome> {
        Box::pin(self.check_from_server(session, msg, strict))
    }

    fn from_http<'a>(
        &'a self,
        session: &'a str,
        http: &'a HttpInfo,
        method: &'a str,
    ) -> BoxFuture<'a, bool> {
        Box::pin(self.check_from_http(session, http, method))
    }

    fn rename_session(&self, from: &str, to: &str) {
        self.note("rename", serde_json::json!({ "from": from, "to": to }));
    }

    fn drop_session(&self, session: &str) {
        self.note("drop", serde_json::json!({ "session": session }));
    }

    fn note_event_id(&self, session: &str, event_id: &str) {
        self.note(
            "eventId",
            serde_json::json!({ "session": session, "eventId": event_id }),
        );
    }
}

impl Drop for EngineInner {
    fn drop(&mut self) {
        // Best effort and never blocking: `block_on` would panic inside a runtime. Dropping the
        // stdin handle closes the pipe, which is what makes the engine flush and exit by itself,
        // and `kill_on_drop` on the supervisor's child stops an orphan either way.
        self.closed.store(true, Ordering::SeqCst);
        if let Ok(mut state) = self.start.try_lock() {
            state.running = None;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn options() -> McpWatchOptions {
        McpWatchOptions::builder()
            .engine_command(["definitely-not-a-real-engine-binary"])
            .start_timeout(Duration::from_millis(200))
            .call_timeout(Duration::from_millis(200))
            .build()
    }

    #[tokio::test]
    async fn fail_closed_refuses_a_request() {
        let engine = Engine::new("t", options()).unwrap();
        let call = serde_json::json!({
            "jsonrpc": "2.0", "id": 1, "method": "tools/call",
            "params": { "name": "read_file" }
        });
        let outcome = engine.check_from_client("s", call, None).await;
        assert_eq!(outcome.forward, Verdict::Drop);
        let reply = outcome.reply.expect("a refused request is answered");
        assert_eq!(reply["error"]["code"], BLOCKED);
    }

    #[tokio::test]
    async fn fail_closed_still_passes_a_notification() {
        // Nothing can be answered to a notification, so refusing it would strand the sender.
        let engine = Engine::new("t", options()).unwrap();
        let note = serde_json::json!({ "jsonrpc": "2.0", "method": "notifications/initialized" });
        let outcome = engine.check_from_client("s", note.clone(), None).await;
        assert_eq!(outcome.forward, Verdict::Forward(note));
        assert!(outcome.reply.is_none());
    }

    #[tokio::test]
    async fn fail_open_passes_the_original_through() {
        let engine = Engine::new(
            "t",
            McpWatchOptions::builder()
                .engine_command(["definitely-not-a-real-engine-binary"])
                .start_timeout(Duration::from_millis(200))
                .call_timeout(Duration::from_millis(200))
                .fail_open(true)
                .build(),
        )
        .unwrap();
        let call = serde_json::json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/call" });
        let outcome = engine.check_from_client("s", call.clone(), None).await;
        assert_eq!(outcome.forward, Verdict::Forward(call));
        assert!(outcome.reply.is_none());
    }

    #[tokio::test]
    async fn start_reports_a_missing_engine() {
        let engine = Engine::new("t", options()).unwrap();
        assert!(engine.start().await.is_err());
    }

    #[tokio::test]
    async fn disabled_creates_nothing() {
        let options = McpWatchOptions::builder().enabled(false).build();
        assert!(Engine::create_if_enabled("t", options).await.is_none());
    }

    #[test]
    fn an_unchanged_message_keeps_its_original() {
        let original = serde_json::json!({ "jsonrpc": "2.0", "id": 1 });
        let answer = serde_json::json!({ "forward": original.clone(), "reply": null });
        assert_eq!(
            Engine::verdict(&answer, original.clone()),
            Verdict::Forward(original)
        );
    }

    #[test]
    fn a_rewritten_message_is_a_replacement() {
        let original = serde_json::json!({ "id": 1, "result": { "tools": ["a", "b"] } });
        let rewritten = serde_json::json!({ "id": 1, "result": { "tools": ["a"] } });
        let answer = serde_json::json!({ "forward": rewritten.clone() });
        assert_eq!(
            Engine::verdict(&answer, original),
            Verdict::Replace(rewritten)
        );
    }

    #[test]
    fn a_missing_forward_is_a_drop() {
        let answer = serde_json::json!({ "forward": null, "reply": { "error": {} } });
        assert_eq!(
            Engine::verdict(&answer, serde_json::json!({ "id": 1 })),
            Verdict::Drop
        );
    }
}
