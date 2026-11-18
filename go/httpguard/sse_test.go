package httpguard_test

import (
	"context"
	"strings"
	"testing"

	mcpwatch "github.com/vedhaai/MCP-Watch/go"
	"github.com/vedhaai/MCP-Watch/go/httpguard"
	"github.com/vedhaai/MCP-Watch/go/internal/testutil"
)

func sseFilter(t *testing.T, stub *testutil.Stub) (*httpguard.ResponseFilter, context.Context) {
	t.Helper()
	g := httpguard.New(stub, httpguard.Config{})
	ctx := context.Background()
	check := g.CheckRequest(ctx, "POST", info("Mcp-Session-Id", "s1"), []byte(call(1, "x")))
	headers := &mcpwatch.HTTPInfo{Headers: mcpwatch.HeadersFrom(map[string][]string{
		"Content-Type": {"text/event-stream"},
	})}
	f := g.Response(ctx, check, headers)
	if f.Kind() != httpguard.KindSSE {
		t.Fatalf("kind = %v, want SSE", f.Kind())
	}
	return f, ctx
}

// All six terminator pairs occur in the wild. Matching only the common three means the guard
// never sees some events end, and holds them for ever.
func TestEveryEventBoundaryForm(t *testing.T) {
	forms := map[string]string{
		"LF LF":     "\n\n",
		"CRLF CRLF": "\r\n\r\n",
		"CR CR":     "\r\r",
		"CRLF LF":   "\r\n\n",
		"LF CRLF":   "\n\r\n",
		"CR CRLF":   "\r\r\n",
	}
	for name, term := range forms {
		t.Run(name, func(t *testing.T) {
			f, ctx := sseFilter(t, &testutil.Stub{})
			out, err := f.Feed(ctx, []byte(`data: {"jsonrpc":"2.0","id":1,"result":{}}`+term))
			if err != nil {
				t.Fatal(err)
			}
			if len(out) == 0 {
				t.Fatalf("the event was never recognised as finished with %q", term)
			}
			if !strings.Contains(string(out), `"result"`) {
				t.Errorf("out = %q", out)
			}
		})
	}
}

func TestEventSplitAcrossChunksWaitsForItsEnd(t *testing.T) {
	f, ctx := sseFilter(t, &testutil.Stub{})

	out, err := f.Feed(ctx, []byte(`data: {"jsonrpc":"2.0",`))
	if err != nil {
		t.Fatal(err)
	}
	// A zero-length chunk is the terminal chunk on the wire, so "nothing ready" must be
	// expressed as an empty slice the caller knows not to write.
	if len(out) != 0 {
		t.Fatalf("a half event must produce nothing, got %q", out)
	}
	out, err = f.Feed(ctx, []byte(`"id":1,"result":{}}`+"\n\n"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(out), `"result"`) {
		t.Errorf("the reassembled event = %q", out)
	}
}

// A CR at the end of one chunk and an LF at the start of the next is one terminator, not two.
// Treating it as a boundary would open a blank event in the middle of the stream.
func TestCRLFSplitAcrossChunksIsOneTerminator(t *testing.T) {
	f, ctx := sseFilter(t, &testutil.Stub{})

	out, _ := f.Feed(ctx, []byte("data: {\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{}}\r"))
	if len(out) != 0 {
		t.Fatalf("a lone CR is not a boundary, got %q", out)
	}
	out, _ = f.Feed(ctx, []byte("\n"))
	if len(out) != 0 {
		t.Fatalf("CRLF is one terminator, not two, got %q", out)
	}
	out, _ = f.Feed(ctx, []byte("\r\n"))
	if !strings.Contains(string(out), `"result"`) {
		t.Errorf("the event should end now, got %q", out)
	}
}

func TestKeepAliveAndNonJSONEventsPassVerbatim(t *testing.T) {
	for _, event := range []string{": keep-alive\n\n", "event: ping\ndata: hello\n\n", "retry: 1000\n\n"} {
		f, ctx := sseFilter(t, testutil.Blocking("anything"))
		out, err := f.Feed(ctx, []byte(event))
		if err != nil {
			t.Fatal(err)
		}
		if string(out) != event {
			t.Errorf("%q must pass verbatim, got %q", event, out)
		}
	}
}

// A dropped event vanishes whole - but its id was still issued, so MW037 must have been told
// about it before the decision was taken.
func TestADroppedEventStillRecordsItsID(t *testing.T) {
	stub := &testutil.Stub{WithholdSrv: true}
	f, ctx := sseFilter(t, stub)

	out, err := f.Feed(ctx, []byte("id: ev-7\ndata: {\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{}}\n\n"))
	if err != nil {
		t.Fatal(err)
	}
	if len(out) != 0 {
		t.Errorf("a withheld event must vanish, got %q", out)
	}
	if !stub.Noted("event:s1/ev-7") {
		t.Errorf("the event id must be recorded even when the event is dropped, notes = %v", stub.Notes())
	}
}

func TestMultiLineDataIsReassembled(t *testing.T) {
	f, ctx := sseFilter(t, &testutil.Stub{})
	out, err := f.Feed(ctx, []byte("data: {\"jsonrpc\":\"2.0\",\ndata: \"id\":1,\"result\":{}}\n\n"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(out), `"result"`) {
		t.Errorf("multi-line data must be joined before checking, got %q", out)
	}
	if strings.Count(string(out), "data:") != 1 {
		t.Errorf("it should be re-emitted as one data line, got %q", out)
	}
}

func TestTrailingEventWithNoBlankLineIsStillChecked(t *testing.T) {
	stub := testutil.Blocking("x")
	stub.WithholdSrv = true
	f, ctx := sseFilter(t, stub)

	out, _ := f.Feed(ctx, []byte(`data: {"jsonrpc":"2.0","id":1,"result":{}}`))
	if len(out) != 0 {
		t.Fatalf("not finished yet, got %q", out)
	}
	if got := f.End(ctx); len(got) != 0 {
		t.Errorf("the final event must still be judged, got %q", got)
	}
}

func TestOversizedEventIsRefusedNotTruncated(t *testing.T) {
	g := httpguard.New(&testutil.Stub{}, httpguard.Config{MaxBodyBytes: 64})
	ctx := context.Background()
	check := g.CheckRequest(ctx, "POST", info("Mcp-Session-Id", "s1"), []byte(call(1, "x")))
	f := g.Response(ctx, check, &mcpwatch.HTTPInfo{
		Headers: mcpwatch.HeadersFrom(map[string][]string{"Content-Type": {"text/event-stream"}}),
	})
	_, err := f.Feed(ctx, []byte("data: "+strings.Repeat("A", 200)))
	if err == nil {
		t.Fatal("an event past the cap must be refused rather than silently truncated")
	}
}
