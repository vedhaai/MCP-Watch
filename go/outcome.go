package mcpwatch

import (
	"bytes"
	"encoding/json"
	"strings"
)

// JSON-RPC error codes MCPWatch answers with. They match the engine's own constants.
const (
	// CodeBlocked is returned when a message was refused by a rule.
	CodeBlocked = -32001
	// CodeThrottled is returned when a session's score crossed the throttle threshold.
	CodeThrottled = -32002
)

// NPMPackage carries the engine that does the actual checking.
const NPMPackage = "@vedhaai/mcpwatch"

// Outcome is what a check decided.
//
// Forward is the message to pass on; nil means send nothing. When the engine changed
// nothing, Forward is the *same slice* that went in, so a proxy writes the bytes it already
// had rather than the engine's echo of them. That is not an optimisation. The engine runs on
// Node, which parses every JSON number as a float64, so a JSON-RPC id above 2^53 does not
// survive the round trip: id 9007199254740993 comes back as 9007199254740992. Forwarding the
// echo would answer the wrong call.
//
// Reply travels back the way the message came: a blocked client request is answered to the
// client and the tool never runs.
type Outcome struct {
	Forward  json.RawMessage
	Reply    json.RawMessage
	Modified bool
}

// Pass lets a message through untouched.
func Pass(msg json.RawMessage) Outcome { return Outcome{Forward: msg} }

// Dropped reports whether nothing is to be passed on.
func (o Outcome) Dropped() bool { return len(o.Forward) == 0 }

// Blocked reports whether the message was refused and an answer is owed to the sender.
func (o Outcome) Blocked() bool { return o.Dropped() && len(o.Reply) > 0 }

// Rules returns the rule ids (MW001, MB004...) named in a refusal, or nil.
//
// Only the main block path carries them: a withheld server response and a few other refusals
// are built without a rule list, so an empty result does not mean the message was allowed.
// Use [Outcome.Blocked] for that.
func (o Outcome) Rules() []string {
	if len(o.Reply) == 0 {
		return nil
	}
	var shape struct {
		Error struct {
			Data struct {
				Rules []string `json:"rules"`
			} `json:"data"`
		} `json:"error"`
	}
	if err := json.Unmarshal(o.Reply, &shape); err != nil {
		return nil
	}
	return shape.Error.Data.Rules
}

// ErrorReply builds a JSON-RPC error answering the given id.
//
// The id is copied through as raw bytes rather than decoded and re-encoded, so a string id,
// a large integer id or a null id all answer with exactly what the caller sent. Decoding it
// into an any would turn 9007199254740993 into a float64 and answer the wrong call.
func ErrorReply(id json.RawMessage, code int, message string) json.RawMessage {
	if len(id) == 0 {
		id = json.RawMessage("null")
	}
	msg, err := json.Marshal(message)
	if err != nil { // a Go string always marshals; this is belt and braces
		msg = json.RawMessage(`"Blocked by MCPWatch"`)
	}
	var b bytes.Buffer
	b.WriteString(`{"jsonrpc":"2.0","id":`)
	b.Write(id)
	b.WriteString(`,"error":{"code":`)
	b.WriteString(itoa(code))
	b.WriteString(`,"message":`)
	b.Write(msg)
	b.WriteString(`}}`)
	return json.RawMessage(b.Bytes())
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	neg := n < 0
	if neg {
		n = -n
	}
	var buf [20]byte
	i := len(buf)
	for n > 0 {
		i--
		buf[i] = byte('0' + n%10)
		n /= 10
	}
	if neg {
		i--
		buf[i] = '-'
	}
	return string(buf[i:])
}

// HTTPInfo is what the guard knows about the HTTP request that carried a message. A message
// that arrived over stdio has none, and the field must then be omitted entirely.
//
// Every optional field is a pointer with omitempty, and that is load-bearing rather than
// tidy. The engine tests these fields with !== undefined, so an absent key and a null mean
// opposite things. A plain string field that marshals to "remoteAddress": null switches
// MW037 on - and because an adapter in that state is not reporting event ids either, every
// stream resumption is then refused as a foreign resumption id. Verified against the engine:
// with the key absent a benign tools/call carrying Last-Event-ID is forwarded; with the key
// present and null the same call is blocked by MW037.
type HTTPInfo struct {
	// Headers must already be lower-cased. The engine looks names up in a plain map with no
	// case folding, and Go's http.Header is canonical-cased ("Content-Type"), so passing one
	// straight through finds nothing. Use [HeadersFrom].
	Headers map[string]string `json:"headers"`

	// RemoteAddress is the peer the request came from. Sending it switches on MW031's
	// unauthenticated-caller clause and MW037's resumption clause, so set it only when the
	// adapter also reports event ids with [Verdicts.NoteEventID].
	RemoteAddress *string `json:"remoteAddress,omitempty"`

	// Encrypted says whether the listener itself terminated TLS. Exactly false triggers
	// MW034's second clause; nil means "not known", which is right behind a TLS-terminating
	// proxy where the listener sees plain HTTP but the client did not.
	Encrypted *bool `json:"encrypted,omitempty"`

	// InsecureUpstream is set by a proxy that reaches the upstream server over plain HTTP.
	InsecureUpstream *bool `json:"insecureUpstream,omitempty"`
}

// HeadersFrom lower-cases an http.Header into the form the engine expects.
func HeadersFrom(h map[string][]string) map[string]string {
	// Never nil: the engine indexes this map directly, and a JSON null makes its header
	// lookup throw rather than simply find nothing.
	out := make(map[string]string, len(h))
	for name, values := range h {
		lower := strings.ToLower(name)
		// RFC 6265 folds repeated Cookie headers with "; ", not with the "," every other
		// header uses. No rule reads cookies today, so this costs nothing now and stops the
		// first one that does from parsing a mangled value.
		sep := ", "
		if lower == "cookie" {
			sep = "; "
		}
		if existing, ok := out[lower]; ok {
			out[lower] = existing + sep + strings.Join(values, sep)
			continue
		}
		out[lower] = strings.Join(values, sep)
	}
	return out
}

// Get returns the first value of a header. The name must already be lower-case.
func (h *HTTPInfo) Get(name string) string {
	if h == nil {
		return ""
	}
	return h.Headers[name]
}

// Has reports whether a header is present, even with an empty value. The difference matters:
// an empty Mcp-Session-Id still makes a server message strict.
func (h *HTTPInfo) Has(name string) bool {
	if h == nil {
		return false
	}
	_, ok := h.Headers[name]
	return ok
}

// String pointers for the optional fields, so callers do not have to declare locals.
func String(s string) *string { return &s }

// Bool returns a pointer to b.
func Bool(b bool) *bool { return &b }

// EngineNpmSpec is what the npx fallback installs. It pins the engine's major line rather
// than resolving `latest`: a published Go module is immutable, so an unpinned spec would let
// a future engine with a different sidecar protocol be started by a release that can never
// be corrected.
const EngineNpmSpec = NPMPackage + "@^0.4.0"

// MinEngineVersion is the oldest engine this adapter is known to speak to. A mismatch is
// warned about, never fatal: refusing to start because a version string looked wrong would
// take a working guard offline over a cosmetic disagreement.
const MinEngineVersion = "0.4.0"
