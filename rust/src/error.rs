use std::fmt;
use std::time::Duration;

/// Why the guard could not reach its engine.
///
/// This reaches your code only from [`Engine::start`](crate::Engine::start). The checks themselves
/// never hand it back: they answer with an [`Outcome`](crate::Outcome), and the `failOpen` setting
/// decides what an unreachable engine means. A security tool that turns a transient hiccup into a
/// dropped connection becomes an availability incident, and then it gets switched off.
#[derive(Debug)]
#[non_exhaustive]
pub enum EngineUnavailable {
    /// Neither `mcpwatch` nor `npx` is on the PATH.
    NotInstalled,
    /// The child process could not be started at all.
    Spawn {
        command: String,
        source: std::io::Error,
    },
    /// Started, but no handshake: it timed out, or it exited first.
    DidNotStart { detail: String },
    /// The engine exited while calls were waiting on it.
    Exited { code: Option<i32> },
    /// A start failed recently; we are not respawning a crashing engine on every message.
    RestartingSoon { retry_in: Duration },
    /// Another caller held the start lock for longer than this one would wait for an answer.
    Busy { waited: Duration },
    /// The engine did not answer in time.
    Timeout { waited: Duration },
    /// The engine answered with an error of its own, and no message to forward.
    Refused { message: String },
    /// The guard has been closed.
    Closed,
}

impl fmt::Display for EngineUnavailable {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::NotInstalled => write!(
                f,
                "Node.js 20+ is needed: install it, then `npm install -g {}`",
                crate::NPM_PACKAGE
            ),
            Self::Spawn { command, source } => write!(f, "could not start {command}: {source}"),
            Self::DidNotStart { detail } => write!(f, "the engine did not start: {detail}"),
            Self::Exited { code } => match code {
                Some(c) => write!(f, "the engine exited (code {c})"),
                None => write!(f, "the engine exited"),
            },
            Self::RestartingSoon { retry_in } => write!(
                f,
                "the engine stopped; retrying in {} ms",
                retry_in.as_millis()
            ),
            Self::Busy { waited } => {
                write!(f, "the engine was busy for {} ms", waited.as_millis())
            }
            Self::Timeout { waited } => {
                write!(f, "the engine did not answer in {} ms", waited.as_millis())
            }
            Self::Refused { message } => write!(f, "{message}"),
            Self::Closed => write!(f, "the guard has been closed"),
        }
    }
}

impl std::error::Error for EngineUnavailable {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Spawn { source, .. } => Some(source),
            _ => None,
        }
    }
}

/// What a guarded transport reports to the SDK.
#[derive(Debug)]
#[non_exhaustive]
pub enum GuardError {
    /// The guarded connection has shut down.
    Closed,
    /// The transport underneath failed.
    Inner(Box<dyn std::error::Error + Send + Sync>),
}

impl fmt::Display for GuardError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Closed => write!(f, "the guarded transport is closed"),
            Self::Inner(e) => write!(f, "{e}"),
        }
    }
}

impl std::error::Error for GuardError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Inner(e) => Some(&**e),
            Self::Closed => None,
        }
    }
}
