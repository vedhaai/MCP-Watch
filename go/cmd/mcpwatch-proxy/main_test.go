package main

import (
	"bufio"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/vedhaai/MCP-Watch/go/internal/testutil"
)

// fakeServer answers anything with {id, method, seen}, so a test can tell whether a message
// actually reached it rather than only whether the client got an answer.
const fakeServer = `
let buf = "";
const seen = [];
process.stdin.on("data", (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    let msg; try { msg = JSON.parse(line); } catch { continue; }
    seen.push(msg.method);
    if (msg.id !== undefined) {
      process.stdout.write(JSON.stringify({
        jsonrpc: "2.0", id: msg.id,
        result: { reached: true, method: msg.method, seen: seen.length },
      }) + "\n");
    }
  }
});
`

type proxy struct {
	cmd *exec.Cmd
	in  *os.File
	out *bufio.Reader
}

func startProxy(t *testing.T, mode string) *proxy {
	t.Helper()
	cli := testutil.RequireEngine(t)
	dir := t.TempDir()

	serverJS := filepath.Join(dir, "fake-server.js")
	if err := os.WriteFile(serverJS, []byte(fakeServer), 0o600); err != nil {
		t.Fatal(err)
	}
	// cmd/go puts its own directory on PATH for test subprocesses, so a bare "go" resolves
	// even when the toolchain is not on the developer's PATH. Falling back to GOROOT keeps
	// that from being load-bearing.
	goBin, err := exec.LookPath("go")
	if err != nil {
		goBin = filepath.Join(runtime.GOROOT(), "bin", "go")
		if _, statErr := os.Stat(goBin); statErr != nil {
			t.Skipf("no Go toolchain to build the proxy with: %v", err)
		}
	}
	bin := filepath.Join(dir, "mcpwatch-proxy")
	build := exec.Command(goBin, "build", "-o", bin, ".")
	build.Stderr = os.Stderr
	// Deliberately fatal, not a skip. The toolchain was found, so a failure here means the
	// proxy does not compile - and a skip would let the gate report success anyway.
	if err := build.Run(); err != nil {
		t.Fatalf("the proxy does not build: %v", err)
	}

	cmd := exec.Command(bin, "--name", "go-proxy-test", "--mode", mode, "--", "node", serverJS)
	cmd.Env = append(os.Environ(),
		"MCPWATCH_ENGINE=node "+cli,
		"MCPWATCH_EVENTS="+filepath.Join(dir, "events.jsonl"),
		"MCPWATCH_PINS="+filepath.Join(dir, "pins.json"),
	)
	for _, drop := range []string{"MCPWATCH_PROJECT_KEY=", "MCPWATCH_AI=", "MCPWATCH_MODE="} {
		cmd.Env = append(cmd.Env, drop)
	}
	cmd.Stderr = os.Stderr
	stdin, err := cmd.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_ = stdin.Close()
		_ = cmd.Process.Kill()
		_ = cmd.Wait()
	})
	p := &proxy{cmd: cmd, out: bufio.NewReader(stdout)}
	p.in = stdin.(*os.File)
	return p
}

func (p *proxy) send(t *testing.T, line string) {
	t.Helper()
	if _, err := p.in.WriteString(line + "\n"); err != nil {
		t.Fatal(err)
	}
}

func (p *proxy) next(t *testing.T) map[string]any {
	t.Helper()
	type result struct {
		line string
		err  error
	}
	ch := make(chan result, 1)
	go func() {
		l, err := p.out.ReadString('\n')
		ch <- result{l, err}
	}()
	select {
	case r := <-ch:
		if r.err != nil {
			t.Fatalf("read: %v", r.err)
		}
		var m map[string]any
		if err := json.Unmarshal([]byte(r.line), &m); err != nil {
			t.Fatalf("not JSON: %q", r.line)
		}
		return m
	case <-time.After(20 * time.Second):
		t.Fatal("nothing came back from the proxy")
		return nil
	}
}

func call(id int, tool, arg string) string {
	b, _ := json.Marshal(map[string]any{
		"jsonrpc": "2.0", "id": id, "method": "tools/call",
		"params": map[string]any{"name": tool, "arguments": map[string]any{"path": arg}},
	})
	return string(b)
}

func TestProxyPassesABenignCallToTheServer(t *testing.T) {
	p := startProxy(t, "enforce")
	p.send(t, call(1, "calculator", "2+2"))

	got := p.next(t)
	res, ok := got["result"].(map[string]any)
	if !ok {
		t.Fatalf("want a result, got %v", got)
	}
	if res["reached"] != true {
		t.Errorf("the call should have reached the server: %v", got)
	}
}

// The server's own counter is what proves a blocked call never arrived - the client being
// answered proves only that something answered it.
func TestProxyBlocksBeforeTheServer(t *testing.T) {
	p := startProxy(t, "enforce")

	p.send(t, call(1, "read_file", "../../../../etc/passwd"))
	blocked := p.next(t)
	errObj, ok := blocked["error"].(map[string]any)
	if !ok {
		t.Fatalf("want an error, got %v", blocked)
	}
	if errObj["code"].(float64) != -32001 {
		t.Errorf("code = %v, want -32001", errObj["code"])
	}

	p.send(t, call(2, "calculator", "1+1"))
	after := p.next(t)
	res := after["result"].(map[string]any)
	if seen := res["seen"].(float64); seen != 1 {
		t.Errorf("the server saw %v messages; the blocked one reached it", seen)
	}
}

func TestProxyForwardsANonJSONLineUntouched(t *testing.T) {
	p := startProxy(t, "enforce")
	p.send(t, "this is not json")
	p.send(t, call(1, "calculator", "1+1"))
	got := p.next(t)
	if _, ok := got["result"]; !ok {
		t.Errorf("a junk line must not break the stream: %v", got)
	}
}

func TestProxyObserveModeLetsAnAttackThrough(t *testing.T) {
	p := startProxy(t, "observe")
	p.send(t, call(1, "read_file", "../../../../etc/passwd"))
	got := p.next(t)
	if _, ok := got["error"]; ok {
		t.Errorf("observe must never refuse: %v", got)
	}
	if !strings.Contains(firstKey(got), "result") {
		t.Errorf("want a result, got %v", got)
	}
}

func firstKey(m map[string]any) string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	return strings.Join(keys, ",")
}
