package nethttp_test

import (
	"context"
	"encoding/json"

	mcpwatch "github.com/vedhaai/MCP-Watch/go"
)

// hostSpy records the host header the guard passed to the engine.
type hostSpy struct {
	seen chan string
}

func (h *hostSpy) FromClient(_ context.Context, _ string, msg json.RawMessage, info *mcpwatch.HTTPInfo) mcpwatch.Outcome {
	select {
	case h.seen <- info.Get("host"):
	default:
	}
	return mcpwatch.Pass(msg)
}
func (h *hostSpy) FromServer(_ context.Context, _ string, msg json.RawMessage, _ bool) mcpwatch.Outcome {
	return mcpwatch.Pass(msg)
}
func (h *hostSpy) FromHTTP(context.Context, string, *mcpwatch.HTTPInfo, string) bool { return false }
func (h *hostSpy) RenameSession(string, string)                                      {}
func (h *hostSpy) DropSession(string)                                                {}
func (h *hostSpy) NoteEventID(string, string)                                        {}
