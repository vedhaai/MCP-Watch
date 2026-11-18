//go:build windows

package mcpwatch

import "os/exec"

// isolate is a no-op on Windows for now. The equivalent of a process group is a Job Object
// with JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE; until that is added, cmd.WaitDelay plus an
// explicit Kill is what bounds a stuck engine.
func isolate(cmd *exec.Cmd) {}

func killGroup(cmd *exec.Cmd) {
	if cmd.Process != nil {
		_ = cmd.Process.Kill()
	}
}
