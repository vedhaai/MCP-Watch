package mcpwatch

import (
	"errors"
	"fmt"
	"time"
)

// ErrEngineUnavailable is the root of every "the engine is not there" failure. Use
// errors.Is to test for it.
//
// It only ever reaches calling code from [Start] and [Engine.Start]. The check methods never
// return it: a check that cannot reach the engine resolves through FailOpen into an ordinary
// [Outcome], because a guard that returns errors into the middle of someone's request
// handler is a guard they will take out again.
var ErrEngineUnavailable = errors.New("mcpwatch: engine unavailable")

// ErrNotInstalled means no way to start the engine could be found.
var ErrNotInstalled = fmt.Errorf("%w: Node.js 20+ is needed: install it, then `npm install -g %s`", ErrEngineUnavailable, NPMPackage)

// ErrClosed means the guard was closed.
var ErrClosed = fmt.Errorf("%w: the guard is closed", ErrEngineUnavailable)

// SpawnError is returned when the engine process could not be started or written to.
type SpawnError struct {
	Command string
	Err     error
}

func (e *SpawnError) Error() string {
	return fmt.Sprintf("mcpwatch: could not start %q: %v", e.Command, e.Err)
}
func (e *SpawnError) Unwrap() error { return e.Err }
func (e *SpawnError) Is(target error) bool {
	return target == ErrEngineUnavailable
}

// StartError means the engine started but never completed its handshake.
type StartError struct {
	Detail string
}

func (e *StartError) Error() string {
	return "mcpwatch: the engine did not start: " + e.Detail
}
func (e *StartError) Is(target error) bool { return target == ErrEngineUnavailable }

// ExitedError means the engine process ended while calls were waiting on it.
type ExitedError struct {
	Code int // -1 when the exit code is not known
}

func (e *ExitedError) Error() string {
	if e.Code < 0 {
		return "mcpwatch: the engine exited"
	}
	return fmt.Sprintf("mcpwatch: the engine exited with code %d", e.Code)
}
func (e *ExitedError) Is(target error) bool { return target == ErrEngineUnavailable }

// RestartingError means the engine died and the restart damper has not elapsed. It exists so
// a crash-looping engine is not respawned once per message.
type RestartingError struct {
	RetryIn time.Duration
}

func (e *RestartingError) Error() string {
	return fmt.Sprintf("mcpwatch: the engine is restarting, retry in %s", e.RetryIn)
}
func (e *RestartingError) Is(target error) bool { return target == ErrEngineUnavailable }

// RefusedError means the engine answered the request with an error of its own: a malformed
// op, a session that was not a string, a message that was not a JSON object.
type RefusedError struct {
	Message string
}

func (e *RefusedError) Error() string {
	return "mcpwatch: the engine refused the request: " + e.Message
}
func (e *RefusedError) Is(target error) bool { return target == ErrEngineUnavailable }
