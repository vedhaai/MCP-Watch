//! `mcpwatch-proxy`: guards an MCP server whose code you cannot change.
//!
//! ```text
//! mcpwatch-proxy [--name <server>] [--mode <mode>] [--max-line-bytes <n>] -- <command> [args...]
//! ```
//!
//! It sits between the client's stdin/stdout and the server it starts, and asks the engine about
//! every message each way.
//!
//! **This does not remove the Node dependency.** Every rule, the AI reviewer and the dashboard
//! reporting live in the Node engine, which this binary starts as a sidecar exactly as the Python
//! and Java guards do. A machine running `mcpwatch-proxy` still needs Node. What it does buy is a
//! deterministic launch — no `npx` resolving (and possibly fetching) on every cold start — and one
//! signed artifact to distribute instead of an npm tree.

use std::process::Stdio;

use mcpwatch::{Engine, McpWatchOptions, Mode, Verdict};
use serde_json::Value;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::sync::mpsc;

const USAGE: &str = "\
mcpwatch-proxy: a guard in front of an MCP server you cannot change.

  mcpwatch-proxy [options] -- <command> [args...]

Options:
  --name <server>         the name this server reports under (default: the command)
  --mode <mode>           off, observe, protect or enforce
  --max-line-bytes <n>    drop a single message larger than this (default: 10000000)
  --help                  this message

Everything else comes from the MCPWATCH_* environment variables, and from the
dashboard when a project key is set.";

struct Args {
    name: Option<String>,
    mode: Option<Mode>,
    max_line_bytes: usize,
    command: Vec<String>,
}

fn parse_args() -> Result<Args, String> {
    let mut args = Args {
        name: None,
        mode: None,
        max_line_bytes: 10_000_000,
        command: Vec::new(),
    };
    let mut argv = std::env::args().skip(1);
    while let Some(arg) = argv.next() {
        match arg.as_str() {
            "--" => {
                args.command = argv.collect();
                break;
            }
            "--help" | "-h" => return Err(String::new()),
            "--name" => args.name = Some(argv.next().ok_or("--name needs a value")?),
            "--mode" => {
                let value = argv.next().ok_or("--mode needs a value")?;
                args.mode = Some(Mode::parse(&value).ok_or(format!("unknown mode \"{value}\""))?);
            }
            "--max-line-bytes" => {
                let value = argv.next().ok_or("--max-line-bytes needs a value")?;
                args.max_line_bytes = value
                    .parse()
                    .map_err(|_| format!("--max-line-bytes needs a number, not \"{value}\""))?;
            }
            other => return Err(format!("unknown option \"{other}\"")),
        }
    }
    if args.command.is_empty() {
        return Err("no server command: put it after `--`".into());
    }
    Ok(args)
}

#[tokio::main]
async fn main() {
    let args = match parse_args() {
        Ok(args) => args,
        Err(message) => {
            if message.is_empty() {
                println!("{USAGE}");
                std::process::exit(0);
            }
            eprintln!("[mcpwatch] {message}\n\n{USAGE}");
            std::process::exit(2);
        }
    };

    let name = args.name.clone().unwrap_or_else(|| args.command[0].clone());

    let mut builder = McpWatchOptions::builder();
    if let Some(mode) = args.mode {
        builder = builder.mode(mode);
    }
    let options = builder.build();
    let enabled = options.is_enabled();
    let engine = if enabled {
        Engine::create_if_enabled(&name, options).await
    } else {
        None
    };

    let mut child = match tokio::process::Command::new(&args.command[0])
        .args(&args.command[1..])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        // The server's own logs belong to the user, not to us.
        .stderr(Stdio::inherit())
        .kill_on_drop(true)
        .spawn()
    {
        Ok(child) => child,
        Err(e) => {
            eprintln!("[mcpwatch] could not start {}: {e}", args.command[0]);
            std::process::exit(2);
        }
    };

    let child_stdin = child.stdin.take().expect("stdin was piped");
    let child_stdout = child.stdout.take().expect("stdout was piped");

    // One writer per sink, so a line is never interleaved with another, and both directions can
    // write to either sink: a refused client call is answered to the client, and a refused
    // sampling request is answered to the server.
    let (to_client, client_rx) = mpsc::channel::<Vec<u8>>(64);
    let (to_child, child_rx) = mpsc::channel::<Vec<u8>>(64);
    tokio::spawn(write_lines(tokio::io::stdout(), client_rx));
    tokio::spawn(write_lines(child_stdin, child_rx));

    let session = format!("proxy-{}", std::process::id());

    // Each direction is read and checked strictly in order, which is what keeps a slow AI review
    // from letting a later message overtake an earlier one.
    let from_client = tokio::spawn(pump(
        tokio::io::stdin(),
        engine.clone(),
        session.clone(),
        Direction::FromClient,
        to_child.clone(),
        to_client.clone(),
        args.max_line_bytes,
    ));
    let from_server = tokio::spawn(pump(
        child_stdout,
        engine.clone(),
        session.clone(),
        Direction::FromServer,
        to_client.clone(),
        to_child.clone(),
        args.max_line_bytes,
    ));

    let status = child.wait().await;
    // Let the server's last words through before going.
    let _ = tokio::time::timeout(std::time::Duration::from_secs(2), from_server).await;
    from_client.abort();
    if let Some(engine) = &engine {
        engine.shutdown().await;
    }

    let code = status.ok().and_then(|s| s.code()).unwrap_or(1);
    std::process::exit(code);
}

#[derive(Clone, Copy, PartialEq)]
enum Direction {
    FromClient,
    FromServer,
}

/// Reads one side, checks each message, and forwards what survives.
#[allow(clippy::too_many_arguments)]
async fn pump<R>(
    read: R,
    engine: Option<Engine>,
    session: String,
    direction: Direction,
    forward_to: mpsc::Sender<Vec<u8>>,
    reply_to: mpsc::Sender<Vec<u8>>,
    max_line_bytes: usize,
) where
    R: AsyncRead + Unpin + Send + 'static,
{
    let mut lines = Lines::new(read, max_line_bytes);
    while let Some(line) = lines.next().await {
        let Ok(message) = serde_json::from_slice::<Value>(&line) else {
            // Not JSON: not ours to judge. Let the other end's parser decide.
            if forward_to.send(line).await.is_err() {
                break;
            }
            continue;
        };

        let outcome = match &engine {
            None => mcpwatch::Outcome::pass(message),
            Some(engine) => match direction {
                Direction::FromClient => engine.check_from_client(&session, message, None).await,
                // Not strict: a stdio server has no forgeable channel, so MW037 would only ever
                // flag the server's own messages.
                Direction::FromServer => engine.check_from_server(&session, message, false).await,
            },
        };

        if let Some(reply) = outcome.reply
            && let Ok(mut bytes) = serde_json::to_vec(&reply)
        {
            bytes.push(b'\n');
            if reply_to.send(bytes).await.is_err() {
                break;
            }
        }

        let out = match outcome.forward {
            // Unchanged: send the bytes exactly as they arrived, rather than re-serialising them.
            Verdict::Forward(_) => line,
            Verdict::Replace(message) => match serde_json::to_vec(&message) {
                Ok(mut bytes) => {
                    bytes.push(b'\n');
                    bytes
                }
                Err(_) => continue,
            },
            Verdict::Drop => continue,
        };
        if forward_to.send(out).await.is_err() {
            break;
        }
    }
}

/// Writes whole lines to one sink, flushing each: an MCP client blocks on a line.
async fn write_lines<W>(mut write: W, mut queue: mpsc::Receiver<Vec<u8>>)
where
    W: AsyncWrite + Unpin,
{
    while let Some(line) = queue.recv().await {
        if write.write_all(&line).await.is_err() || write.flush().await.is_err() {
            break;
        }
    }
}

/// Newline-delimited reading with a cap.
///
/// Not `AsyncBufReadExt::lines`, which needs valid UTF-8 and fails the whole stream on one bad
/// byte. An over-long line is dropped and the stream resynchronises to the next newline: one
/// oversized frame from a hostile server should not end a working session, and buffering it
/// without limit is how a guard becomes the memory exhaustion it was meant to prevent.
struct Lines<R> {
    read: R,
    buffer: Vec<u8>,
    max: usize,
    /// True while discarding the tail of a line that was already too long.
    skipping: bool,
    done: bool,
}

impl<R: AsyncRead + Unpin> Lines<R> {
    fn new(read: R, max: usize) -> Self {
        Self {
            read,
            buffer: Vec::new(),
            max,
            skipping: false,
            done: false,
        }
    }

    async fn next(&mut self) -> Option<Vec<u8>> {
        loop {
            if let Some(line) = self.take_line() {
                return Some(line);
            }
            if self.done {
                // A final chunk with no newline is still a message.
                if self.buffer.is_empty() || self.skipping {
                    return None;
                }
                let mut line = std::mem::take(&mut self.buffer);
                line.push(b'\n');
                return Some(line);
            }
            let mut chunk = [0u8; 8192];
            match self.read.read(&mut chunk).await {
                Ok(0) | Err(_) => self.done = true,
                Ok(n) => self.buffer.extend_from_slice(&chunk[..n]),
            }
        }
    }

    fn take_line(&mut self) -> Option<Vec<u8>> {
        loop {
            match self.buffer.iter().position(|b| *b == b'\n') {
                Some(at) => {
                    let mut line: Vec<u8> = self.buffer.drain(..=at).collect();
                    if self.skipping {
                        self.skipping = false;
                        continue;
                    }
                    // A CRLF-terminated line is the same message.
                    if line.len() >= 2 && line[line.len() - 2] == b'\r' {
                        line.remove(line.len() - 2);
                    }
                    return Some(line);
                }
                None => {
                    if self.buffer.len() > self.max {
                        if !self.skipping {
                            log::warn!(
                                "[mcpwatch] dropped a message larger than {} bytes",
                                self.max
                            );
                        }
                        self.skipping = true;
                        self.buffer.clear();
                    }
                    return None;
                }
            }
        }
    }
}
