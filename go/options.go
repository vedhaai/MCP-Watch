package mcpwatch

import (
	"encoding/json"
	"fmt"
	"os"
	"time"
)

// Mode is how hard the guard pushes back. A dashboard project overrides whatever is set
// here - see the note on [Options.ProjectKey].
type Mode string

const (
	// ModeOff passes everything through and records nothing.
	ModeOff Mode = "off"
	// ModeObserve never blocks; it records what Enforce would have done.
	ModeObserve Mode = "observe"
	// ModeProtect blocks high-severity findings only.
	ModeProtect Mode = "protect"
	// ModeEnforce blocks high-severity findings, then throttles by session score.
	ModeEnforce Mode = "enforce"
)

// ParseMode turns a mode name into a [Mode]. The second result is false for anything else.
func ParseMode(s string) (Mode, bool) {
	switch Mode(s) {
	case ModeOff, ModeObserve, ModeProtect, ModeEnforce:
		return Mode(s), true
	}
	return "", false
}

// Clients is the per-client allow and block list.
type Clients struct {
	Block []string `json:"block,omitempty"`
	Allow []string `json:"allow,omitempty"`
}

// Options configures the guard.
//
// The zero value is usable: it starts the engine in enforce mode with the engine's own
// defaults, reports nowhere, and fails closed.
//
// Field names map to the engine's own option names. Anything the engine accepts that has no
// field here can be passed through [Options.Extra] without waiting for a release of this
// package.
type Options struct {
	// ProjectKey reports to a dashboard project.
	//
	// Read it from MCPWATCH_PROJECT_KEY or a key file rather than hard-coding it: a key
	// passed on a command line is visible in process listings.
	//
	// Setting it hands the dashboard authority over this guard. Within about five seconds
	// the project's mode, origins, deny-list and thresholds silently replace whatever is set
	// here, with nothing logged. A server that sets ModeEnforce below and sees nothing
	// blocked is almost always a project still sitting in observe.
	ProjectKey string `json:"key,omitempty"`

	// Server is the dashboard URL. Default http://127.0.0.1:9100.
	Server string `json:"server,omitempty"`

	// LocalLog keeps writing the local events file even when a project key is set. Without
	// it, a key stops the local log.
	LocalLog *bool `json:"localLog,omitempty"`

	// PollMs is how often the dashboard is asked for settings. Default 5000.
	PollMs int `json:"pollMs,omitempty"`

	// Mode defaults to the MCPWATCH_MODE environment variable, then to ModeEnforce.
	Mode Mode `json:"mode,omitempty"`

	EventsFile   string `json:"eventsFile,omitempty"`
	PinsFile     string `json:"pinsFile,omitempty"`
	RegistryFile string `json:"registryFile,omitempty"`

	WindowSeconds     int `json:"windowSeconds,omitempty"`
	ThrottleAt        int `json:"throttleAt,omitempty"`
	BlockAt           int `json:"blockAt,omitempty"`
	MaxCallsPerWindow int `json:"maxCallsPerWindow,omitempty"`
	MaxArgBytes       int `json:"maxArgBytes,omitempty"`
	MaxResultBytes    int `json:"maxResultBytes,omitempty"`

	AllowTools     []string `json:"allowTools,omitempty"`
	DenyTools      []string `json:"denyTools,omitempty"`
	AllowedOrigins []string `json:"allowedOrigins,omitempty"`
	AllowedHosts   []string `json:"allowedHosts,omitempty"`
	Clients        *Clients `json:"clients,omitempty"`

	RequireAuth      *bool  `json:"requireAuth,omitempty"`
	ExpectedAudience string `json:"expectedAudience,omitempty"`

	// FailOpen decides what happens when the engine cannot be reached. False - the default -
	// refuses requests rather than letting them through unchecked. Notifications and
	// responses pass either way: there is nothing to answer them with.
	FailOpen *bool `json:"failOpen,omitempty"`

	// AI turns on the local AI reviewer, or carries its full settings object.
	AI any `json:"ai,omitempty"`

	// Extra is any other engine option, by the engine's own name. It is merged last, so it
	// also overrides a field above if both are set.
	Extra map[string]any `json:"-"`

	// ---- settings for this package rather than the engine; never serialised ----

	// Enabled switches the guard off entirely when it points at false. Default is true
	// unless MCPWATCH_ENABLED is "0". When off, nothing is spawned and every check passes.
	Enabled *bool `json:"-"`

	// EngineCommand overrides how the engine is started, for example
	// []string{"node", "/path/to/engine/dist/cli.js"}. The "engine" subcommand is appended.
	// Falls back to the MCPWATCH_ENGINE environment variable.
	EngineCommand []string `json:"-"`

	// StartTimeout bounds the wait for the engine's handshake. Default 120s.
	//
	// That looks enormous next to a local engine, which handshakes in about 60ms. It is
	// sized for the cold path: with no engine installed the command resolves to
	// `npx -y @vedhaai/mcpwatch`, and the first run downloads the package. Shortening this
	// breaks first starts on a clean machine and nothing else.
	StartTimeout time.Duration `json:"-"`

	// CallTimeout bounds one check. Default 60s - long because an AI review can be slow.
	CallTimeout time.Duration `json:"-"`

	// RestartBackoff is how long to wait before respawning a dead engine, so a crash loop
	// is not restarted once per message. Default 10s.
	RestartBackoff time.Duration `json:"-"`

	// MaxMessageBytes caps one line on the sidecar pipe. Default 16 MiB.
	MaxMessageBytes int `json:"-"`

	// ShutdownTimeout bounds Close. Default 5s.
	ShutdownTimeout time.Duration `json:"-"`

	// Logger receives one-line operational warnings. It must never be given message bodies.
	// Default is log.Printf to stderr; set it to func(string, ...any) {} to silence it.
	//
	// Nothing here writes to stdout: on a stdio MCP server stdout is the protocol.
	Logger func(format string, args ...any) `json:"-"`
}

// Defaults for the adapter-side settings.
const (
	DefaultStartTimeout   = 120 * time.Second
	DefaultCallTimeout    = 60 * time.Second
	DefaultRestartBackoff = 10 * time.Second
)

// IsEnabled reports whether the guard should run at all.
func (o *Options) IsEnabled() bool {
	if o.Enabled != nil {
		return *o.Enabled
	}
	return os.Getenv("MCPWATCH_ENABLED") != "0"
}

// IsFailOpen reports whether an unreachable engine lets requests through.
func (o *Options) IsFailOpen() bool {
	return o.FailOpen != nil && *o.FailOpen
}

// RequestedMode is the mode asked for: the field, then MCPWATCH_MODE, then enforce.
func (o *Options) RequestedMode() Mode {
	if o.Mode != "" {
		return o.Mode
	}
	if m, ok := ParseMode(os.Getenv("MCPWATCH_MODE")); ok {
		return m
	}
	return ModeEnforce
}

func (o *Options) startTimeout() time.Duration {
	if o.StartTimeout > 0 {
		return o.StartTimeout
	}
	return DefaultStartTimeout
}

func (o *Options) callTimeout() time.Duration {
	if o.CallTimeout > 0 {
		return o.CallTimeout
	}
	return DefaultCallTimeout
}

func (o *Options) restartBackoff() time.Duration {
	if o.RestartBackoff > 0 {
		return o.RestartBackoff
	}
	return DefaultRestartBackoff
}

// engineOptions renders what goes into MCPWATCH_ENGINE_OPTIONS: the server's name plus
// every engine setting, flattened into one object.
//
// Options never travel on the command line. The engine reads this one environment variable,
// and that is also what keeps a project key out of process listings.
func (o *Options) engineOptions(name string) ([]byte, error) {
	raw, err := json.Marshal(o)
	if err != nil {
		return nil, fmt.Errorf("mcpwatch: cannot encode options: %w", err)
	}
	var merged map[string]any
	if err := json.Unmarshal(raw, &merged); err != nil {
		return nil, fmt.Errorf("mcpwatch: cannot encode options: %w", err)
	}
	if merged == nil {
		merged = map[string]any{}
	}
	// The mode is resolved here rather than left to the engine, so that MCPWATCH_MODE and
	// the field follow one rule and the handshake can be compared against what was asked.
	merged["mode"] = string(o.RequestedMode())
	for k, v := range o.Extra {
		merged[k] = v
	}
	merged["name"] = name
	return json.Marshal(merged)
}
