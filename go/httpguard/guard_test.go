package httpguard_test

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	mcpwatch "github.com/vedhaai/MCP-Watch/go"
	"github.com/vedhaai/MCP-Watch/go/httpguard"
	"github.com/vedhaai/MCP-Watch/go/internal/testutil"
)

func info(pairs ...string) *mcpwatch.HTTPInfo {
	h := map[string][]string{"Content-Type": {"application/json"}}
	for i := 0; i+1 < len(pairs); i += 2 {
		h[pairs[i]] = []string{pairs[i+1]}
	}
	return &mcpwatch.HTTPInfo{
		Headers:       mcpwatch.HeadersFrom(h),
		RemoteAddress: mcpwatch.String("127.0.0.1"),
	}
}

func call(id int, tool string) string {
	b, _ := json.Marshal(map[string]any{
		"jsonrpc": "2.0", "id": id, "method": "tools/call",
		"params": map[string]any{"name": tool, "arguments": map[string]any{}},
	})
	return string(b)
}

func TestPathMatching(t *testing.T) {
	g := httpguard.New(&testutil.Stub{}, httpguard.Config{Paths: []string{"/mcp"}})
	tests := map[string]bool{
		"/mcp": true, "/mcp/": true, "/mcp/messages": true,
		"/mcpx": false, "/health": false, "/": false,
	}
	for path, want := range tests {
		if got := g.Matches(path); got != want {
			t.Errorf("Matches(%q) = %v, want %v", path, got, want)
		}
	}
	all := httpguard.New(&testutil.Stub{}, httpguard.Config{})
	if !all.Matches("/anything") {
		t.Error("an empty path list guards everything")
	}
}

func TestBlockedCallIsAnsweredHere(t *testing.T) {
	g := httpguard.New(testutil.Blocking("read_file"), httpguard.Config{})
	check := g.CheckRequest(context.Background(), "POST", info(), []byte(call(1, "read_file")))

	if check.Decision.Action != httpguard.Reply {
		t.Fatalf("action = %v, want Reply", check.Decision.Action)
	}
	if !strings.Contains(string(check.Decision.Body), `"code":-32001`) {
		t.Errorf("body = %s", check.Decision.Body)
	}
}

func TestOrdinaryCallIsNotRewritten(t *testing.T) {
	g := httpguard.New(&testutil.Stub{}, httpguard.Config{})
	check := g.CheckRequest(context.Background(), "POST", info(), []byte(call(1, "calculator")))
	if check.Decision.Action != httpguard.Pass {
		t.Fatalf("action = %v, want Pass", check.Decision.Action)
	}
	if check.Decision.Rewritten != nil {
		t.Error("an unchanged body must be handed on as it arrived, not rebuilt")
	}
}

func TestNonJSONBodyIsNotJudged(t *testing.T) {
	g := httpguard.New(testutil.Blocking("read_file"), httpguard.Config{})
	check := g.CheckRequest(context.Background(), "POST", info(), []byte("not json at all"))
	if check.Decision.Action != httpguard.Pass {
		t.Error("a body that is not JSON-RPC is the application's business")
	}
}

// Every member of a refused batch must be answered, or a client waits for ever on an id that
// never comes back.
func TestEveryMemberOfARefusedBatchIsAnswered(t *testing.T) {
	g := httpguard.New(testutil.Blocking("read_file"), httpguard.Config{})
	body := "[" + call(1, "calculator") + "," + call(2, "read_file") + "," +
		`{"jsonrpc":"2.0","method":"notifications/initialized"}` + ",42]"

	check := g.CheckRequest(context.Background(), "POST", info(), []byte(body))
	if check.Decision.Action != httpguard.Reply {
		t.Fatalf("action = %v, want Reply", check.Decision.Action)
	}
	var replies []map[string]any
	if err := json.Unmarshal(check.Decision.Body, &replies); err != nil {
		t.Fatalf("a batch must be answered with a batch: %v", err)
	}
	// ids 1 and 2 are answered; the notification and the bare 42 are not.
	if len(replies) != 2 {
		t.Fatalf("got %d replies, want 2: %s", len(replies), check.Decision.Body)
	}
	if !strings.Contains(string(check.Decision.Body), "Batch refused by MCPWatch") {
		t.Errorf("the un-refused member needs its own answer: %s", check.Decision.Body)
	}
}

func TestSessionNamingAndStrict(t *testing.T) {
	g := httpguard.New(&testutil.Stub{}, httpguard.Config{})
	ctx := context.Background()

	anon := g.CheckRequest(ctx, "POST", info(), []byte(call(1, "x")))
	if anon.Session() != "http-127.0.0.1" {
		t.Errorf("session = %q, want http-127.0.0.1", anon.Session())
	}
	if anon.Strict() {
		t.Error("no session header means not strict")
	}

	named := g.CheckRequest(ctx, "POST", info("Mcp-Session-Id", "abc"), []byte(call(1, "x")))
	if named.Session() != "abc" || !named.Strict() {
		t.Errorf("session = %q strict = %v", named.Session(), named.Strict())
	}

	// An empty session header still means the client is on an established session.
	empty := g.CheckRequest(ctx, "POST", info("Mcp-Session-Id", ""), []byte(call(1, "x")))
	if !empty.Strict() {
		t.Error("an empty session header is still strict")
	}
	if empty.Session() != "http-127.0.0.1" {
		t.Errorf("an empty header must fall back for the name, got %q", empty.Session())
	}
}

func TestGetIsRefusedWhenTheTransportSaysSo(t *testing.T) {
	g := httpguard.New(&testutil.Stub{RefuseHTTP: true}, httpguard.Config{})
	check := g.CheckRequest(context.Background(), "GET", info(), nil)
	if check.Decision.Action != httpguard.Refuse {
		t.Fatalf("action = %v, want Refuse", check.Decision.Action)
	}
}

func TestDeleteDropsTheSession(t *testing.T) {
	stub := &testutil.Stub{}
	g := httpguard.New(stub, httpguard.Config{})
	check := g.CheckRequest(context.Background(), "DELETE", info("Mcp-Session-Id", "abc"), nil)
	g.Finished(check)
	if !stub.Noted("drop:abc") {
		t.Errorf("DELETE must drop the session, notes = %v", stub.Notes())
	}
}

func TestANewSessionIDRenames(t *testing.T) {
	stub := &testutil.Stub{}
	g := httpguard.New(stub, httpguard.Config{})
	ctx := context.Background()
	check := g.CheckRequest(ctx, "POST", info(), []byte(call(1, "x")))
	headers := &mcpwatch.HTTPInfo{Headers: mcpwatch.HeadersFrom(map[string][]string{
		"Content-Type":   {"application/json"},
		"Mcp-Session-Id": {"server-issued"},
	})}
	g.Response(ctx, check, headers)

	if !stub.Noted("rename:http-127.0.0.1>server-issued") {
		t.Errorf("a new session id must rename, notes = %v", stub.Notes())
	}
	if check.Session() != "server-issued" {
		t.Errorf("the check must carry the new name, got %q", check.Session())
	}
}

func TestWithheldSingleResponseBecomesAnEmptyObject(t *testing.T) {
	g := httpguard.New(&testutil.Stub{WithholdSrv: true}, httpguard.Config{})
	ctx := context.Background()
	check := g.CheckRequest(ctx, "POST", info(), []byte(call(1, "x")))
	f := g.Response(ctx, check, info())
	if got := string(f.JSON(ctx, []byte(`{"jsonrpc":"2.0","id":1,"result":{"secret":"x"}}`))); got != "{}" {
		t.Errorf("a withheld response = %s, want {}", got)
	}
}
