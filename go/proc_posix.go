//go:build unix

package mcpwatch

import (
	"os/exec"
	"syscall"
)

// killGroup kills the engine and anything it started.
//
// The engine is given its own process group at spawn, so a grandchild it left behind - an
// npx shim, a shell wrapper - goes with it rather than outliving the server.
func killGroup(cmd *exec.Cmd) {
	if cmd.Process == nil {
		return
	}
	if pgid, err := syscall.Getpgid(cmd.Process.Pid); err == nil && pgid == cmd.Process.Pid {
		_ = syscall.Kill(-pgid, syscall.SIGKILL)
		return
	}
	_ = cmd.Process.Kill()
}
