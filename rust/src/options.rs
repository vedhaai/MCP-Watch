use std::path::PathBuf;
use std::time::Duration;

use serde::Serialize;
use serde_json::{Map, Value};

/// What the guard does with the messages it checks.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Mode {
    /// Everything passes, unchecked.
    Off,
    /// Check and report, but never refuse.
    Observe,
    /// Refuse high severity.
    Protect,
    /// Also throttle and block on the session score.
    Enforce,
}

impl Mode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Off => "off",
            Self::Observe => "observe",
            Self::Protect => "protect",
            Self::Enforce => "enforce",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "off" => Some(Self::Off),
            "observe" => Some(Self::Observe),
            "protect" => Some(Self::Protect),
            "enforce" => Some(Self::Enforce),
            _ => None,
        }
    }
}

/// Clients to block or always allow, overriding the rules in every mode.
#[derive(Debug, Clone, Default, Serialize)]
pub struct Clients {
    pub block: Vec<String>,
    pub allow: Vec<String>,
}

/// Settings for one guarded server, as the Node middleware's options.
///
/// Everything is optional. What you leave out comes from the `MCPWATCH_*` environment variables,
/// which the engine reads itself, exactly as for a Node, Python or Java server. With a project key,
/// the project's settings in the dashboard win over both, and reach the guard within 5 seconds.
///
/// The field names are the engine's own, in camelCase, produced mechanically by serde so the option
/// list cannot drift from the engine's. Because this is a typed builder rather than a map, a
/// mistyped option is a **compile error** — the engine itself does not validate unknown keys, and
/// silently ignoring `faliOpen` is exactly the sort of quiet hole a guard must not have.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineOptions {
    #[serde(skip_serializing_if = "Option::is_none")]
    key: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    server: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    local_log: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    poll_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    mode: Option<Mode>,
    #[serde(skip_serializing_if = "Option::is_none")]
    events_file: Option<PathBuf>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pins_file: Option<PathBuf>,
    #[serde(skip_serializing_if = "Option::is_none")]
    registry_file: Option<PathBuf>,
    #[serde(skip_serializing_if = "Option::is_none")]
    window_seconds: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    throttle_at: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    block_at: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    max_calls_per_window: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    max_arg_bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    max_result_bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    allow_tools: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    deny_tools: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    clients: Option<Clients>,
    #[serde(skip_serializing_if = "Option::is_none")]
    allowed_origins: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    allowed_hosts: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    require_auth: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    expected_audience: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    fail_open: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    ai: Option<Value>,
    /// Any engine option this crate has no method for yet.
    #[serde(flatten)]
    extra: Map<String, Value>,
}

/// Settings for one guarded server.
///
/// ```no_run
/// use mcpwatch::{McpWatchOptions, Mode};
///
/// let options = McpWatchOptions::builder()
///     .project_key("mw_...")
///     .mode(Mode::Enforce)
///     .deny_tools(["run_command"])
///     .build();
/// ```
#[derive(Debug, Clone)]
pub struct McpWatchOptions {
    pub(crate) engine: EngineOptions,
    pub(crate) enabled: Option<bool>,
    pub(crate) engine_command: Option<Vec<String>>,
    pub(crate) start_timeout: Duration,
    pub(crate) call_timeout: Duration,
    pub(crate) restart_backoff: Duration,
    pub(crate) channel_capacity: usize,
}

impl Default for McpWatchOptions {
    fn default() -> Self {
        Self {
            engine: EngineOptions::default(),
            enabled: None,
            engine_command: None,
            // The first run may fetch the engine with npx, which is slow but not broken.
            start_timeout: Duration::from_secs(120),
            call_timeout: Duration::from_secs(60),
            restart_backoff: Duration::from_secs(10),
            channel_capacity: 64,
        }
    }
}

impl McpWatchOptions {
    /// Options with nothing set: everything comes from the environment and the dashboard.
    pub fn new() -> Self {
        Self::default()
    }

    pub fn builder() -> Builder {
        Builder {
            options: Self::default(),
        }
    }

    /// Whether the guard runs at all. `MCPWATCH_ENABLED=0` turns it off, so a server can be started
    /// unguarded without touching its code.
    pub fn is_enabled(&self) -> bool {
        if let Some(enabled) = self.enabled {
            return enabled;
        }
        std::env::var("MCPWATCH_ENABLED").as_deref() != Ok("0")
    }

    /// True when the guard passes messages through if the engine cannot be reached. The default is
    /// false: requests are refused.
    pub fn is_fail_open(&self) -> bool {
        self.engine.fail_open.unwrap_or(false)
    }

    /// The mode asked for in code or the environment, before the engine reports its own.
    pub fn requested_mode(&self) -> Mode {
        if let Some(mode) = self.engine.mode {
            return mode;
        }
        std::env::var("MCPWATCH_MODE")
            .ok()
            .and_then(|m| Mode::parse(&m))
            .unwrap_or(Mode::Enforce)
    }

    /// The options as the engine's `MCPWATCH_ENGINE_OPTIONS` payload.
    pub(crate) fn to_engine_options(&self, name: &str) -> Result<Vec<u8>, serde_json::Error> {
        #[derive(Serialize)]
        struct Wire<'a> {
            name: &'a str,
            #[serde(flatten)]
            options: &'a EngineOptions,
        }
        serde_json::to_vec(&Wire {
            name,
            options: &self.engine,
        })
    }
}

/// Builds [`McpWatchOptions`].
#[derive(Debug, Clone)]
pub struct Builder {
    options: McpWatchOptions,
}

macro_rules! setter {
    ($(#[$doc:meta])* $name:ident, $field:ident, $ty:ty) => {
        $(#[$doc])*
        pub fn $name(mut self, value: $ty) -> Self {
            self.options.engine.$field = Some(value);
            self
        }
    };
}

macro_rules! list_setter {
    ($(#[$doc:meta])* $name:ident, $field:ident) => {
        $(#[$doc])*
        pub fn $name<I, S>(mut self, values: I) -> Self
        where
            I: IntoIterator<Item = S>,
            S: Into<String>,
        {
            self.options.engine.$field =
                Some(values.into_iter().map(Into::into).collect());
            self
        }
    };
}

impl Builder {
    /// The project key from the dashboard: events go to that project and its settings apply live.
    pub fn project_key(mut self, key: impl Into<String>) -> Self {
        self.options.engine.key = Some(key.into());
        self
    }

    /// The dashboard URL (default `http://127.0.0.1:9100`).
    pub fn server(mut self, url: impl Into<String>) -> Self {
        self.options.engine.server = Some(url.into());
        self
    }

    setter!(
        /// `Off`, `Observe`, `Protect` or `Enforce`.
        mode,
        mode,
        Mode
    );
    setter!(
        /// What to do when the engine cannot be reached: false (the default, as in the Node engine)
        /// refuses requests with a JSON-RPC error, true passes messages through unchecked.
        fail_open,
        fail_open,
        bool
    );
    setter!(
        /// HTTP: refuse requests with no `Authorization` or `X-API-Key` header (MW031).
        require_auth,
        require_auth,
        bool
    );
    setter!(local_log, local_log, bool);
    setter!(poll_ms, poll_ms, u64);
    setter!(window_seconds, window_seconds, u32);
    setter!(throttle_at, throttle_at, u32);
    setter!(block_at, block_at, u32);
    setter!(max_calls_per_window, max_calls_per_window, u32);
    setter!(max_arg_bytes, max_arg_bytes, u64);
    setter!(max_result_bytes, max_result_bytes, u64);
    setter!(events_file, events_file, PathBuf);
    setter!(pins_file, pins_file, PathBuf);
    setter!(registry_file, registry_file, PathBuf);

    list_setter!(deny_tools, deny_tools);
    list_setter!(allow_tools, allow_tools);
    list_setter!(
        /// HTTP: the web origins allowed to call the server. Others are refused (MW030).
        allowed_origins,
        allowed_origins
    );
    list_setter!(
        /// HTTP: the host names the server answers to (default: not checked).
        allowed_hosts,
        allowed_hosts
    );

    /// HTTP: refuse JWT bearer tokens whose `aud` does not include this (MW036).
    pub fn expected_audience(mut self, audience: impl Into<String>) -> Self {
        self.options.engine.expected_audience = Some(audience.into());
        self
    }

    /// Turns the AI reviewer on with its defaults (local Ollama, `qwen2.5:7b`).
    pub fn ai(mut self, enabled: bool) -> Self {
        self.options.engine.ai = Some(serde_json::json!({ "enabled": enabled }));
        self
    }

    /// The AI reviewer's settings: `enabled`, `url`, `model`, `apiKey`, …
    pub fn ai_settings(mut self, settings: Value) -> Self {
        self.options.engine.ai = Some(settings);
        self
    }

    /// Clients to block or always allow, overriding the rules in every mode.
    pub fn clients(mut self, clients: Clients) -> Self {
        self.options.engine.clients = Some(clients);
        self
    }

    /// Any option the engine takes, by its own name, for settings this builder has no method for.
    pub fn option(mut self, name: impl Into<String>, value: Value) -> Self {
        self.options.engine.extra.insert(name.into(), value);
        self
    }

    /// False turns the guard off: the server runs untouched.
    pub fn enabled(mut self, enabled: bool) -> Self {
        self.options.enabled = Some(enabled);
        self
    }

    /// How to start the engine, when it is not `mcpwatch` on the PATH and `MCPWATCH_ENGINE` is not
    /// set. The `engine` argument is added for you.
    pub fn engine_command<I, S>(mut self, command: I) -> Self
    where
        I: IntoIterator<Item = S>,
        S: Into<String>,
    {
        self.options.engine_command = Some(command.into_iter().map(Into::into).collect());
        self
    }

    /// How long to wait for the engine to start. The first run may fetch it with npx.
    pub fn start_timeout(mut self, timeout: Duration) -> Self {
        self.options.start_timeout = timeout;
        self
    }

    /// How long to wait for one message to be checked.
    pub fn call_timeout(mut self, timeout: Duration) -> Self {
        self.options.call_timeout = timeout;
        self
    }

    /// How long to wait before respawning an engine that stopped.
    pub fn restart_backoff(mut self, backoff: Duration) -> Self {
        self.options.restart_backoff = backoff;
        self
    }

    /// How many messages may wait in each direction before the guard pushes back.
    ///
    /// Bounded on purpose: a guard whose queue grows without limit is a memory amplifier, which is
    /// a poor thing for a tool whose job is to stop abuse.
    pub fn channel_capacity(mut self, capacity: usize) -> Self {
        self.options.channel_capacity = capacity.max(1);
        self
    }

    pub fn build(self) -> McpWatchOptions {
        self.options
    }
}
