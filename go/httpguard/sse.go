package httpguard

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"strings"

	mcpwatch "github.com/vedhaai/MCP-Watch/go"
)

// ErrSSEOverflow means one event grew past the body cap. It is refused rather than truncated:
// half an event is not an event, and buffering without a limit is how a guard becomes the
// resource exhaustion it exists to prevent.
var ErrSSEOverflow = errors.New("mcpwatch: SSE event too large to check")

// ResponseFilter checks a response body on its way back to the client.
type ResponseFilter struct {
	g     *Guard
	check *RequestCheck
	kind  Kind
	buf   []byte
}

// Kind is how this response body must be treated.
func (f *ResponseFilter) Kind() Kind { return f.kind }

// JSON checks a whole non-streaming response body.
func (f *ResponseFilter) JSON(ctx context.Context, body []byte) []byte {
	messages, batch, ok := splitBody(body)
	if !ok {
		return body // not JSON-RPC; not ours to rewrite
	}
	forwards := make([]json.RawMessage, len(messages))
	changed := false
	for i, msg := range messages {
		if !isObject(msg) {
			forwards[i] = msg
			continue
		}
		out := f.g.v.FromServer(ctx, f.check.session, msg, f.check.strict)
		forwards[i] = out.Forward
		if out.Modified || out.Dropped() {
			changed = true
		}
		if len(out.Reply) > 0 {
			// An HTTP response travels one way, so a refusal owed to the server has nowhere
			// to go. Dropping and recording it is all that is available here.
			f.g.logRefusedServerRequest()
		}
	}
	if !changed {
		return body
	}
	return rejoin(forwards, batch)
}

// Feed takes the next chunk of an event stream and returns the complete events it finished,
// already checked.
//
// A zero-length return means nothing is ready yet. The caller must not write it: on the wire
// a zero-length chunk is the terminal chunk, so writing one ends the stream.
func (f *ResponseFilter) Feed(ctx context.Context, chunk []byte) ([]byte, error) {
	f.buf = append(f.buf, chunk...)
	if len(f.buf) > f.g.max {
		f.buf = nil
		return nil, ErrSSEOverflow
	}
	var out []byte
	for {
		end := endOfEvent(f.buf)
		if end < 0 {
			break
		}
		event := f.buf[:end]
		f.buf = f.buf[end:]
		out = append(out, f.check_(ctx, event)...)
	}
	return out, nil
}

// End flushes a final event that arrived without a trailing blank line.
func (f *ResponseFilter) End(ctx context.Context) []byte {
	if len(bytes.TrimSpace(f.buf)) == 0 {
		f.buf = nil
		return nil
	}
	event := f.buf
	f.buf = nil
	return f.check_(ctx, event)
}

// check_ judges one complete SSE event and returns what should go out in its place.
func (f *ResponseFilter) check_(ctx context.Context, event []byte) []byte {
	text := string(event)
	lines := splitLines(text)

	var kept []string
	var data []string
	for _, line := range lines {
		switch {
		case strings.HasPrefix(line, "data:"):
			data = append(data, strings.TrimPrefix(strings.TrimPrefix(line, "data:"), " "))
		case strings.HasPrefix(line, "id:"):
			// Recorded before any decision is taken. An id the server issued was issued even
			// if the event it came on is then dropped, and MW037 matches a resumption against
			// exactly this set.
			id := strings.TrimPrefix(strings.TrimPrefix(line, "id:"), " ")
			f.g.v.NoteEventID(f.check.session, id)
			kept = append(kept, line)
		default:
			kept = append(kept, line) // comments, keep-alives, event:, retry:
		}
	}

	if len(data) == 0 {
		return event // a comment or a keep-alive: nothing to judge
	}
	payload := json.RawMessage(strings.Join(data, "\n"))
	if !isObject(payload) {
		return event
	}

	out := f.g.v.FromServer(ctx, f.check.session, payload, f.check.strict)
	if len(out.Reply) > 0 {
		f.g.logRefusedServerRequest()
	}
	if out.Dropped() {
		// The whole event vanishes, id line and all. The stream itself carries on.
		return nil
	}
	body := payload
	if out.Modified {
		body = out.Forward
	}
	var b strings.Builder
	for _, line := range kept {
		b.WriteString(line)
		b.WriteString("\n")
	}
	b.WriteString("data: ")
	b.Write(body)
	b.WriteString("\n\n")
	return []byte(b.String())
}

func (g *Guard) logRefusedServerRequest() {
	// Nothing to do but let it go: there is no channel back to the server on an HTTP
	// response. Documented in the middleware's limits.
}

// splitLines splits an SSE event into lines on any terminator form.
func splitLines(s string) []string {
	var lines []string
	start := 0
	for i := 0; i < len(s); {
		if n := termLen(s, i); n > 0 {
			lines = append(lines, s[start:i])
			i += n
			start = i
			continue
		}
		i++
	}
	if start < len(s) {
		lines = append(lines, s[start:])
	}
	// Trailing empties come from the event's own terminator.
	for len(lines) > 0 && lines[len(lines)-1] == "" {
		lines = lines[:len(lines)-1]
	}
	return lines
}

func termLen(s string, i int) int {
	if i >= len(s) {
		return 0
	}
	if s[i] == '\r' {
		if i+1 < len(s) && s[i+1] == '\n' {
			return 2
		}
		return 1
	}
	if s[i] == '\n' {
		return 1
	}
	return 0
}

// endOfEvent finds where the first complete event ends, or -1 if none has.
//
// An event ends wherever any two line terminators run together. All six combinations occur in
// the wild - "\n\n", "\r\n\r\n", "\r\r", "\r\n\n", "\n\r\n" and "\r\r\n" - and matching only
// the common three means the guard never sees some events end, so it holds them for ever.
//
// A boundary is only reported when both terminators are fully present, and the *first* of
// them is never allowed to end the buffer: a trailing lone "\r" there may be the first half
// of "\r\n", so the scan waits and re-reads the joined buffer next time.
//
// The *second* terminator gets no such reservation, and that asymmetry is deliberate. A
// buffer ending "...\r\r" is ambiguous - it is either a complete "\r\r" boundary or a "\r"
// followed by the start of "\r\n" - and it has to be resolved without the next chunk, which
// may never come. Reporting the boundary can split an event one byte early, leaving a "\n"
// to open the next one, which a client parses as a harmless blank line. Waiting instead
// would mean a "\r\r" stream whose sender pauses is never recognised at all and the event is
// held for ever, which is the failure this whole function exists to prevent. Early wins.
func endOfEvent(b []byte) int {
	s := string(b)
	for i := 0; i < len(s); {
		n := termLen(s, i)
		if n == 0 {
			i++
			continue
		}
		if i+n >= len(s) {
			return -1 // might be the first half of a boundary; wait for more
		}
		if m := termLen(s, i+n); m > 0 {
			return i + n + m
		}
		i += n
	}
	return -1
}

var _ = mcpwatch.CodeBlocked
