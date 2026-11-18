package mcpwatch_test

import (
	"context"
	"encoding/json"
	"fmt"
	"path/filepath"
	"slices"
	"sync"
	"testing"
	"time"

	mcpwatch "github.com/vedhaai/MCP-Watch/go"
	"github.com/vedhaai/MCP-Watch/go/internal/testutil"
)

// start brings up a guard backed by this checkout's engine, isolated in a temp directory and
// with no project key, so nothing is reported anywhere and the local event log is this
// test's own.
func start(t *testing.T, mode mcpwatch.Mode, tweak func(*mcpwatch.Options)) *mcpwatch.Engine {
	t.Helper()
	cli := testutil.RequireEngine(t)
	testutil.ScrubEnv(t)

	dir := t.TempDir()
	opts := mcpwatch.Options{
		Mode:          mode,
		EngineCommand: []string{"node", cli},
		EventsFile:    filepath.Join(dir, "events.jsonl"),
		PinsFile:      filepath.Join(dir, "pins.json"),
		RegistryFile:  filepath.Join(dir, "registry.json"),
		StartTimeout:  60 * time.Second,
		CallTimeout:   30 * time.Second,
		Logger:        func(string, ...any) {},
	}
	if tweak != nil {
		tweak(&opts)
	}
	e, err := mcpwatch.NewEngine("go-test", opts)
	if err != nil {
		t.Fatalf("NewEngine: %v", err)
	}
	if err := e.Start(context.Background()); err != nil {
		t.Fatalf("Start: %v", err)
	}
	t.Cleanup(func() { _ = e.Close() })
	return e
}

func toolCall(id int, name string, args map[string]any) json.RawMessage {
	b, err := json.Marshal(map[string]any{
		"jsonrpc": "2.0", "id": id, "method": "tools/call",
		"params": map[string]any{"name": name, "arguments": args},
	})
	if err != nil {
		panic(err)
	}
	return b
}

func TestPathTraversalIsBlocked(t *testing.T) {
	e := start(t, mcpwatch.ModeEnforce, nil)
	msg := toolCall(1, "read_file", map[string]any{"path": "../../../../etc/passwd"})

	out := e.FromClient(context.Background(), "s1", msg, nil)

	if !out.Blocked() {
		t.Fatalf("a path traversal must be blocked, got forward=%s reply=%s", out.Forward, out.Reply)
	}
	if !slices.Contains(out.Rules(), "MW002") {
		t.Errorf("want MW002 among the rules, got %v", out.Rules())
	}
	// The refusal must answer the call's own id, or the client waits for ever.
	var reply struct {
		ID    json.Number `json:"id"`
		Error struct {
			Code int `json:"code"`
		} `json:"error"`
	}
	if err := json.Unmarshal(out.Reply, &reply); err != nil {
		t.Fatalf("reply is not JSON-RPC: %v", err)
	}
	if reply.ID.String() != "1" {
		t.Errorf("reply id = %s, want 1", reply.ID)
	}
	if reply.Error.Code != mcpwatch.CodeBlocked {
		t.Errorf("code = %d, want %d", reply.Error.Code, mcpwatch.CodeBlocked)
	}
}

func TestCommandInjectionIsBlocked(t *testing.T) {
	e := start(t, mcpwatch.ModeEnforce, nil)
	msg := toolCall(1, "run_command", map[string]any{"cmd": "ls; cat /etc/shadow"})
	out := e.FromClient(context.Background(), "s1", msg, nil)
	if !out.Blocked() {
		t.Fatal("command injection must be blocked")
	}
	if !slices.Contains(out.Rules(), "MW001") {
		t.Errorf("want MW001, got %v", out.Rules())
	}
}

func TestOrdinaryCallPassesThroughUntouched(t *testing.T) {
	e := start(t, mcpwatch.ModeEnforce, nil)
	msg := toolCall(1, "calculator", map[string]any{"expr": "2+2"})
	out := e.FromClient(context.Background(), "s1", msg, nil)

	if out.Blocked() || out.Dropped() {
		t.Fatalf("a benign call must pass: %s", out.Reply)
	}
	if out.Modified {
		t.Error("a benign call must not be marked modified")
	}
	// Forward must be the caller's own slice, not the engine's echo.
	if &out.Forward[0] != &msg[0] {
		t.Error("an unchanged message must be forwarded as the original bytes")
	}
}

func TestObserveModeNeverRefuses(t *testing.T) {
	e := start(t, mcpwatch.ModeObserve, nil)
	msg := toolCall(1, "read_file", map[string]any{"path": "../../../../etc/passwd"})
	out := e.FromClient(context.Background(), "s1", msg, nil)
	if out.Blocked() || out.Dropped() {
		t.Fatal("observe mode must never refuse")
	}
}

func TestDeniedToolIsRefused(t *testing.T) {
	e := start(t, mcpwatch.ModeEnforce, func(o *mcpwatch.Options) {
		o.DenyTools = []string{"run_command"}
	})
	out := e.FromClient(context.Background(), "s1", toolCall(1, "run_command", map[string]any{"cmd": "ls"}), nil)
	if !out.Blocked() {
		t.Fatal("a denied tool must be refused")
	}
	if !slices.Contains(out.Rules(), "MW009") {
		t.Errorf("want MW009, got %v", out.Rules())
	}
}

func TestForeignOriginIsRefusedOnAGet(t *testing.T) {
	e := start(t, mcpwatch.ModeEnforce, func(o *mcpwatch.Options) {
		o.AllowedOrigins = []string{"https://app.example.com"}
	})
	ctx := context.Background()

	evil := &mcpwatch.HTTPInfo{Headers: mcpwatch.HeadersFrom(map[string][]string{"Origin": {"https://evil.example"}})}
	if !e.FromHTTP(ctx, "s1", evil, "GET") {
		t.Error("a foreign origin must be refused")
	}
	good := &mcpwatch.HTTPInfo{Headers: mcpwatch.HeadersFrom(map[string][]string{"Origin": {"https://app.example.com"}})}
	if e.FromHTTP(ctx, "s2", good, "GET") {
		t.Error("an allowed origin must not be refused")
	}
}

// The engine answers each message as soon as it is checked, so answers arrive out of order.
// This is the test that catches an adapter which assumes FIFO - which appears to work until a
// check is slow.
func TestAnswersAreMatchedByIDNotByOrder(t *testing.T) {
	e := start(t, mcpwatch.ModeObserve, nil)

	const n = 40
	var wg sync.WaitGroup
	errs := make([]error, n)
	for i := range n {
		wg.Add(1)
		go func() {
			defer wg.Done()
			msg := toolCall(i+1, "calculator", map[string]any{"expr": fmt.Sprintf("%d+%d", i, i)})
			out := e.FromClient(context.Background(), fmt.Sprintf("session-%d", i), msg, nil)
			if out.Dropped() {
				errs[i] = fmt.Errorf("call %d was dropped", i)
				return
			}
			var got struct {
				ID     json.Number `json:"id"`
				Params struct {
					Arguments struct {
						Expr string `json:"expr"`
					} `json:"arguments"`
				} `json:"params"`
			}
			if err := json.Unmarshal(out.Forward, &got); err != nil {
				errs[i] = err
				return
			}
			if want := fmt.Sprintf("%d", i+1); got.ID.String() != want {
				errs[i] = fmt.Errorf("call %d got answer for id %s", i, got.ID)
			}
			if want := fmt.Sprintf("%d+%d", i, i); got.Params.Arguments.Expr != want {
				errs[i] = fmt.Errorf("call %d got arguments %q", i, got.Params.Arguments.Expr)
			}
		}()
	}
	wg.Wait()
	for _, err := range errs {
		if err != nil {
			t.Error(err)
		}
	}
}

// A JSON-RPC id above 2^53 does not survive the engine: Node parses every number as a
// float64. The adapter must forward its own bytes so the id answers the right call.
func TestLargeIDSurvivesForwarding(t *testing.T) {
	e := start(t, mcpwatch.ModeObserve, nil)
	const big = "9007199254740993"
	msg := json.RawMessage(`{"jsonrpc":"2.0","id":` + big + `,"method":"tools/call","params":{"name":"calculator","arguments":{"expr":"1+1"}}}`)

	out := e.FromClient(context.Background(), "s1", msg, nil)

	if out.Dropped() {
		t.Fatal("a benign call must pass")
	}
	var got struct {
		ID json.Number `json:"id"`
	}
	if err := json.Unmarshal(out.Forward, &got); err != nil {
		t.Fatal(err)
	}
	if got.ID.String() != big {
		t.Errorf("id = %s, want %s: the engine's echo was forwarded instead of the original bytes", got.ID, big)
	}
}

func TestModeCanChangeAtRuntime(t *testing.T) {
	e := start(t, mcpwatch.ModeEnforce, nil)
	ctx := context.Background()
	attack := func() mcpwatch.Outcome {
		return e.FromClient(ctx, "s1", toolCall(1, "read_file", map[string]any{"path": "../../../../etc/passwd"}), nil)
	}
	if !attack().Blocked() {
		t.Fatal("enforce must block")
	}
	if err := e.SetMode(ctx, mcpwatch.ModeOff); err != nil {
		t.Fatal(err)
	}
	if e.Mode() != mcpwatch.ModeOff {
		t.Errorf("mode = %s, want off", e.Mode())
	}
	if attack().Blocked() {
		t.Error("off must not block")
	}
}

// The engine sends "reply":null on every message it allows. json.RawMessage stores that as
// the four-byte literal rather than nil, so a naive len(Reply) > 0 test is true for every
// message and the guard writes the word "null" back to the client. This is that regression.
func TestAnAllowedMessageCarriesNoReply(t *testing.T) {
	e := start(t, mcpwatch.ModeEnforce, nil)
	out := e.FromClient(context.Background(), "s1", toolCall(1, "calculator", map[string]any{"expr": "2+2"}), nil)

	if len(out.Reply) != 0 {
		t.Errorf("an allowed message must carry no reply, got %q", out.Reply)
	}
	if out.Blocked() {
		t.Error("an allowed message must not look blocked")
	}

	srv := json.RawMessage(`{"jsonrpc":"2.0","id":1,"result":{"ok":true}}`)
	if got := e.FromServer(context.Background(), "s1", srv, false); len(got.Reply) != 0 {
		t.Errorf("an allowed server message must carry no reply, got %q", got.Reply)
	}
}
