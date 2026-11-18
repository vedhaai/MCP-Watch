package mcpwatch

import (
	"context"
	"encoding/json"
)

// Verdicts is the seam every adapter in this module is written against.
//
// [Engine] implements it by talking to the Node engine; a stub implements it in tests. That
// is what lets the HTTP guard, the SSE scanner and both SDK adapters be tested with no Node
// process anywhere, which is most of the code and nearly all of the fiddly parts.
//
// Nothing here returns an error. A guard that fails outwards, into the middle of somebody's
// request handler, is a guard they will take back out again; an engine that cannot be reached
// is resolved into an [Outcome] by FailOpen instead.
type Verdicts interface {
	// FromClient checks a message travelling from the client to the server. info is nil for
	// anything that did not arrive over HTTP, and must be nil rather than empty for stdio.
	FromClient(ctx context.Context, session string, msg json.RawMessage, info *HTTPInfo) Outcome

	// FromServer checks a message travelling from the server back to the client.
	//
	// strict says the message arrived over the network on an established session, so a
	// response to a request the client never sent is forged or replayed (MW037). It follows
	// the *presence* of the session header, not its value: an empty Mcp-Session-Id is still
	// strict. The asymmetry is deliberate and shared by every adapter.
	FromServer(ctx context.Context, session string, msg json.RawMessage, strict bool) Outcome

	// FromHTTP checks the HTTP request itself - origin, host, authentication - for a request
	// that carries no JSON-RPC message of its own, such as the GET that opens an event
	// stream. It reports whether to refuse.
	FromHTTP(ctx context.Context, session string, info *HTTPInfo, method string) bool

	// Bookkeeping nobody waits on. Deliberately synchronous and infallible: these are called
	// from the SSE hot path and from deferred cleanup, where blocking or returning an error
	// is not available.
	RenameSession(from, to string)
	DropSession(session string)
	NoteEventID(session, eventID string)
}

// passthrough is the Verdicts used when MCPWatch is switched off. Having one means no adapter
// needs a nil check, and the disabled path exercises the same code as the enabled one.
type passthrough struct{}

func (passthrough) FromClient(_ context.Context, _ string, msg json.RawMessage, _ *HTTPInfo) Outcome {
	return Pass(msg)
}
func (passthrough) FromServer(_ context.Context, _ string, msg json.RawMessage, _ bool) Outcome {
	return Pass(msg)
}
func (passthrough) FromHTTP(context.Context, string, *HTTPInfo, string) bool { return false }
func (passthrough) RenameSession(string, string)                             {}
func (passthrough) DropSession(string)                                       {}
func (passthrough) NoteEventID(string, string)                               {}

// Passthrough returns a Verdicts that allows everything. It is what a disabled guard uses.
func Passthrough() Verdicts { return passthrough{} }
