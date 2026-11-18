package mcpwatch_test

import (
	"bufio"
	"context"
	"io"
	"strings"
	"testing"
	"time"

	mcpwatch "github.com/vedhaai/MCP-Watch/go"
	"github.com/vedhaai/MCP-Watch/go/internal/testutil"
)

// echoServer stands in for an MCP server: it answers every message it is given.
func echoServer(t *testing.T, s *mcpwatch.Stream) {
	t.Helper()
	go func() {
		r := bufio.NewReader(s.Reader())
		for {
			line, err := r.ReadString('\n')
			if err != nil {
				return
			}
			if strings.TrimSpace(line) == "" {
				continue
			}
			_, _ = io.WriteString(s.Writer(), `{"jsonrpc":"2.0","id":1,"result":{"reached":true}}`+"\n")
		}
	}()
}

func TestStreamBlocksBeforeTheServerSeesIt(t *testing.T) {
	stub := testutil.Blocking("read_file")
	in, inW := io.Pipe()
	var out strings.Builder
	outCh := make(chan string, 4)

	s := mcpwatch.GuardIO(context.Background(), stub, "conn-1", in, writerFunc(func(p []byte) (int, error) {
		out.Write(p)
		outCh <- string(p)
		return len(p), nil
	}), 0)
	defer s.Close()

	reached := make(chan struct{}, 1)
	go func() {
		r := bufio.NewReader(s.Reader())
		for {
			line, err := r.ReadString('\n')
			if err != nil {
				return
			}
			if strings.TrimSpace(line) != "" {
				reached <- struct{}{}
			}
		}
	}()

	_, _ = io.WriteString(inW, `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"read_file","arguments":{}}}`+"\n")

	select {
	case got := <-outCh:
		if !strings.Contains(got, "-32001") {
			t.Errorf("the client should have been answered by the guard, got %q", got)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("no refusal reached the client")
	}
	select {
	case <-reached:
		t.Error("a blocked call must never reach the server")
	case <-time.After(200 * time.Millisecond):
	}
}

func TestStreamPassesAnOrdinaryCallBothWays(t *testing.T) {
	in, inW := io.Pipe()
	outCh := make(chan string, 4)
	s := mcpwatch.GuardIO(context.Background(), testutil.Blocking("read_file"), "conn-1", in,
		writerFunc(func(p []byte) (int, error) { outCh <- string(p); return len(p), nil }), 0)
	defer s.Close()
	echoServer(t, s)

	_, _ = io.WriteString(inW, `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"calculator","arguments":{}}}`+"\n")

	select {
	case got := <-outCh:
		if !strings.Contains(got, "reached") {
			t.Errorf("the server's answer should reach the client, got %q", got)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("nothing came back")
	}
}

func TestStreamForwardsNonJSONUntouched(t *testing.T) {
	in, inW := io.Pipe()
	seen := make(chan string, 4)
	s := mcpwatch.GuardIO(context.Background(), testutil.Blocking("x"), "conn-1", in,
		writerFunc(func(p []byte) (int, error) { return len(p), nil }), 0)
	defer s.Close()

	go func() {
		r := bufio.NewReader(s.Reader())
		for {
			line, err := r.ReadString('\n')
			if err != nil {
				return
			}
			seen <- strings.TrimSpace(line)
		}
	}()

	_, _ = io.WriteString(inW, "this is not json\n")
	select {
	case got := <-seen:
		if got != "this is not json" {
			t.Errorf("got %q", got)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("the line never arrived")
	}
}

type writerFunc func([]byte) (int, error)

func (f writerFunc) Write(p []byte) (int, error) { return f(p) }
