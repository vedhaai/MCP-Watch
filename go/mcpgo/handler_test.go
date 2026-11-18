package mcpgo_test

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/mark3labs/mcp-go/mcp"
	"github.com/mark3labs/mcp-go/server"
	mcpwatch "github.com/vedhaai/MCP-Watch/go"
	"github.com/vedhaai/MCP-Watch/go/mcpgo"
)

func guarded(t *testing.T) (*httptest.Server, func() int) {
	t.Helper()
	wd, _ := os.Getwd()
	cli := filepath.Clean(filepath.Join(wd, "..", "..", "engine", "dist", "cli.js"))
	if _, err := os.Stat(cli); err != nil {
		t.Skipf("engine not built at %s; run `npm run build -w engine` (skipping)", cli)
	}
	if testing.Short() {
		t.Skip("-short")
	}
	for _, k := range []string{"MCPWATCH_PROJECT_KEY", "MCPWATCH_AI", "MCPWATCH_MODE", "MCPWATCH_ENABLED", "MCPWATCH_ENGINE"} {
		t.Setenv(k, "")
		os.Unsetenv(k)
	}
	dir := t.TempDir()

	watch, err := mcpwatch.TryStart(context.Background(), "go-mcpgo-test", mcpwatch.Options{
		Mode:          mcpwatch.ModeEnforce,
		EngineCommand: []string{"node", cli},
		EventsFile:    filepath.Join(dir, "events.jsonl"),
		PinsFile:      filepath.Join(dir, "pins.json"),
		StartTimeout:  60 * time.Second,
		Logger:        func(string, ...any) {},
	})
	if err != nil {
		t.Fatalf("the guard did not start: %v", err)
	}
	t.Cleanup(func() { _ = watch.Close() })

	ran := 0
	s := server.NewMCPServer("go-mcpgo-test", "0.1.0", server.WithToolCapabilities(true))
	s.AddTool(
		mcp.NewTool("read_file", mcp.WithDescription("Read a file"), mcp.WithString("path")),
		func(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
			ran++
			return mcp.NewToolResultText("contents"), nil
		})

	httpSrv := server.NewStreamableHTTPServer(s)
	srv := httptest.NewServer(mcpgo.Handler(watch, httpSrv))
	t.Cleanup(srv.Close)
	return srv, func() int { return ran }
}

func post(t *testing.T, srv *httptest.Server, body string) map[string]any {
	t.Helper()
	req, _ := http.NewRequest(http.MethodPost, srv.URL, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json, text/event-stream")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	// A streamable server may answer as a single SSE event.
	text := string(raw)
	if i := strings.Index(text, "data: "); i >= 0 {
		text = text[i+len("data: "):]
		if j := strings.IndexAny(text, "\r\n"); j >= 0 {
			text = text[:j]
		}
	}
	var m map[string]any
	if err := json.Unmarshal([]byte(strings.TrimSpace(text)), &m); err != nil {
		t.Fatalf("not JSON-RPC: %q", raw)
	}
	return m
}

func TestMCPGoBlockedCallNeverReachesTheTool(t *testing.T) {
	srv, ran := guarded(t)

	got := post(t, srv, `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"read_file","arguments":{"path":"../../../../etc/passwd"}}}`)

	errObj, ok := got["error"].(map[string]any)
	if !ok {
		t.Fatalf("want a JSON-RPC error, got %v", got)
	}
	if errObj["code"].(float64) != -32001 {
		t.Errorf("code = %v, want -32001", errObj["code"])
	}
	if ran() != 0 {
		t.Error("the tool ran despite being blocked")
	}
}

func TestMCPGoForeignOriginIsRefused(t *testing.T) {
	srv, _ := guarded(t)
	req, _ := http.NewRequest(http.MethodGet, srv.URL, nil)
	req.Header.Set("Origin", "http://evil.example")
	req.Header.Set("Accept", "text/event-stream")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusForbidden {
		t.Errorf("status = %d, want 403: a cross-origin GET is MW030", resp.StatusCode)
	}
}
