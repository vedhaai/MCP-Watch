//go:build linux

package mcpwatch

import (
	"os/exec"
	"syscall"
)

// isolate puts the engine in its own process group and asks the kernel to kill it if we die
// first.
//
// Pdeathsig removes the whole orphaned-engine class: a host that calls os.Exit without
// closing the guard would otherwise leave a Node process running until the machine reboots.
// It is a Linux-only field - which is exactly what check.sh's darwin cross-build is for.
func isolate(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{
		Setpgid:   true,
		Pdeathsig: syscall.SIGKILL,
	}
}
