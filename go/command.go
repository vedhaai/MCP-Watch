package mcpwatch

import (
	"os"
	"os/exec"
	"strings"
)

// engineSubcommand is the only argument ever placed on the engine's command line. Every
// setting travels in the MCPWATCH_ENGINE_OPTIONS environment variable instead, which also
// keeps a project key out of process listings: /proc/<pid>/cmdline is world-readable,
// /proc/<pid>/environ is not.
const engineSubcommand = "engine"

// resolveEngineCommand works out how to start the engine, in the same order as the Python,
// Java, Rust and .NET adapters:
//
//  1. the command given in Options.EngineCommand
//  2. the MCPWATCH_ENGINE environment variable
//  3. an `mcpwatch` executable on PATH
//  4. `npx -y @vedhaai/mcpwatch`
//
// On Windows `npm install -g` installs mcpwatch.cmd rather than a bare executable. Go's
// exec.LookPath consults PATHEXT, so it finds the .cmd, .exe or .bat without the hand-rolled
// probe the Java and .NET adapters need. That path is still never exercised on Linux, which
// is why check.sh cross-builds for windows.
func resolveEngineCommand(configured []string) ([]string, error) {
	if len(configured) > 0 {
		return append(append([]string{}, configured...), engineSubcommand), nil
	}
	if env := strings.TrimSpace(os.Getenv("MCPWATCH_ENGINE")); env != "" {
		parts := splitCommand(env)
		if len(parts) > 0 {
			return append(parts, engineSubcommand), nil
		}
	}
	if found, err := exec.LookPath("mcpwatch"); err == nil {
		return []string{found, engineSubcommand}, nil
	}
	if npx, err := exec.LookPath("npx"); err == nil {
		// Pinned to the major line this adapter speaks: the sidecar protocol is a contract,
		// and `latest` would let a future engine change it under a released module that can
		// never be edited.
		return []string{npx, "-y", EngineNpmSpec, engineSubcommand}, nil
	}
	return nil, ErrNotInstalled
}

// usesNpx reports whether the resolved command will go through npx, whose first run
// downloads the package. That is the only reason the start timeout is measured in minutes.
func usesNpx(command []string) bool {
	if len(command) == 0 {
		return false
	}
	base := strings.ToLower(command[0])
	if i := strings.LastIndexAny(base, `/\`); i >= 0 {
		base = base[i+1:]
	}
	return base == "npx" || strings.HasPrefix(base, "npx.")
}

// splitCommand splits a command string on whitespace, honouring single and double quotes.
//
// Backslashes are never treated as escapes, so a Windows path survives:
// `"C:\Program Files\nodejs\node.exe"` splits into one argument with its backslashes intact.
// A shell-style unescaper would turn \P and \n into something else entirely.
func splitCommand(s string) []string {
	var parts []string
	var current strings.Builder
	var quote rune
	started := false

	flush := func() {
		if started || current.Len() > 0 {
			parts = append(parts, current.String())
			current.Reset()
			started = false
		}
	}

	for _, r := range s {
		switch {
		case quote != 0:
			if r == quote {
				quote = 0
			} else {
				current.WriteRune(r)
			}
		case r == '"' || r == '\'':
			quote = r
			started = true // so an empty "" survives as an argument
		case r == ' ' || r == '\t' || r == '\n' || r == '\r':
			flush()
		default:
			current.WriteRune(r)
		}
	}
	flush()
	return parts
}
