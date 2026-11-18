// Package httpguard is the framework-free half of the HTTP guard: it decides, and names no
// web framework at all.
//
// It is a port of the engine's own http-proxy.ts, as the Python, Java and Rust adapters each
// carry one. When the proxy's behaviour changes, all of them change together - so prefer
// fixing something here over fixing it in a caller.
package httpguard

import (
	"bytes"
	"context"
	"encoding/json"
	"strings"

	mcpwatch "github.com/vedhaai/MCP-Watch/go"
)

// RefusedBody is what a refused transport check sends back.
const RefusedBody = "Refused by MCPWatch"

// DefaultMaxBodyBytes is the largest request body the guard will read.
const DefaultMaxBodyBytes = 10_000_000

// Action is what the caller should do with a request.
type Action int

const (
	// Pass means carry on to the application. Decision.Rewritten is non-nil only when the
	// guard changed the body.
	Pass Action = iota
	// Refuse means answer 403 text/plain with RefusedBody. The application is never called.
	Refuse
	// Reply means answer 200 application/json with Decision.Body. The application is never
	// called.
	//
	// 200 and not 4xx: a JSON-RPC error is a successful HTTP response carrying an error
	// object, and a client that sees a 403 reports a transport failure instead of the rule
	// that fired.
	Reply
)

// Decision is what to do with one request.
type Decision struct {
	Action    Action
	Body      []byte // Reply only
	Rewritten []byte // Pass only; nil means hand the application the bytes that arrived
}

// RequestCheck carries a decision plus what the response side needs to know.
type RequestCheck struct {
	Decision Decision

	session string
	strict  bool
	method  string
}

// Session is the name this request's session is known by.
func (c *RequestCheck) Session() string { return c.session }

// Strict reports whether a server message on this session may be judged as forged when it
// answers nothing the client asked for.
func (c *RequestCheck) Strict() bool { return c.strict }

// Method is the HTTP method.
func (c *RequestCheck) Method() string { return c.method }

// Config configures a Guard.
type Config struct {
	// Paths to guard. Empty, or a single "*", guards everything. A path guards itself and
	// anything under it: "/mcp" covers /mcp, /mcp/ and /mcp/messages, but not /mcpx.
	Paths []string
	// MaxBodyBytes caps the request body. 0 means DefaultMaxBodyBytes.
	MaxBodyBytes int
}

// Guard decides what happens to an HTTP request carrying MCP traffic.
type Guard struct {
	v     mcpwatch.Verdicts
	paths []string
	all   bool
	max   int
}

// New builds a guard.
func New(v mcpwatch.Verdicts, cfg Config) *Guard {
	g := &Guard{v: v, max: cfg.MaxBodyBytes}
	if g.max <= 0 {
		g.max = DefaultMaxBodyBytes
	}
	for _, p := range cfg.Paths {
		if p == "*" || p == "" {
			g.all = true
			continue
		}
		g.paths = append(g.paths, strings.TrimSuffix(p, "/"))
	}
	if len(g.paths) == 0 {
		g.all = true
	}
	return g
}

// MaxBodyBytes is the configured body cap.
func (g *Guard) MaxBodyBytes() int { return g.max }

// Matches reports whether a path is guarded.
func (g *Guard) Matches(path string) bool {
	if g.all {
		return true
	}
	path = strings.TrimSuffix(path, "/")
	for _, p := range g.paths {
		if path == p || strings.HasPrefix(path, p+"/") {
			return true
		}
	}
	return false
}

// CheckRequest judges one HTTP request.
func (g *Guard) CheckRequest(ctx context.Context, method string, info *mcpwatch.HTTPInfo, body []byte) *RequestCheck {
	// The session is named by the client's session header when there is one, and otherwise by
	// where the request came from. strict follows the header's PRESENCE, not its value: an
	// empty Mcp-Session-Id still means the client is on an established session, so a server
	// message answering nothing it asked for is forged. The asymmetry is deliberate and
	// shared with every other adapter.
	header := info.Get("mcp-session-id")
	strict := info.Has("mcp-session-id")
	session := header
	if session == "" {
		remote := "unknown"
		if info != nil && info.RemoteAddress != nil {
			remote = *info.RemoteAddress
		}
		session = "http-" + remote
	}
	check := &RequestCheck{session: session, strict: strict, method: strings.ToUpper(method)}

	if check.method != "POST" {
		if g.v.FromHTTP(ctx, session, info, check.method) {
			check.Decision = Decision{Action: Refuse}
		}
		return check
	}

	messages, batch, ok := splitBody(body)
	if !ok {
		// Not JSON-RPC. Not ours to judge; the application decides what it is.
		return check
	}

	forwards := make([]json.RawMessage, len(messages))
	replies := make([]json.RawMessage, len(messages))
	anyReply, anyChange := false, false

	for i, msg := range messages {
		if !isObject(msg) {
			// A non-object entry in a batch is passed through exactly as it arrived, never
			// dropped and never nulled: it is the application's error to report, not ours.
			forwards[i] = msg
			continue
		}
		out := g.v.FromClient(ctx, session, msg, info)
		forwards[i] = out.Forward
		replies[i] = out.Reply
		if len(out.Reply) > 0 {
			anyReply = true
		}
		if out.Modified || out.Dropped() {
			anyChange = true
		}
	}

	if anyReply {
		check.Decision = Decision{Action: Reply, Body: g.refusal(messages, replies, batch)}
		return check
	}
	if anyChange {
		check.Decision = Decision{Action: Pass, Rewritten: rejoin(forwards, batch)}
	}
	return check
}

// refusal builds the body that answers a refused request.
//
// For a batch, every message that carries an id gets an answer, even the ones that were not
// themselves refused: a client waiting on an id that never comes back waits for ever.
func (g *Guard) refusal(messages, replies []json.RawMessage, batch bool) []byte {
	if !batch {
		if len(replies) > 0 && len(replies[0]) > 0 {
			return replies[0]
		}
		return mcpwatch.ErrorReply(json.RawMessage("null"), mcpwatch.CodeBlocked, "Blocked by MCPWatch")
	}
	var out []json.RawMessage
	for i, msg := range messages {
		if len(replies[i]) > 0 {
			out = append(out, replies[i])
			continue
		}
		id := mcpwatch.IDOf(msg)
		if bytes.Equal(id, []byte("null")) {
			continue // a notification expects no answer
		}
		out = append(out, mcpwatch.ErrorReply(id, mcpwatch.CodeBlocked, "Batch refused by MCPWatch"))
	}
	joined, err := json.Marshal(out)
	if err != nil {
		return mcpwatch.ErrorReply(json.RawMessage("null"), mcpwatch.CodeBlocked, "Blocked by MCPWatch")
	}
	return joined
}

// Response prepares the filter for this request's response, and renames the session if the
// server has just issued its real id.
func (g *Guard) Response(ctx context.Context, check *RequestCheck, headers *mcpwatch.HTTPInfo) *ResponseFilter {
	if id := headers.Get("mcp-session-id"); id != "" && id != check.session {
		// Without this, the state built up under the provisional name - everything the
		// initialize handshake established - is stranded.
		g.v.RenameSession(check.session, id)
		check.session = id
	}
	kind := KindRaw
	switch ct := strings.ToLower(headers.Get("content-type")); {
	case strings.Contains(ct, "text/event-stream"):
		kind = KindSSE
	case strings.Contains(ct, "application/json"):
		kind = KindJSON
	}
	return &ResponseFilter{g: g, check: check, kind: kind}
}

// Finished is called when the exchange is over.
func (g *Guard) Finished(check *RequestCheck) {
	if check.method == "DELETE" {
		g.v.DropSession(check.session)
	}
}

// Kind is how a response body must be treated.
type Kind int

const (
	// KindRaw is anything that is not MCP traffic: passed through untouched.
	KindRaw Kind = iota
	// KindJSON is a single JSON document.
	KindJSON
	// KindSSE is an event stream, checked event by event as it flows.
	KindSSE
)

// splitBody parses a body into one or more JSON-RPC messages.
func splitBody(body []byte) (messages []json.RawMessage, batch bool, ok bool) {
	trimmed := bytes.TrimSpace(body)
	if len(trimmed) == 0 {
		return nil, false, false
	}
	if trimmed[0] == '[' {
		var arr []json.RawMessage
		if err := json.Unmarshal(trimmed, &arr); err != nil {
			return nil, false, false
		}
		return arr, true, true
	}
	if !isObject(trimmed) {
		return nil, false, false
	}
	return []json.RawMessage{trimmed}, false, true
}

func isObject(raw json.RawMessage) bool {
	t := bytes.TrimSpace(raw)
	if len(t) == 0 || t[0] != '{' {
		return false
	}
	var probe map[string]json.RawMessage
	return json.Unmarshal(t, &probe) == nil
}

// rejoin rebuilds a body from the messages that survived.
func rejoin(forwards []json.RawMessage, batch bool) []byte {
	kept := make([]json.RawMessage, 0, len(forwards))
	for _, f := range forwards {
		if len(f) > 0 {
			kept = append(kept, f)
		}
	}
	if !batch {
		if len(kept) == 0 {
			// A single message that was withheld leaves an empty object rather than an empty
			// body: the client is expecting JSON.
			return []byte("{}")
		}
		return kept[0]
	}
	out, err := json.Marshal(kept)
	if err != nil {
		return []byte("[]")
	}
	return out
}
