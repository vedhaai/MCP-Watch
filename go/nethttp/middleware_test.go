package nethttp_test

import (
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/vedhaai/MCP-Watch/go/internal/testutil"
	"github.com/vedhaai/MCP-Watch/go/nethttp"
)

func call(id int, tool string) string {
	return fmt.Sprintf(`{"jsonrpc":"2.0","id":%d,"method":"tools/call","params":{"name":%q,"arguments":{}}}`, id, tool)
}

// serve wires an app behind the guard on a real server. A real server, not a mock: mocks
// hide response buffering, the content length after a rewrite, and whether a stream still
// streams, which is most of what there is to get wrong here.
func serve(t *testing.T, stub *testutil.Stub, app http.Handler, opts ...nethttp.Option) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(nethttp.Middleware(stub, opts...)(app))
	t.Cleanup(srv.Close)
	return srv
}

func post(t *testing.T, srv *httptest.Server, path, body string) *http.Response {
	t.Helper()
	resp, err := http.Post(srv.URL+path, "application/json", strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { resp.Body.Close() })
	return resp
}

func TestBlockedCallNeverReachesTheApplication(t *testing.T) {
	reached := false
	app := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { reached = true })
	srv := serve(t, testutil.Blocking("read_file"), app)

	resp := post(t, srv, "/mcp", call(1, "read_file"))
	body, _ := io.ReadAll(resp.Body)

	if reached {
		t.Error("a blocked call must never reach the tool")
	}
	if resp.StatusCode != http.StatusOK {
		t.Errorf("status = %d, want 200: a JSON-RPC error travels in a 200", resp.StatusCode)
	}
	if !strings.Contains(string(body), `"code":-32001`) {
		t.Errorf("body = %s", body)
	}
}

func TestOrdinaryCallReachesTheApplication(t *testing.T) {
	var got string
	app := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		got = string(b)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"jsonrpc":"2.0","id":1,"result":{"ok":true}}`))
	})
	srv := serve(t, testutil.Blocking("read_file"), app)

	resp := post(t, srv, "/mcp", call(1, "calculator"))
	body, _ := io.ReadAll(resp.Body)

	if !strings.Contains(got, "calculator") {
		t.Errorf("the application saw %q", got)
	}
	if !strings.Contains(string(body), `"ok":true`) {
		t.Errorf("the response did not come back: %s", body)
	}
}

func TestRefusedTransportCheckIs403(t *testing.T) {
	reached := false
	app := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { reached = true })
	srv := serve(t, &testutil.Stub{RefuseHTTP: true}, app)

	resp, err := http.Get(srv.URL + "/mcp")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusForbidden {
		t.Errorf("status = %d, want 403", resp.StatusCode)
	}
	if reached {
		t.Error("a refused transport check must not reach the application")
	}
}

// Only a POST body is read. Eating a PUT body would leave the application an empty stream.
func TestNonPostBodyIsNeverEaten(t *testing.T) {
	var got string
	app := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		got = string(b)
	})
	srv := serve(t, &testutil.Stub{}, app)

	req, _ := http.NewRequest(http.MethodPut, srv.URL+"/mcp", strings.NewReader("payload"))
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if got != "payload" {
		t.Errorf("the application saw %q, want %q", got, "payload")
	}
}

func TestUnguardedPathIsUntouched(t *testing.T) {
	reached := false
	app := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { reached = true })
	srv := serve(t, testutil.Blocking("read_file"), app, nethttp.Paths("/mcp"))

	post(t, srv, "/health", call(1, "read_file"))
	if !reached {
		t.Error("an unguarded path must pass through even an attack")
	}
}

// The Rust adapter shipped a release whose path list was read before the builder had run, so
// it silently guarded everything. This asserts the option actually reaches the guard, in both
// directions.
func TestPathsOptionActuallyApplies(t *testing.T) {
	srv := serve(t, testutil.Blocking("read_file"),
		http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { _, _ = w.Write([]byte("app")) }),
		nethttp.Paths("/mcp"))

	guarded := post(t, srv, "/mcp", call(1, "read_file"))
	gb, _ := io.ReadAll(guarded.Body)
	if !strings.Contains(string(gb), "-32001") {
		t.Errorf("the guarded path must block: %s", gb)
	}
	unguarded := post(t, srv, "/other", call(1, "read_file"))
	ub, _ := io.ReadAll(unguarded.Body)
	if string(ub) != "app" {
		t.Errorf("an unguarded path must reach the application, got %q", ub)
	}
}

func TestOversizedPostIsRefusedBeforeTheApplication(t *testing.T) {
	reached := false
	app := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { reached = true })
	srv := serve(t, &testutil.Stub{}, app, nethttp.MaxBodyBytes(64))

	resp := post(t, srv, "/mcp", strings.Repeat("A", 500))
	if resp.StatusCode != http.StatusRequestEntityTooLarge {
		t.Errorf("status = %d, want 413", resp.StatusCode)
	}
	if reached {
		t.Error("an oversized body must not reach the application")
	}
}

// A rewritten response must carry the length actually sent, or the client hangs waiting for
// bytes that will never come.
func TestRewrittenResponseCarriesTheRightLength(t *testing.T) {
	stub := &testutil.Stub{RewriteResult: []byte(`{"jsonrpc":"2.0","id":1,"result":{"stripped":true}}`)}
	app := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"jsonrpc":"2.0","id":1,"result":{"a":"much much much longer body"}}`))
	})
	srv := serve(t, stub, app)

	resp := post(t, srv, "/mcp", call(1, "calculator"))
	body, _ := io.ReadAll(resp.Body)

	if !strings.Contains(string(body), "stripped") {
		t.Fatalf("the rewrite did not reach the client: %s", body)
	}
	if got := resp.ContentLength; got != int64(len(body)) {
		t.Errorf("Content-Length = %d but %d bytes arrived", got, len(body))
	}
}

// The test that catches accidental buffering: the first event must arrive well before the
// server has produced the second. A guard that collects the whole response before filtering
// it passes every other test in this file and breaks every real stream.
func TestSSEStillStreams(t *testing.T) {
	app := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		rc := http.NewResponseController(w)
		for i := 1; i <= 2; i++ {
			fmt.Fprintf(w, "data: {\"jsonrpc\":\"2.0\",\"id\":%d,\"result\":{}}\n\n", i)
			rc.Flush()
			if i == 1 {
				time.Sleep(300 * time.Millisecond)
			}
		}
	})
	srv := serve(t, &testutil.Stub{}, app)

	start := time.Now()
	resp := post(t, srv, "/mcp", call(1, "calculator"))

	buf := make([]byte, 128)
	n, err := resp.Body.Read(buf)
	if err != nil && n == 0 {
		t.Fatalf("read: %v", err)
	}
	elapsed := time.Since(start)

	if !strings.Contains(string(buf[:n]), `"id":1`) {
		t.Errorf("first chunk = %q", buf[:n])
	}
	if elapsed > 250*time.Millisecond {
		t.Errorf("the first event took %s: the guard is buffering the whole stream", elapsed)
	}
}

func TestWithheldSSEEventVanishesAndTheStreamContinues(t *testing.T) {
	stub := &testutil.Stub{WithholdSrv: true}
	app := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		rc := http.NewResponseController(w)
		_, _ = io.WriteString(w, "data: {\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{}}\n\n")
		rc.Flush()
		_, _ = io.WriteString(w, ": keep-alive\n\n")
		rc.Flush()
	})
	srv := serve(t, stub, app)

	resp := post(t, srv, "/mcp", call(1, "calculator"))
	body, _ := io.ReadAll(resp.Body)

	if strings.Contains(string(body), `"result"`) {
		t.Errorf("the withheld event must not reach the client: %q", body)
	}
	if !strings.Contains(string(body), "keep-alive") {
		t.Errorf("the stream must carry on after a dropped event: %q", body)
	}
}

// Go moves the Host header onto r.Host, so a straight copy of r.Header loses it - and
// MW030, MW034 and MW035 all read it.
func TestHostHeaderReachesTheEngine(t *testing.T) {
	seen := make(chan string, 1)
	stub := &hostSpy{seen: seen}
	srv := httptest.NewServer(nethttp.Middleware(stub)(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {})))
	defer srv.Close()

	resp, err := http.Post(srv.URL+"/mcp", "application/json", strings.NewReader(call(1, "x")))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()

	select {
	case host := <-seen:
		if host == "" {
			t.Error("the engine was told no host at all")
		}
	case <-time.After(time.Second):
		t.Fatal("the guard never ran")
	}
}
