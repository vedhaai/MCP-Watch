package nethttp

import (
	"context"
	"net/http"
	"strconv"

	mcpwatch "github.com/vedhaai/MCP-Watch/go"
	"github.com/vedhaai/MCP-Watch/go/httpguard"
)

// guardedWriter checks the response on its way back to the client.
//
// It deliberately does NOT implement io.ReaderFrom. http.ResponseWriter's own implementation
// is what io.Copy and sendfile reach for, and implementing it here would let a body travel
// straight to the socket without passing through the guard at all - the same class of bug as
// a setting that silently does nothing, but harder to notice.
type guardedWriter struct {
	rw    http.ResponseWriter
	guard *httpguard.Guard
	check *httpguard.RequestCheck
	ctx   context.Context
	logf  func(string, ...any)

	filter      *httpguard.ResponseFilter
	kind        httpguard.Kind
	status      int
	wroteHeader bool
	buf         []byte
	overflow    bool
	failed      bool
}

func (g *guardedWriter) Header() http.Header { return g.rw.Header() }

// Unwrap lets http.NewResponseController find the real writer, so Flush, SetWriteDeadline
// and the rest keep working through the wrapper. Without it, an SSE stream stops streaming -
// silently, which is exactly how this bug survives review.
func (g *guardedWriter) Unwrap() http.ResponseWriter { return g.rw }

func (g *guardedWriter) WriteHeader(status int) {
	if g.wroteHeader {
		return
	}
	g.wroteHeader = true
	g.status = status

	headers := &mcpwatch.HTTPInfo{Headers: mcpwatch.HeadersFrom(g.rw.Header())}
	g.filter = g.guard.Response(g.ctx, g.check, headers)
	g.kind = g.filter.Kind()

	switch g.kind {
	case httpguard.KindSSE:
		// The length is unknowable for a stream, and an event the guard removes would make
		// any declared length wrong anyway.
		g.rw.Header().Del("Content-Length")
		g.rw.WriteHeader(status)
	case httpguard.KindJSON:
		// Headers are held back until the filtered length is known.
	default:
		g.rw.WriteHeader(status)
	}
}

func (g *guardedWriter) Write(p []byte) (int, error) {
	if !g.wroteHeader {
		g.WriteHeader(http.StatusOK)
	}
	switch g.kind {
	case httpguard.KindJSON:
		if g.overflow {
			return len(p), nil
		}
		if len(g.buf)+len(p) > g.guard.MaxBodyBytes() {
			g.overflow = true
			g.buf = nil
			return len(p), nil
		}
		g.buf = append(g.buf, p...)
		return len(p), nil
	case httpguard.KindSSE:
		out, err := g.filter.Feed(g.ctx, p)
		if err != nil {
			g.logf("[mcpwatch] %v", err)
			g.failed = true
			return len(p), nil
		}
		if len(out) == 0 {
			// Never write a zero-length chunk: on the wire that is the terminal chunk, and
			// writing one here ends the stream mid-conversation.
			return len(p), nil
		}
		if _, err := g.rw.Write(out); err != nil {
			return 0, err
		}
		http.NewResponseController(g.rw).Flush()
		return len(p), nil
	default:
		return g.rw.Write(p)
	}
}

// Flush is kept so that a handler type-asserting http.Flusher still finds one.
func (g *guardedWriter) Flush() {
	if !g.wroteHeader {
		g.WriteHeader(http.StatusOK)
	}
	if g.kind == httpguard.KindJSON {
		return // a buffered body cannot be flushed early without losing the check
	}
	http.NewResponseController(g.rw).Flush()
}

// finish writes whatever the chosen kind was holding back.
func (g *guardedWriter) finish() {
	if !g.wroteHeader {
		g.WriteHeader(http.StatusOK)
	}
	switch g.kind {
	case httpguard.KindJSON:
		if g.overflow {
			g.rw.Header().Del("Content-Length")
			g.rw.WriteHeader(http.StatusBadGateway)
			_, _ = g.rw.Write([]byte("MCPWatch could not check an oversized response"))
			return
		}
		out := g.filter.JSON(g.ctx, g.buf)
		g.rw.Header().Set("Content-Length", strconv.Itoa(len(out)))
		g.rw.WriteHeader(g.status)
		_, _ = g.rw.Write(out)
	case httpguard.KindSSE:
		if g.failed {
			return
		}
		if out := g.filter.End(g.ctx); len(out) > 0 {
			_, _ = g.rw.Write(out)
			http.NewResponseController(g.rw).Flush()
		}
	}
}
