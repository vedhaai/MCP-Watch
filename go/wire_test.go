package mcpwatch

import (
	"encoding/json"
	"strings"
	"testing"
)

// The engine tests `info.remoteAddress !== undefined`, so an absent key and a null mean
// opposite things. A plain string field, or a pointer without omitempty, marshals to null -
// which switches MW037 on for a guard that reports no event ids, and every stream resumption
// is then refused. Verified against the real engine: the same benign call is forwarded with
// the key absent and blocked by MW037 with the key present and null.
//
// This asserts the bytes rather than the struct, because the bytes are what has the property.
func TestHTTPInfoOmitsRatherThanNulls(t *testing.T) {
	info := &HTTPInfo{Headers: HeadersFrom(map[string][]string{"Origin": {"https://app.example.com"}})}

	b, err := json.Marshal(info)
	if err != nil {
		t.Fatal(err)
	}
	got := string(b)
	for _, forbidden := range []string{"remoteAddress", "encrypted", "insecureUpstream", "null"} {
		if strings.Contains(got, forbidden) {
			t.Errorf("an unset HTTPInfo must not mention %q, got %s", forbidden, got)
		}
	}

	// And when they are genuinely known, they must appear - including a false, which is the
	// one value MW034's second clause needs.
	info.RemoteAddress = String("203.0.113.9")
	info.Encrypted = Bool(false)
	b, _ = json.Marshal(info)
	got = string(b)
	if !strings.Contains(got, `"remoteAddress":"203.0.113.9"`) {
		t.Errorf("a known remote address must be sent, got %s", got)
	}
	if !strings.Contains(got, `"encrypted":false`) {
		t.Errorf(`encrypted:false must survive omitempty, got %s`, got)
	}
}

// Go's http.Header is canonical-cased and the engine folds nothing, so a header passed
// straight through is a header the engine never finds.
func TestHeadersAreLowerCased(t *testing.T) {
	h := HeadersFrom(map[string][]string{
		"Content-Type":    {"application/json"},
		"Mcp-Session-Id":  {"abc"},
		"X-Forwarded-For": {"203.0.113.9", "198.51.100.4"},
	})
	info := &HTTPInfo{Headers: h}

	if got := info.Get("content-type"); got != "application/json" {
		t.Errorf("content-type = %q", got)
	}
	if got := info.Get("x-forwarded-for"); got != "203.0.113.9, 198.51.100.4" {
		t.Errorf("repeated headers must be joined as they arrived, got %q", got)
	}
	for name := range h {
		if name != strings.ToLower(name) {
			t.Errorf("header %q was not lower-cased", name)
		}
	}
}

// An empty Mcp-Session-Id still makes a server message strict. The asymmetry is deliberate
// and shared with the other adapters, so Has must not collapse into Get.
func TestHasDistinguishesEmptyFromAbsent(t *testing.T) {
	info := &HTTPInfo{Headers: HeadersFrom(map[string][]string{"Mcp-Session-Id": {""}})}
	if !info.Has("mcp-session-id") {
		t.Error("an empty session header is present")
	}
	if info.Has("origin") {
		t.Error("an absent header is not present")
	}
}

func TestIsRequestIsWhatFailClosedTurnsOn(t *testing.T) {
	tests := []struct {
		name string
		msg  string
		want bool
	}{
		{"request", `{"jsonrpc":"2.0","id":1,"method":"tools/call"}`, true},
		{"string id", `{"jsonrpc":"2.0","id":"a","method":"tools/call"}`, true},
		{"notification has no id", `{"jsonrpc":"2.0","method":"notifications/initialized"}`, false},
		{"null id is not an id", `{"jsonrpc":"2.0","id":null,"method":"x"}`, false},
		{"response has no method", `{"jsonrpc":"2.0","id":1,"result":{}}`, false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			if got := IsRequest(json.RawMessage(tt.msg)); got != tt.want {
				t.Errorf("IsRequest(%s) = %v, want %v", tt.msg, got, tt.want)
			}
		})
	}
}

// Fail-closed refuses requests only: a notification and a response have nowhere to put a
// refusal, so holding them back would strand the peer.
func TestFailClosedRefusesRequestsOnly(t *testing.T) {
	e, err := NewEngine("t", Options{Logger: func(string, ...any) {}})
	if err != nil {
		t.Fatal(err)
	}
	cause := ErrNotInstalled

	request := json.RawMessage(`{"jsonrpc":"2.0","id":7,"method":"tools/call"}`)
	out := e.failed(request, cause)
	if !out.Blocked() {
		t.Fatal("a request must be refused when the engine is unreachable")
	}
	if !strings.Contains(string(out.Reply), `"id":7`) {
		t.Errorf("the refusal must answer the request's own id, got %s", out.Reply)
	}
	if !strings.Contains(string(out.Reply), "MCPWatch failed closed") {
		t.Errorf("the message must match the engine's own, got %s", out.Reply)
	}

	for _, msg := range []string{
		`{"jsonrpc":"2.0","method":"notifications/initialized"}`,
		`{"jsonrpc":"2.0","id":7,"result":{}}`,
	} {
		if out := e.failed(json.RawMessage(msg), cause); out.Dropped() {
			t.Errorf("%s must pass even when the engine is unreachable", msg)
		}
	}

	// And with FailOpen, even a request passes.
	open, _ := NewEngine("t", Options{FailOpen: Bool(true), Logger: func(string, ...any) {}})
	if out := open.failed(request, cause); out.Dropped() {
		t.Error("fail-open must let a request through")
	}
}

// Large ids must survive both the comparison and a rewrite.
func TestLargeIDHandling(t *testing.T) {
	const big = "9007199254740993"
	original := json.RawMessage(`{"jsonrpc":"2.0","id":` + big + `,"method":"tools/call"}`)
	// What Node gives back for an unchanged message.
	echoed := json.RawMessage(`{"jsonrpc":"2.0","id":9007199254740992,"method":"tools/call"}`)

	if !Equal(original, echoed) {
		t.Error("a float64 round-trip is not a rewrite; Equal must treat it as unchanged")
	}
	rewritten := json.RawMessage(`{"jsonrpc":"2.0","id":9007199254740992,"method":"tools/call","params":{}}`)
	if got := WithID(rewritten, IDOf(original)); !strings.Contains(string(got), big) {
		t.Errorf("a rewrite must keep the original id, got %s", got)
	}
}

func TestErrorReplyKeepsTheIDVerbatim(t *testing.T) {
	for _, id := range []string{`7`, `"abc"`, `9007199254740993`, `null`} {
		got := string(ErrorReply(json.RawMessage(id), CodeBlocked, "Blocked by MCPWatch"))
		if !strings.Contains(got, `"id":`+id) {
			t.Errorf("id %s was not preserved: %s", id, got)
		}
	}
}

// Options must never travel on the command line: /proc/<pid>/cmdline is world-readable and a
// project key would be visible to every user on the machine.
func TestProjectKeyNeverReachesArgv(t *testing.T) {
	opts := Options{ProjectKey: "mw_not_a_real_key_000000000000000"}
	wire, err := opts.engineOptions("srv")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(wire), "mw_not_a_real_key") {
		t.Fatal("the key must reach the engine through its options")
	}
	cmd, err := resolveEngineCommand([]string{"node", "/tmp/cli.js"})
	if err != nil {
		t.Fatal(err)
	}
	for _, arg := range cmd {
		if strings.Contains(arg, "mw_") {
			t.Errorf("a key reached argv: %v", cmd)
		}
	}
	if cmd[len(cmd)-1] != "engine" {
		t.Errorf("the engine subcommand must be appended, got %v", cmd)
	}
}

func TestSplitCommandKeepsWindowsPaths(t *testing.T) {
	got := splitCommand(`"C:\Program Files\nodejs\node.exe" --flag`)
	want := []string{`C:\Program Files\nodejs\node.exe`, "--flag"}
	if len(got) != len(want) || got[0] != want[0] || got[1] != want[1] {
		t.Errorf("splitCommand = %q, want %q", got, want)
	}
}
