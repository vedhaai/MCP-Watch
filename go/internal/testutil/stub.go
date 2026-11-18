package testutil

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"sync"

	mcpwatch "github.com/vedhaai/MCP-Watch/go"
)

// Stub is a Verdicts that answers from a script rather than from the engine.
//
// Most of this module is framing rather than judgement - batches, SSE boundaries, content
// lengths, session naming - and framing is better tested against something predictable than
// against the real rule set. These tests need no Node and no engine build.
type Stub struct {
	BlockTools    []string        // tool names to refuse
	WithholdSrv   bool            // drop every server message
	RewriteResult json.RawMessage // replace every server message with this
	RefuseHTTP    bool
	ServerReply   json.RawMessage

	mu    sync.Mutex
	notes []string
}

var _ mcpwatch.Verdicts = (*Stub)(nil)

// Blocking returns a stub that refuses calls to the named tools.
func Blocking(tools ...string) *Stub { return &Stub{BlockTools: tools} }

func (s *Stub) FromClient(_ context.Context, _ string, msg json.RawMessage, _ *mcpwatch.HTTPInfo) mcpwatch.Outcome {
	var shape struct {
		Params struct {
			Name string `json:"name"`
		} `json:"params"`
	}
	_ = json.Unmarshal(msg, &shape)
	for _, t := range s.BlockTools {
		if t == shape.Params.Name {
			return mcpwatch.Outcome{
				Reply: mcpwatch.ErrorReply(mcpwatch.IDOf(msg), mcpwatch.CodeBlocked,
					"Blocked by MCPWatch: MW002 stubbed"),
			}
		}
	}
	return mcpwatch.Pass(msg)
}

func (s *Stub) FromServer(_ context.Context, _ string, msg json.RawMessage, _ bool) mcpwatch.Outcome {
	if s.WithholdSrv {
		return mcpwatch.Outcome{Reply: s.ServerReply}
	}
	if len(s.RewriteResult) > 0 {
		return mcpwatch.Outcome{Forward: s.RewriteResult, Modified: true}
	}
	return mcpwatch.Pass(msg)
}

func (s *Stub) FromHTTP(context.Context, string, *mcpwatch.HTTPInfo, string) bool {
	return s.RefuseHTTP
}

func (s *Stub) RenameSession(from, to string) { s.note("rename:" + from + ">" + to) }
func (s *Stub) DropSession(session string)    { s.note("drop:" + session) }
func (s *Stub) NoteEventID(session, id string) {
	s.note(fmt.Sprintf("event:%s/%s", session, id))
}

func (s *Stub) note(n string) {
	s.mu.Lock()
	s.notes = append(s.notes, n)
	s.mu.Unlock()
}

// Notes returns the bookkeeping calls the guard made, in order.
func (s *Stub) Notes() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]string(nil), s.notes...)
}

// Noted reports whether a bookkeeping call was made.
func (s *Stub) Noted(want string) bool {
	for _, n := range s.Notes() {
		if strings.Contains(n, want) {
			return true
		}
	}
	return false
}
