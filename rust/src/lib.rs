//! Security guard for MCP servers in Rust.
//!
//! | You have | Use |
//! |---|---|
//! | A server built with the official Rust SDK (`rmcp`) | `McpWatch::guard_stdio` around its transport |
// These are written out rather than linked: an intra-doc link to a feature-gated item breaks
// `cargo doc` for anyone not enabling that feature. `tests/readme_api.rs` names each path instead,
// so a rename still cannot leave this table wrong.
//! | axum, or anything that speaks tower | `mcpwatch::http::tower::McpWatchLayer` |
//! | actix-web | `mcpwatch::http::actix::McpWatch` |
//! | A server you cannot change | the `mcpwatch-proxy` binary |
//!
//! ```no_run
//! # async fn example() -> Result<(), Box<dyn std::error::Error>> {
//! use mcpwatch::{McpWatch, McpWatchOptions};
//!
//! let watch = McpWatch::start("my-tools", McpWatchOptions::new()).await;
//! # Ok(()) }
//! ```
//!
//! The checks run in the MCPWatch engine (Node 20+), started as a child process. This crate moves
//! messages and keeps them in order; it decides nothing itself, so a Rust server gets exactly the
//! verdicts a Node, Python or Java one would.
#![cfg_attr(docsrs, feature(doc_cfg))]
#![forbid(unsafe_code)]

mod command;
mod engine;
mod error;
mod options;
mod outcome;

pub mod http;

#[cfg(feature = "rmcp")]
#[cfg_attr(docsrs, doc(cfg(feature = "rmcp")))]
pub mod sdk;

#[cfg(feature = "rmcp")]
pub use sdk::GuardedTransport;

pub use engine::{BoxFuture, Engine, Verdicts};
pub use error::{EngineUnavailable, GuardError};
pub use options::{Builder, Clients, EngineOptions, McpWatchOptions, Mode};
pub use outcome::{BLOCKED, HttpInfo, Outcome, THROTTLED, Verdict, error_reply};

/// The npm package that carries the engine.
pub const NPM_PACKAGE: &str = "@vedhaai/mcpwatch";

/// A started guard, or a guard that is deliberately switched off.
///
/// `None` inside means MCPWatch is off (`enabled(false)` or `MCPWATCH_ENABLED=0`), in which case
/// every `guard_*` returns the thing it was given, untouched: no child process, no tasks, no
/// channels.
#[derive(Clone)]
pub struct McpWatch {
    engine: Option<Engine>,
}

impl McpWatch {
    /// Starts the engine for one guarded server.
    ///
    /// Never fails outwards: a guard that cannot start its engine logs the reason, and `fail_open`
    /// decides what happens to messages until it comes up.
    pub async fn start(name: impl Into<String>, options: McpWatchOptions) -> Self {
        Self {
            engine: Engine::create_if_enabled(name, options).await,
        }
    }

    /// Starts the engine, reporting why it could not be reached.
    ///
    /// For a hardened deployment that would rather not boot at all than run unguarded.
    pub async fn try_start(
        name: impl Into<String>,
        options: McpWatchOptions,
    ) -> Result<Self, EngineUnavailable> {
        if !options.is_enabled() {
            return Ok(Self { engine: None });
        }
        let engine = Engine::new(name, options).map_err(|e| EngineUnavailable::Refused {
            message: format!("the options could not be encoded: {e}"),
        })?;
        engine.start().await?;
        Ok(Self {
            engine: Some(engine),
        })
    }

    /// Wraps an engine that is already started, for a host that manages its lifetime itself.
    pub fn from_engine(engine: Engine) -> Self {
        Self {
            engine: Some(engine),
        }
    }

    /// The engine behind this guard, or `None` when MCPWatch is off.
    pub fn engine(&self) -> Option<&Engine> {
        self.engine.as_ref()
    }

    /// True when this guard is actually checking anything.
    pub fn is_on(&self) -> bool {
        self.engine.is_some()
    }

    /// Lets the engine send its queued events and exit.
    pub async fn shutdown(&self) {
        if let Some(engine) = &self.engine {
            engine.shutdown().await;
        }
    }
}
