// Package testutil locates this checkout's engine for the tests.
package testutil

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

// EngineCLI is the path to this checkout's built engine.
//
// Always this checkout, never npx: no test may reach the network or report into a developer's
// real dashboard.
func EngineCLI() string {
	if p := os.Getenv("MCPWATCH_ENGINE_CLI"); p != "" {
		return p
	}
	_, file, _, _ := runtime.Caller(0) // go/internal/testutil/engine.go
	return filepath.Clean(filepath.Join(filepath.Dir(file), "..", "..", "..", "engine", "dist", "cli.js"))
}

// RequireEngine skips the test unless the engine is built.
//
// Go has a real skip, unlike cargo, so skipping is the default here. CI opts into strictness
// with MCPWATCH_REQUIRE_ENGINE=1, because a suite that quietly passes without checking
// anything is worse than one that fails.
func RequireEngine(t *testing.T) string {
	t.Helper()
	cli := EngineCLI()
	if _, err := os.Stat(cli); err != nil {
		if os.Getenv("MCPWATCH_REQUIRE_ENGINE") == "1" {
			t.Fatalf("engine/dist/cli.js is missing: run `npm ci && npm run build -w engine` at the repo root")
		}
		t.Skipf("engine not built at %s; run `npm run build -w engine` (skipping)", cli)
	}
	if testing.Short() {
		t.Skip("-short: skipping a real-engine test")
	}
	return cli
}

// ScrubEnv removes every MCPWATCH_* setting a developer's shell might be carrying, so a test
// cannot accidentally pick up a real project key or a different mode.
//
// t.Setenv is used rather than os.Unsetenv so the values are restored; it also means a test
// calling this must not call t.Parallel.
func ScrubEnv(t *testing.T) {
	t.Helper()
	for _, k := range []string{
		"MCPWATCH_PROJECT_KEY", "MCPWATCH_PROJECT_KEY_FILE", "MCPWATCH_AI",
		"MCPWATCH_MODE", "MCPWATCH_ENABLED", "MCPWATCH_ENGINE", "MCPWATCH_SERVER",
		"MCPWATCH_CONFIG", "MCPWATCH_EVENTS", "MCPWATCH_PINS",
	} {
		t.Setenv(k, "")
		os.Unsetenv(k)
	}
}
