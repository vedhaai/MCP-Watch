//go:build unix && !linux

package mcpwatch

import (
	"os/exec"
	"syscall"
)

// isolate puts the engine in its own process group.
//
// There is no Pdeathsig outside Linux, so an engine orphaned by a host that exits without
// closing the guard is reaped by cmd.WaitDelay and the process-group kill instead.
func isolate(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
}
