package mcpwatch

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"io"
	"sync"
)

// Stream guards a byte stream of newline-delimited JSON-RPC in both directions.
//
// It sits between a transport and a server: the server reads from [Stream.Reader] and writes
// to [Stream.Writer], while the real peer is the in and out passed to [GuardIO]. Everything
// the server would have read is checked on the way in, and everything it writes is checked on
// the way out.
//
// This is the seam the SDK adapters use rather than wrapping an SDK's own connection type.
// The official Go SDK type-asserts its connections for optional interfaces whose methods are
// unexported, so an external wrapper cannot implement them and silently loses protocol
// version tracking. Interposing on the bytes keeps the SDK's own connection in place.
type Stream struct {
	v       Verdicts
	session string
	out     io.Writer
	maxLine int

	// in -> server
	toServer *io.PipeWriter
	reader   *io.PipeReader
	// server -> out
	fromServer *io.PipeReader
	writer     *io.PipeWriter

	writeMu   sync.Mutex // one whole line at a time on the real output
	wg        sync.WaitGroup
	closeOnce sync.Once
	dropOnce  sync.Once
}

// GuardIO guards a byte stream.
//
// in and out are the real peer - usually os.Stdin and os.Stdout. The returned Stream's
// Reader and Writer are what the server should be given in their place.
func GuardIO(ctx context.Context, v Verdicts, session string, in io.Reader, out io.Writer, maxLine int) *Stream {
	if maxLine <= 0 {
		maxLine = DefaultMaxMessageBytes
	}
	sr, sw := io.Pipe()
	cr, cw := io.Pipe()
	s := &Stream{
		v: v, session: session, out: out, maxLine: maxLine,
		toServer: sw, reader: sr,
		fromServer: cr, writer: cw,
	}
	s.wg.Add(2)
	go s.pumpFromClient(ctx, in)
	go s.pumpFromServer(ctx)
	return s
}

// Reader is what the server reads instead of the real input.
func (s *Stream) Reader() io.ReadCloser { return s.reader }

// Writer is what the server writes instead of the real output.
func (s *Stream) Writer() io.WriteCloser { return s.writer }

// pumpFromClient checks everything arriving from the client.
//
// Strictly sequential: the next line is not read while the current check is in flight. That
// head-of-line blocking is the ordering guarantee, not a bug - a tools/call judged before the
// initialize that precedes it would be judged without the session state it depends on.
func (s *Stream) pumpFromClient(ctx context.Context, in io.Reader) {
	defer s.wg.Done()
	defer s.toServer.Close()

	r := bufio.NewReaderSize(in, 64<<10)
	for {
		line, err := readLine(r, s.maxLine)
		if err != nil {
			if errors.Is(err, errLineTooLong) {
				continue // resynchronised on the next line
			}
			return
		}
		if len(line) == 0 {
			continue
		}
		if !isJSONObject(line) {
			// Not a message. Forwarded untouched; the server's own parser will object if it
			// needs to, and it is not the guard's place to invent a protocol error.
			_, _ = s.toServer.Write(append(line, '\n'))
			continue
		}
		// stdio carries no HTTP, so no http payload is sent at all. An empty one would still
		// switch on the transport rules that key off its presence.
		out := s.v.FromClient(ctx, s.session, json.RawMessage(line), nil)
		if len(out.Reply) > 0 {
			// Answered here. The tool never runs, and the refusal is never re-checked:
			// judging our own refusal could see it dropped and strand the client.
			s.writeOut(out.Reply)
		}
		if out.Dropped() {
			continue
		}
		if _, err := s.toServer.Write(append([]byte(out.Forward), '\n')); err != nil {
			return
		}
	}
}

// pumpFromServer checks everything the server sends back.
func (s *Stream) pumpFromServer(ctx context.Context) {
	defer s.wg.Done()

	r := bufio.NewReaderSize(s.fromServer, 64<<10)
	for {
		line, err := readLine(r, s.maxLine)
		if err != nil {
			if errors.Is(err, errLineTooLong) {
				continue
			}
			return
		}
		if len(line) == 0 {
			continue
		}
		if !isJSONObject(line) {
			s.writeOut(line)
			continue
		}
		// strict is false on an in-process stream: there is no forgeable channel here, so a
		// response the client did not ask for is the server's own bug, not an attack.
		out := s.v.FromServer(ctx, s.session, json.RawMessage(line), false)
		if len(out.Reply) > 0 {
			// A refusal owed to the server: injected as though the client had answered it.
			_, _ = s.toServer.Write(append([]byte(out.Reply), '\n'))
		}
		if out.Dropped() {
			continue
		}
		s.writeOut(out.Forward)
	}
}

// writeOut serialises every write to the real output, so a refusal for the client and a
// server message can never interleave mid-line.
func (s *Stream) writeOut(msg []byte) {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	_, _ = s.out.Write(append(msg, '\n'))
}

// Close stops the stream and tells the engine the session is over.
func (s *Stream) Close() error {
	s.closeOnce.Do(func() {
		_ = s.writer.Close()
		_ = s.reader.Close()
		_ = s.fromServer.Close()
		_ = s.toServer.Close()
		s.dropOnce.Do(func() { s.v.DropSession(s.session) })
	})
	return nil
}

// Wait blocks until both directions have finished.
func (s *Stream) Wait() { s.wg.Wait() }

func isJSONObject(b []byte) bool {
	for _, c := range b {
		switch c {
		case ' ', '\t', '\r', '\n':
			continue
		case '{':
			var probe map[string]json.RawMessage
			return json.Unmarshal(b, &probe) == nil
		default:
			return false
		}
	}
	return false
}
