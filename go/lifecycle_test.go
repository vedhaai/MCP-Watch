package mcpwatch_test

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"

	mcpwatch "github.com/vedhaai/MCP-Watch/go"
	"github.com/vedhaai/MCP-Watch/go/internal/testutil"
)

// The bookkeeping calls are documented as infallible and are reached from deferred cleanup -
// Stream.Close, a DELETE teardown, the SSE hot path - which is exactly where a Close has
// usually just run. Shutdown closes the notes channel, and a send on a closed channel panics
// even inside a select with a default arm: the send case is chosen and then panics, so the
// default never runs. That took down the caller's whole process from a defer.
func TestBookkeepingAfterCloseDoesNotPanic(t *testing.T) {
	e := startForLifecycle(t)

	// Use it first, so the note-draining goroutine is really running and the channel is
	// really closed by Shutdown rather than merely claimed.
	e.NoteEventID("s", "evt-1")
	if err := e.Close(); err != nil {
		t.Fatalf("close: %v", err)
	}

	// Each of these reaches Engine.send.
	e.NoteEventID("s", "evt-2")
	e.DropSession("s")
	e.RenameSession("s", "s2")

	// And again concurrently, which is how it actually happens.
	done := make(chan struct{})
	go func() {
		defer close(done)
		for i := 0; i < 200; i++ {
			e.NoteEventID("s", "evt")
			e.DropSession("s")
		}
	}()
	select {
	case <-done:
	case <-time.After(10 * time.Second):
		t.Fatal("bookkeeping blocked after Close")
	}
}

// Close is idempotent, and the second one must not re-close the notes channel either.
func TestCloseTwice(t *testing.T) {
	e := startForLifecycle(t)
	if err := e.Close(); err != nil {
		t.Fatalf("first close: %v", err)
	}
	if err := e.Close(); err != nil {
		t.Fatalf("second close: %v", err)
	}
	e.DropSession("s")
}

// A check after Close must fail as a check, not panic and not hang.
func TestCheckAfterCloseFailsClosed(t *testing.T) {
	e := startForLifecycle(t)
	if err := e.Close(); err != nil {
		t.Fatalf("close: %v", err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	msg := json.RawMessage(`{"jsonrpc":"2.0","id":1,"method":"tools/list"}`)
	out := e.FromClient(ctx, "s", msg, nil)
	if out.Forward != nil {
		t.Fatalf("a closed engine forwarded a request: %s", out.Forward)
	}
	if out.Reply == nil {
		t.Fatal("a closed engine neither forwarded nor refused")
	}
}

// fakeEngine speaks just enough of the sidecar protocol to be driven on purpose. The real
// engine cannot be made to start slowly or to wedge, and both of those are the bug.
//
//	argv[2] - milliseconds to wait before the handshake
//	argv[3] - "garbage" to emit non-JSON on stdout after the handshake and then stay alive,
//	          which is what kills the reader goroutine while the process is still running
const fakeEngine = `
const delayMs = Number(process.argv[2] || 0);
const garbage = process.argv[3] === "garbage";
const out = (o) => process.stdout.write(JSON.stringify(o) + "\n");
setTimeout(() => {
  out({ id: 0, ready: true, mode: "enforce" });
  if (garbage) {
    for (let i = 0; i < 25; i++) process.stdout.write("this is not json " + i + "\n");
    setInterval(() => {}, 1 << 30); // stay alive, answer nothing
    return;
  }
  let buf = "";
  process.stdin.on("data", (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      let req; try { req = JSON.parse(line); } catch { continue; }
      if (req.op === "client" || req.op === "server") out({ id: req.id, forward: req.msg, reply: null });
      else if (req.op === "http") out({ id: req.id, refuse: false });
      else out({ id: req.id, ok: true });
    }
  });
  process.stdin.on("end", () => process.exit(0));
}, delayMs);
`

func withFakeEngine(t *testing.T, opts mcpwatch.Options, args ...string) *mcpwatch.Engine {
	t.Helper()
	testutil.RequireEngine(t) // only to establish that node is usable here
	testutil.ScrubEnv(t)
	dir := t.TempDir()

	js := filepath.Join(dir, "fake-engine.js")
	if err := os.WriteFile(js, []byte(fakeEngine), 0o600); err != nil {
		t.Fatal(err)
	}
	opts.Mode = mcpwatch.ModeEnforce
	opts.EngineCommand = append([]string{"node", js}, args...)
	opts.EventsFile = filepath.Join(dir, "events.jsonl")
	opts.PinsFile = filepath.Join(dir, "pins.json")
	opts.RegistryFile = filepath.Join(dir, "registry.json")
	opts.Logger = func(string, ...any) {}

	e, err := mcpwatch.NewEngine("go-lifecycle-test", opts)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = e.Close() })
	return e
}

// StartTimeout governs starting; CallTimeout governs the round trip. Wrapping both in the
// call timeout silently capped a lazy first start at CallTimeout and killed the handshake
// mid-flight - which defeats the whole point of the 120s default, since that exists only so
// an `npx -y @vedhaai/mcpwatch` cold download can finish.
func TestCallTimeoutDoesNotCapStartTimeout(t *testing.T) {
	// The handshake takes 1s, which is longer than the call budget and far shorter than the
	// start budget. Only the correct ordering lets this start at all.
	e := withFakeEngine(t, mcpwatch.Options{
		StartTimeout: 60 * time.Second,
		CallTimeout:  300 * time.Millisecond,
	}, "1000")

	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	// Deliberately NOT calling Start: this is the lazy path, the one that was capped.
	msg := json.RawMessage(`{"jsonrpc":"2.0","id":1,"method":"tools/list"}`)
	out := e.FromClient(ctx, "s", msg, nil)
	if out.Forward == nil {
		t.Fatalf("a benign request did not survive a lazy start: reply=%s", out.Reply)
	}
}

// When the reader goroutine stops while the process is still alive - here because the engine
// writes nothing but noise - nothing drains stdout and nothing closes c.exited, so
// ensureStarted kept handing back the same wedged child for ever. Every later check then
// waited out the whole CallTimeout before failing closed, with no restart ever attempted.
// What is asserted is the symptom that costs a server its latency: the call must come back
// quickly, not after the full budget.
func TestAWedgedEngineDoesNotCostTheFullCallTimeout(t *testing.T) {
	e := withFakeEngine(t, mcpwatch.Options{
		StartTimeout:   30 * time.Second,
		CallTimeout:    4 * time.Second,
		RestartBackoff: time.Hour, // no restart can succeed; the point is that it fails fast
	}, "0", "garbage")

	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	if err := e.Start(ctx); err != nil {
		t.Fatalf("the fake engine did not hand over a handshake: %v", err)
	}

	// Give the reader time to consume the 25 noise lines and give up.
	time.Sleep(500 * time.Millisecond)

	msg := json.RawMessage(`{"jsonrpc":"2.0","id":1,"method":"tools/list"}`)
	began := time.Now()
	out := e.FromClient(ctx, "s", msg, nil)
	took := time.Since(began)

	if out.Reply == nil {
		t.Fatalf("a wedged engine forwarded a request instead of failing closed: %s", out.Forward)
	}
	if took > 2*time.Second {
		t.Fatalf("a wedged engine cost %s - the whole call timeout - so it was reused rather than replaced", took)
	}
}

func startForLifecycle(t *testing.T) *mcpwatch.Engine {
	t.Helper()
	cli := testutil.RequireEngine(t)
	testutil.ScrubEnv(t)
	dir := t.TempDir()

	e, err := mcpwatch.NewEngine("go-lifecycle-test", mcpwatch.Options{
		Mode:          mcpwatch.ModeEnforce,
		EngineCommand: []string{"node", cli},
		EventsFile:    filepath.Join(dir, "events.jsonl"),
		PinsFile:      filepath.Join(dir, "pins.json"),
		RegistryFile:  filepath.Join(dir, "registry.json"),
		Logger:        func(string, ...any) {},
	})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	if err := e.Start(ctx); err != nil {
		var se *mcpwatch.StartError
		if errors.As(err, &se) {
			t.Skipf("the engine would not start: %v", err)
		}
		t.Fatal(err)
	}
	return e
}
