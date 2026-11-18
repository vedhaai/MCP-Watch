package mcpwatch

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"os"
	"os/exec"
	"sync"
	"sync/atomic"
	"time"
)

// handshakeID is the id the engine uses for its unprompted ready line. Caller ids start at 1
// so that nothing can ever be mistaken for it.
const handshakeID uint64 = 0

// answer is one line read back from the engine.
//
// Every field that can legitimately be absent is a pointer or a json.RawMessage, because
// absent and null mean different things on this wire:
//
//   - ID is *uint64 because a malformed input line is answered {"id":null,...}. Decoded into
//     a plain uint64 that would become 0 and be delivered to whoever is waiting on the
//     handshake.
//   - Forward is nil when the key is absent and the two bytes "null" when it is explicitly
//     null. That is the discriminator between an engine-level refusal and a dropped message.
type answer struct {
	ID      *uint64         `json:"id"`
	Forward json.RawMessage `json:"forward"`
	Reply   json.RawMessage `json:"reply"`
	Refuse  *bool           `json:"refuse"`
	Ready   *bool           `json:"ready"`
	OK      *bool           `json:"ok"`
	Mode    string          `json:"mode"`
	Error   string          `json:"error"`
}

// isEngineRefusal distinguishes "the engine refused the request" from "the engine refused the
// message". A blocked message also carries an error, but one level down inside Reply; an
// engine-level error arrives at the top level with no forward key at all.
func (a *answer) isEngineRefusal() bool { return a.Error != "" && a.Forward == nil }

// child is one spawned engine process.
//
// The pending map lives here rather than on Engine, so that a dead engine's reader can only
// fail the calls that were made to it. It holds this struct and has no way to name its
// replacement, so the isolation is structural rather than a rule somebody has to remember.
type child struct {
	cmd     *exec.Cmd
	stdin   io.WriteCloser
	writeMu sync.Mutex

	pendMu sync.Mutex
	pend   map[uint64]chan *answer

	exited chan struct{}
	code   atomic.Int32
}

func (c *child) register(id uint64) chan *answer {
	ch := make(chan *answer, 1)
	c.pendMu.Lock()
	c.pend[id] = ch
	c.pendMu.Unlock()
	return ch
}

func (c *child) forget(id uint64) {
	c.pendMu.Lock()
	delete(c.pend, id)
	c.pendMu.Unlock()
}

func (c *child) deliver(a *answer) {
	c.pendMu.Lock()
	ch, ok := c.pend[*a.ID]
	if ok {
		delete(c.pend, *a.ID)
	}
	c.pendMu.Unlock()
	if ok {
		ch <- a // buffered by one, so a caller that has already walked away cannot park the reader
	}
}

// failAll resolves everything still waiting. Channels are closed rather than given a
// synthetic answer, so nothing can mistake "the engine died" for a verdict.
func (c *child) failAll() {
	c.pendMu.Lock()
	pend := c.pend
	c.pend = map[uint64]chan *answer{}
	c.pendMu.Unlock()
	for _, ch := range pend {
		close(ch)
	}
}

func (c *child) writeLine(line []byte) error {
	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	if _, err := c.stdin.Write(line); err != nil {
		return &SpawnError{Command: "the engine's stdin", Err: err}
	}
	return nil
}

type note struct {
	op     string
	fields map[string]any
}

// Engine is a client for the MCPWatch engine, started as a child process.
//
// It decides nothing itself: every verdict comes from the engine, so a Go server gets exactly
// the verdicts a Node, Python, Java, Rust or .NET one would.
type Engine struct {
	name     string
	opts     Options
	wireOpts []byte
	logf     func(string, ...any)

	ids atomic.Uint64

	mu        sync.Mutex // guards cur, lastStart, closed
	cur       *child
	lastStart time.Time
	closed    bool

	// pid at construction. A process that forked and re-executed inherits our pipes but not
	// our right to use them, and two processes writing the same pipe interleave mid-line and
	// steal each other's answers - silently, and matched by id, so the corruption looks like
	// a verdict rather than an error.
	pid int

	mode     atomic.Value // Mode
	lastWarn atomic.Int64

	notes     chan note
	notesOnce sync.Once
	notesDone chan struct{}
}

var _ Verdicts = (*Engine)(nil)

// NewEngine prepares a guard. Nothing is spawned until [Engine.Start] or the first check.
func NewEngine(name string, opts Options) (*Engine, error) {
	if name == "" {
		name = "mcp-server"
	}
	wire, err := opts.engineOptions(name)
	if err != nil {
		return nil, err
	}
	logf := opts.Logger
	if logf == nil {
		// stderr, never stdout: on a stdio MCP server stdout is the protocol stream, and one
		// stray line there disconnects the client with a parse error that points nowhere.
		stderr := log.New(os.Stderr, "", log.LstdFlags)
		logf = stderr.Printf
	}
	e := &Engine{
		name:      name,
		opts:      opts,
		wireOpts:  wire,
		logf:      logf,
		pid:       os.Getpid(),
		notes:     make(chan note, 256),
		notesDone: make(chan struct{}),
	}
	e.mode.Store(opts.RequestedMode())
	return e, nil
}

// Name is the server name this guard reports under.
func (e *Engine) Name() string { return e.name }

// Mode is the mode the engine is actually in, which is the mode it reported at handshake and
// then whatever a dashboard project has since set. It is not necessarily the mode that was
// asked for: a project key hands the dashboard authority over this setting.
func (e *Engine) Mode() Mode {
	m, _ := e.mode.Load().(Mode)
	return m
}

// Start spawns the engine and waits for its handshake.
func (e *Engine) Start(ctx context.Context) error {
	_, err := e.ensureStarted(ctx)
	return err
}

func (e *Engine) ensureStarted(ctx context.Context) (*child, error) {
	e.mu.Lock()
	defer e.mu.Unlock()

	if e.closed {
		return nil, ErrClosed
	}
	if os.Getpid() != e.pid {
		return nil, &StartError{Detail: "this process forked after the engine started; " +
			"an inherited pipe cannot be shared, so start one guard per process"}
	}
	if e.cur != nil {
		select {
		case <-e.cur.exited:
			// fall through and restart
		default:
			return e.cur, nil
		}
		if since := time.Since(e.lastStart); since < e.opts.restartBackoff() {
			return nil, &RestartingError{RetryIn: e.opts.restartBackoff() - since}
		}
	}

	command, err := resolveEngineCommand(e.opts.EngineCommand)
	if err != nil {
		return nil, err
	}
	// Stamped before the attempt, so a spawn that itself fails also opens the damper window.
	e.lastStart = time.Now()

	c, err := e.spawn(ctx, command)
	if err != nil {
		return nil, err
	}
	e.cur = c
	return c, nil
}

func (e *Engine) spawn(ctx context.Context, command []string) (*child, error) {
	cmd := exec.Command(command[0], command[1:]...)
	// Options travel in the environment, never in argv: /proc/<pid>/cmdline is world-readable
	// and /proc/<pid>/environ is not, and these options can carry a project key.
	cmd.Env = append(os.Environ(), "MCPWATCH_ENGINE_OPTIONS="+string(e.wireOpts))
	cmd.Stderr = os.Stderr
	cmd.ExtraFiles = nil
	// Without WaitDelay, Wait blocks until stdout and stderr are closed, so an engine that
	// spawned a grandchild holding those pipes would hang shutdown for ever.
	cmd.WaitDelay = 5 * time.Second
	isolate(cmd)

	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, &SpawnError{Command: command[0], Err: err}
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, &SpawnError{Command: command[0], Err: err}
	}

	c := &child{
		cmd:    cmd,
		stdin:  stdin,
		pend:   map[uint64]chan *answer{},
		exited: make(chan struct{}),
	}
	// Registered before the process starts, so the handshake cannot arrive before anyone is
	// listening for it.
	ready := c.register(handshakeID)

	if err := cmd.Start(); err != nil {
		return nil, &SpawnError{Command: command[0], Err: err}
	}

	go e.read(c, stdout)
	go func() {
		err := cmd.Wait()
		code := int32(0)
		var exitErr *exec.ExitError
		if errors.As(err, &exitErr) {
			code = int32(exitErr.ExitCode())
		} else if err != nil {
			code = -1
		}
		c.code.Store(code)
		close(c.exited)
		if code != 0 {
			e.warn("the engine exited with code %d", code)
		}
	}()

	timeout := e.opts.startTimeout()
	if !usesNpx(command) && e.opts.StartTimeout == 0 {
		// The long default exists only for the npx path, whose first run downloads the
		// package. A command we resolved ourselves is already on disk.
		timeout = 20 * time.Second
	}
	timer := time.NewTimer(timeout)
	defer timer.Stop()

	select {
	case hello, ok := <-ready:
		if !ok || hello.Ready == nil || !*hello.Ready {
			killGroup(cmd)
			return nil, &StartError{Detail: "the engine answered, but not with a handshake"}
		}
		if m, valid := ParseMode(hello.Mode); valid {
			e.mode.Store(m)
		}
		e.startNotes()
		return c, nil
	case <-c.exited:
		// Giving up the moment the child dies matters: a bad option makes the engine print
		// the reason to stderr and exit 2, and waiting out the full start timeout would turn
		// a clear diagnosis into two minutes of silence.
		return nil, &StartError{Detail: fmt.Sprintf("it exited with code %d before the handshake", c.code.Load())}
	case <-timer.C:
		killGroup(cmd)
		return nil, &StartError{Detail: fmt.Sprintf("no handshake in %s", timeout)}
	case <-ctx.Done():
		killGroup(cmd)
		return nil, ctx.Err()
	}
}

// read is the one goroutine that consumes the engine's stdout.
func (e *Engine) read(c *child, stdout io.Reader) {
	defer c.failAll()
	r := bufio.NewReaderSize(stdout, 64<<10)
	garbage := 0
	for {
		line, err := readLine(r, e.opts.MaxMessageBytes)
		if err != nil {
			if errors.Is(err, errLineTooLong) {
				e.warn("the engine sent a message larger than the limit; skipping it")
				continue
			}
			return // EOF or a read error: the engine is gone
		}
		if len(bytes.TrimSpace(line)) == 0 {
			continue
		}
		var a answer
		if err := json.Unmarshal(line, &a); err != nil {
			// Node warnings, npm notices and a dependency's console.log all land here. They
			// are not protocol errors, but a stream that is nothing but noise is a broken
			// engine rather than a chatty one.
			garbage++
			if garbage > 20 {
				e.warn("the engine's output is not JSON; giving up on it")
				return
			}
			continue
		}
		garbage = 0
		if a.ID == nil {
			// {"id":null,"error":"request is not a JSON object"} - nobody can be waiting on
			// it, and it must never be matched to the handshake's id 0.
			if a.Error != "" {
				e.warn("the engine refused a line: %s", a.Error)
			}
			continue
		}
		if a.Mode != "" {
			if m, ok := ParseMode(a.Mode); ok {
				e.mode.Store(m)
			}
		}
		c.deliver(&a)
	}
}

// call sends one request and waits for the answer with that id.
func (e *Engine) call(ctx context.Context, op string, fields map[string]any) (*answer, error) {
	ctx, cancel := context.WithTimeout(ctx, e.opts.callTimeout())
	defer cancel()

	c, err := e.ensureStarted(ctx)
	if err != nil {
		return nil, err
	}

	id := e.ids.Add(1) // never 0
	line, err := encodeRequest(id, op, fields)
	if err != nil {
		return nil, err
	}

	ch := c.register(id)
	defer c.forget(id) // every exit path, so a timed-out call never leaks a map entry

	if err := c.writeLine(line); err != nil {
		return nil, err
	}

	select {
	case a, ok := <-ch:
		if !ok {
			return nil, &ExitedError{Code: int(c.code.Load())}
		}
		if a.isEngineRefusal() {
			return nil, &RefusedError{Message: a.Error}
		}
		return a, nil
	case <-c.exited:
		return nil, &ExitedError{Code: int(c.code.Load())}
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

func encodeRequest(id uint64, op string, fields map[string]any) ([]byte, error) {
	out := make(map[string]any, len(fields)+2)
	for k, v := range fields {
		out[k] = v
	}
	out["id"] = id
	out["op"] = op
	b, err := json.Marshal(out)
	if err != nil {
		return nil, fmt.Errorf("mcpwatch: cannot encode a %q request: %w", op, err)
	}
	return append(b, '\n'), nil
}

// failed turns an unreachable engine into an outcome.
//
// Fail-closed refuses requests only. A notification has no id and a response has no method;
// neither has anywhere to put a refusal, so both pass regardless of FailOpen. The message and
// the code match the engine's own, so a client cannot tell which side refused.
func (e *Engine) failed(msg json.RawMessage, cause error) Outcome {
	e.warn("guard error: %v", cause)
	if e.opts.IsFailOpen() || !IsRequest(msg) {
		return Pass(msg)
	}
	return Outcome{Reply: ErrorReply(IDOf(msg), CodeBlocked, "MCPWatch failed closed")}
}

// warn logs at most once a minute, so an engine that is down cannot itself become the
// incident by filling the host's logs.
func (e *Engine) warn(format string, args ...any) {
	now := time.Now().UnixNano()
	last := e.lastWarn.Load()
	if now-last < int64(time.Minute) && last != 0 {
		return
	}
	if !e.lastWarn.CompareAndSwap(last, now) {
		return
	}
	e.logf("[mcpwatch] "+format, args...)
}

// absent treats a JSON null as nothing.
//
// json.RawMessage is one of the few unmarshalers that IS invoked for a JSON null, and it
// stores the four-byte literal rather than leaving the field nil. The engine sends
// "reply":null on every message it allows, so a plain len(Reply) > 0 test is true for every
// single message - and the guard then writes the word "null" to the client as though it were
// a refusal, corrupting the protocol stream. Found by running the proxy end to end; every
// unit test against a stub passed, because a stub returns a real nil.
func absent(raw json.RawMessage) json.RawMessage {
	if len(raw) == 0 || bytes.Equal(bytes.TrimSpace(raw), nullLiteral) {
		return nil
	}
	return raw
}

func (e *Engine) outcome(a *answer, original json.RawMessage) Outcome {
	reply := absent(a.Reply)
	forward := absent(a.Forward)
	if forward == nil {
		return Outcome{Reply: reply}
	}
	a.Reply = reply
	a.Forward = forward
	if Equal(a.Forward, original) {
		// The caller's own bytes, not the engine's echo of them: Node cannot round-trip an
		// id above 2^53.
		return Outcome{Forward: original, Reply: reply}
	}
	// A genuine rewrite. Restore the original id: the engine changes content, never ids, and
	// an id that went through Node may have lost precision on the way.
	return Outcome{Forward: WithID(a.Forward, IDOf(original)), Reply: reply, Modified: true}
}

// FromClient checks a message on its way from the client to the server.
func (e *Engine) FromClient(ctx context.Context, session string, msg json.RawMessage, info *HTTPInfo) Outcome {
	fields := map[string]any{"session": session, "msg": msg}
	if info != nil {
		// Only when it is genuinely known: an empty object here would still switch on the
		// transport rules that key off its presence.
		fields["http"] = info
	}
	a, err := e.call(ctx, "client", fields)
	if err != nil {
		return e.failed(msg, err)
	}
	return e.outcome(a, msg)
}

// FromServer checks a message on its way from the server back to the client.
func (e *Engine) FromServer(ctx context.Context, session string, msg json.RawMessage, strict bool) Outcome {
	a, err := e.call(ctx, "server", map[string]any{"session": session, "msg": msg, "strict": strict})
	if err != nil {
		return e.failed(msg, err)
	}
	return e.outcome(a, msg)
}

// FromHTTP checks an HTTP request that carries no JSON-RPC message, and reports whether to
// refuse it.
func (e *Engine) FromHTTP(ctx context.Context, session string, info *HTTPInfo, method string) bool {
	if method == "" {
		method = "GET"
	}
	a, err := e.call(ctx, "http", map[string]any{"session": session, "http": info, "method": method})
	if err != nil {
		e.warn("guard error: %v", err)
		// The same rule as a message: without an answer, FailOpen decides.
		return !e.opts.IsFailOpen()
	}
	return a.Refuse != nil && *a.Refuse
}

// SetMode changes the mode at runtime. A dashboard project will override it again on its next
// poll, within about five seconds.
func (e *Engine) SetMode(ctx context.Context, m Mode) error {
	if _, ok := ParseMode(string(m)); !ok {
		return fmt.Errorf("mcpwatch: unknown mode %q", string(m))
	}
	a, err := e.call(ctx, "mode", map[string]any{"mode": string(m)})
	if err != nil {
		return err
	}
	if parsed, ok := ParseMode(a.Mode); ok {
		e.mode.Store(parsed)
	}
	return nil
}

// --- fire-and-forget bookkeeping ---

func (e *Engine) startNotes() {
	e.notesOnce.Do(func() {
		go func() {
			defer close(e.notesDone)
			for n := range e.notes {
				ctx, cancel := context.WithTimeout(context.Background(), e.opts.callTimeout())
				_, _ = e.call(ctx, n.op, n.fields)
				cancel()
			}
		}()
	})
}

// send queues a note. It never blocks: these are called from the SSE hot path and from
// deferred cleanup. A full queue means the engine is wedged, and dropping bookkeeping is
// better than stalling the server that is trying to serve a request.
func (e *Engine) send(op string, fields map[string]any) {
	select {
	case e.notes <- note{op: op, fields: fields}:
	default:
		e.warn("the engine is not keeping up; dropped a %q note", op)
	}
}

// RenameSession tells the engine a session acquired its real id, so the state built up under
// the provisional name is not stranded.
func (e *Engine) RenameSession(from, to string) {
	if from == "" || to == "" || from == to {
		return
	}
	e.send("rename", map[string]any{"from": from, "to": to})
}

// DropSession forgets a session.
func (e *Engine) DropSession(session string) {
	e.send("drop", map[string]any{"session": session})
}

// NoteEventID records an SSE event id as having been issued to this session.
//
// An adapter that sets HTTPInfo.RemoteAddress must call this for every id it relays: that
// field is what switches on MW037's resumption check, and without the ids to match against,
// every legitimate resumption looks like a foreign one.
func (e *Engine) NoteEventID(session, eventID string) {
	if eventID == "" {
		return
	}
	e.send("eventId", map[string]any{"session": session, "eventId": eventID})
}

// Shutdown stops the engine, giving it the chance to deliver what it has queued.
//
// Closing stdin is the clean shutdown, not a signal: the engine flushes its queued dashboard
// events and exits 0. Killing it instead loses the whole batch with no error anywhere - which
// is why a script that exits the instant its last call returns appears to report nothing.
func (e *Engine) Shutdown(ctx context.Context) error {
	e.mu.Lock()
	if e.closed {
		e.mu.Unlock()
		return nil
	}
	e.closed = true
	c := e.cur
	e.cur = nil
	e.mu.Unlock()

	// Let any queued rename/drop/eventId reach the engine before stdin closes.
	started := false
	e.notesOnce.Do(func() { started = true }) // if it never ran, claim it so nothing starts now
	if !started {
		close(e.notes)
		select {
		case <-e.notesDone:
		case <-ctx.Done():
		}
	}

	if c == nil {
		return nil
	}

	_ = c.stdin.Close()
	select {
	case <-c.exited:
		return nil
	case <-ctx.Done():
		killGroup(c.cmd)
		<-c.exited
		return ctx.Err()
	}
}

// Close shuts the engine down with the configured timeout. Engine is an io.Closer, so
// `defer engine.Close()` is the whole lifecycle.
func (e *Engine) Close() error {
	timeout := e.opts.ShutdownTimeout
	if timeout <= 0 {
		timeout = 5 * time.Second
	}
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	return e.Shutdown(ctx)
}
