package mcpgo

import (
	"context"
	"fmt"
	"net/http"
	"os"
	"sync/atomic"

	"github.com/mark3labs/mcp-go/server"
	mcpwatch "github.com/vedhaai/MCP-Watch/go"
	"github.com/vedhaai/MCP-Watch/go/nethttp"
)

var conns atomic.Uint64

// ServeStdio runs an mcp-go server over stdio with every message checked, in place of
// server.ServeStdio.
func ServeStdio(ctx context.Context, w *mcpwatch.Watch, s *server.MCPServer, opts ...server.StdioOption) error {
	session := fmt.Sprintf("conn-%08x", conns.Add(1)^uint64(os.Getpid())<<16)
	// The guard owns the real stdio; mcp-go is handed the checked streams instead.
	stream := mcpwatch.GuardIO(ctx, w.Verdicts(), session, os.Stdin, os.Stdout, 0)
	defer stream.Close()

	stdio := server.NewStdioServer(s)
	for _, opt := range opts {
		opt(stdio)
	}
	return stdio.Listen(ctx, stream.Reader(), stream.Writer())
}

// Handler guards an mcp-go HTTP server - StreamableHTTPServer or SSEServer, both of which
// are http.Handlers.
//
// This is the better way in for an HTTP server: it is the only one that also sees GET and
// DELETE, the request headers and the SSE body, which is where the whole MW030-MW037
// transport family lives.
func Handler(w *mcpwatch.Watch, h http.Handler, opts ...nethttp.Option) http.Handler {
	return nethttp.Middleware(w.Verdicts(), opts...)(h)
}
