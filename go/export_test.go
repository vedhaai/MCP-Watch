package mcpwatch

// Test-only hooks. This file is a _test.go, so none of it is part of the package's API or of
// anything a consumer builds - it exists so the external mcpwatch_test package can reach
// internals that no public method should expose.

// KillForTest kills the running engine the way a crash would, without going through
// Shutdown. There is no supported way to do this from outside, and simulating a crash is the
// only way to test that the guard recovers from one.
func (e *Engine) KillForTest() error {
	e.mu.Lock()
	c := e.cur
	e.mu.Unlock()
	if c == nil {
		return nil
	}
	killGroup(c.cmd)
	<-c.exited
	return nil
}
