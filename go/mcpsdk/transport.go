package mcpsdk

import (
	"context"
	"fmt"
	"io"
	"os"
	"sync/atomic"

	"github.com/modelcontextprotocol/go-sdk/mcp"
	mcpwatch "github.com/vedhaai/MCP-Watch/go"
)

var conns atomic.Uint64

// GuardStdio guards a server that speaks MCP over stdin and stdout.
//
// The returned transport is handed to the SDK in place of mcp.StdioTransport. The second
// result must be called when the server is done: it stops the guard and tells the engine the
// session is over.
func GuardStdio(ctx context.Context, w *mcpwatch.Watch) (*mcp.IOTransport, func() error) {
	return GuardIO(ctx, w, os.Stdin, os.Stdout)
}

// GuardIO guards a server speaking MCP over any pair of streams.
//
// in and out are the real peer. The SDK is given the returned transport instead, so every
// message is checked on its way past in both directions.
func GuardIO(ctx context.Context, w *mcpwatch.Watch, in io.Reader, out io.Writer) (*mcp.IOTransport, func() error) {
	session := fmt.Sprintf("conn-%08x", conns.Add(1)^uint64(os.Getpid())<<16)
	stream := mcpwatch.GuardIO(ctx, w.Verdicts(), session, in, out, 0)
	return &mcp.IOTransport{
		Reader: stream.Reader(),
		Writer: stream.Writer(),
	}, func() error {
		return stream.Close()
	}
}
