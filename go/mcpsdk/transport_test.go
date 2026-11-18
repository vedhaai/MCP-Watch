package mcpsdk_test

import (
	"bufio"
	"context"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"
	mcpwatch "github.com/vedhaai/MCP-Watch/go"
	"github.com/vedhaai/MCP-Watch/go/mcpsdk"
)

// engineCLI finds this checkout's engine. Never npx: no test reaches the network or reports
// into anybody's real dashboard.
func engineCLI(t *testing.T) string {
	t.Helper()
	wd, err := os.Getwd() // .../go/mcpsdk
	if err != nil {
		t.Fatal(err)
	}
	cli := filepath.Clean(filepath.Join(wd, "..", "..", "engine", "dist", "cli.js"))
	if _, err := os.Stat(cli); err != nil {
		t.Skipf("engine not built at %s; run `npm run build -w engine` (skipping)", cli)
	}
	if testing.Short() {
		t.Skip("-short")
	}
	return cli
}

type readArgs struct {
	Path string `json:"path"`
}

// guardedServer runs a real SDK server behind the guard and hands back the client's end.
func guardedServer(t *testing.T, mode mcpwatch.Mode) (io.Writer, *bufio.Reader, *tally) {
	t.Helper()
	cli := engineCLI(t)
	for _, k := range []string{"MCPWATCH_PROJECT_KEY", "MCPWATCH_AI", "MCPWATCH_MODE", "MCPWATCH_ENABLED", "MCPWATCH_ENGINE"} {
		t.Setenv(k, "")
		os.Unsetenv(k)
	}
	dir := t.TempDir()
	ctx := context.Background()

	watch, err := mcpwatch.TryStart(ctx, "go-sdk-test", mcpwatch.Options{
		Mode:          mode,
		EngineCommand: []string{"node", cli},
		EventsFile:    filepath.Join(dir, "events.jsonl"),
		PinsFile:      filepath.Join(dir, "pins.json"),
		RegistryFile:  filepath.Join(dir, "registry.json"),
		StartTimeout:  60 * time.Second,
		Logger:        func(string, ...any) {},
	})
	if err != nil {
		t.Fatalf("the guard did not start: %v", err)
	}
	t.Cleanup(func() { _ = watch.Close() })

	// The client writes into clientW and reads from serverR.
	clientR, clientW := io.Pipe() // client -> guard
	serverR, serverW := io.Pipe() // guard -> client

	transport, done := mcpsdk.GuardIO(ctx, watch, clientR, serverW)
	t.Cleanup(func() { _ = done() })

	counts := &tally{}
	server := mcp.NewServer(&mcp.Implementation{Name: "go-sdk-test", Version: "0.1.0"}, nil)
	mcp.AddTool(server, &mcp.Tool{Name: "read_file", Description: "Read a file"},
		func(ctx context.Context, req *mcp.CallToolRequest, args readArgs) (*mcp.CallToolResult, any, error) {
			counts.add("read_file")
			return &mcp.CallToolResult{Content: []mcp.Content{&mcp.TextContent{Text: "contents of " + args.Path}}}, nil, nil
		})
	mcp.AddTool(server, &mcp.Tool{Name: "calculator", Description: "Add numbers"},
		func(ctx context.Context, req *mcp.CallToolRequest, args readArgs) (*mcp.CallToolResult, any, error) {
			counts.add("calculator")
			return &mcp.CallToolResult{Content: []mcp.Content{&mcp.TextContent{Text: "4"}}}, nil, nil
		})

	go func() {
		session, err := server.Connect(ctx, transport, nil)
		if err != nil {
			return
		}
		_ = session.Wait()
	}()
	t.Cleanup(func() { _ = clientW.Close() })

	return clientW, bufio.NewReader(serverR), counts
}

type tally struct {
	mu    sync.Mutex
	calls []string
}

func (c *tally) add(name string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.calls = append(c.calls, name)
}
func (c *tally) count(name string) int {
	c.mu.Lock()
	defer c.mu.Unlock()
	n := 0
	for _, call := range c.calls {
		if call == name {
			n++
		}
	}
	return n
}

func send(t *testing.T, w io.Writer, msg string) {
	t.Helper()
	if _, err := io.WriteString(w, msg+"\n"); err != nil {
		t.Fatal(err)
	}
}

// until reads lines until one carries the given id, so the initialize handshake and any
// notifications in between do not have to be predicted.
func until(t *testing.T, r *bufio.Reader, id float64) map[string]any {
	t.Helper()
	deadline := time.After(25 * time.Second)
	type line struct {
		s   string
		err error
	}
	ch := make(chan line, 1)
	read := func() { s, err := r.ReadString('\n'); ch <- line{s, err} }
	for {
		go read()
		select {
		case l := <-ch:
			if l.err != nil {
				t.Fatalf("read: %v", l.err)
			}
			var m map[string]any
			if json.Unmarshal([]byte(l.s), &m) != nil {
				continue
			}
			if got, ok := m["id"].(float64); ok && got == id {
				return m
			}
		case <-deadline:
			t.Fatal("timed out waiting for a reply")
		}
	}
}

func handshake(t *testing.T, w io.Writer, r *bufio.Reader) {
	t.Helper()
	send(t, w, `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"test","version":"1.0"}}}`)
	until(t, r, 1)
	send(t, w, `{"jsonrpc":"2.0","method":"notifications/initialized"}`)
}

func TestSDKBlockedCallNeverReachesTheTool(t *testing.T) {
	w, r, counts := guardedServer(t, mcpwatch.ModeEnforce)
	handshake(t, w, r)

	send(t, w, `{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"read_file","arguments":{"path":"../../../../etc/passwd"}}}`)
	got := until(t, r, 2)

	errObj, ok := got["error"].(map[string]any)
	if !ok {
		t.Fatalf("want a JSON-RPC error, got %v", got)
	}
	if errObj["code"].(float64) != -32001 {
		t.Errorf("code = %v, want -32001", errObj["code"])
	}
	if !strings.Contains(errObj["message"].(string), "MW002") {
		t.Errorf("message = %v", errObj["message"])
	}
	if counts.count("read_file") != 0 {
		t.Error("the tool ran despite being blocked")
	}
}

func TestSDKOrdinaryCallReachesTheTool(t *testing.T) {
	w, r, counts := guardedServer(t, mcpwatch.ModeEnforce)
	handshake(t, w, r)

	send(t, w, `{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"calculator","arguments":{"path":"2+2"}}}`)
	got := until(t, r, 2)

	if _, bad := got["error"]; bad {
		t.Fatalf("a benign call must not be refused: %v", got)
	}
	if counts.count("calculator") != 1 {
		t.Errorf("the tool ran %d times, want 1", counts.count("calculator"))
	}
}

func TestSDKToolsListIsCheckedOnTheWayOut(t *testing.T) {
	w, r, _ := guardedServer(t, mcpwatch.ModeEnforce)
	handshake(t, w, r)

	send(t, w, `{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}`)
	got := until(t, r, 2)

	res, ok := got["result"].(map[string]any)
	if !ok {
		t.Fatalf("want a result, got %v", got)
	}
	tools, _ := res["tools"].([]any)
	if len(tools) != 2 {
		t.Errorf("both benign tools should survive the listing, got %d", len(tools))
	}
}
