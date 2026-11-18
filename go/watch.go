package mcpwatch

import "context"

// Watch is a started guard, or a guard that is deliberately switched off.
//
// When it is off - Options.Enabled is false, or MCPWATCH_ENABLED=0 - nothing is spawned and
// [Watch.Verdicts] returns a pass-through. No adapter needs a nil check, and the disabled
// path runs the same code as the enabled one rather than a second, untested branch.
type Watch struct {
	engine *Engine
}

// Start brings up a guard, and never fails outwards.
//
// A guard that cannot start logs why and leaves FailOpen to decide what happens to messages
// until it comes up. Use [TryStart] for a deployment that would rather not boot at all than
// run unguarded.
func Start(ctx context.Context, name string, opts Options) *Watch {
	w, err := TryStart(ctx, name, opts)
	if err != nil {
		if w == nil {
			w = &Watch{}
		}
		return w
	}
	return w
}

// TryStart brings up a guard and reports why it could not reach the engine.
//
// A disabled guard is not an error: it returns a Watch that passes everything through.
func TryStart(ctx context.Context, name string, opts Options) (*Watch, error) {
	if !opts.IsEnabled() {
		return &Watch{}, nil
	}
	e, err := NewEngine(name, opts)
	if err != nil {
		return &Watch{}, err
	}
	if err := e.Start(ctx); err != nil {
		// The engine keeps its restart damper, so a guard handed back here will come up on
		// its own if the engine was merely slow to appear.
		return &Watch{engine: e}, err
	}
	return &Watch{engine: e}, nil
}

// FromEngine wraps an engine that is already running, so several transports can share one.
func FromEngine(e *Engine) *Watch { return &Watch{engine: e} }

// On reports whether MCPWatch is actually guarding.
func (w *Watch) On() bool { return w != nil && w.engine != nil }

// Engine returns the underlying engine, or nil when the guard is off.
func (w *Watch) Engine() *Engine {
	if w == nil {
		return nil
	}
	return w.engine
}

// Verdicts is what the adapters are written against. It never returns nil.
func (w *Watch) Verdicts() Verdicts {
	if !w.On() {
		return Passthrough()
	}
	return w.engine
}

// Shutdown stops the engine, giving it the chance to deliver what it has queued.
func (w *Watch) Shutdown(ctx context.Context) error {
	if !w.On() {
		return nil
	}
	return w.engine.Shutdown(ctx)
}

// Close stops the engine with the configured timeout, so `defer watch.Close()` is the whole
// lifecycle.
//
// It matters that this is called. Closing the engine's stdin is what makes it flush the
// events it has queued for the dashboard; a program that simply returns from main exits
// before that happens and loses the batch, with nothing reported anywhere to say so.
func (w *Watch) Close() error {
	if !w.On() {
		return nil
	}
	return w.engine.Close()
}
