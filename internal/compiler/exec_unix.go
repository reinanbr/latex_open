//go:build unix

package compiler

import (
	"bytes"
	"context"
	"os/exec"
	"syscall"
	"time"
)

// ExecRunner runs the command in its own process group. On cancellation or
// timeout the whole group (latexmk, pdflatex, bibtex, …) is killed, and any
// stray child left behind after a normal exit is reaped as well.
func ExecRunner(ctx context.Context, dir string, args, env []string) ([]byte, error) {
	cmd := exec.CommandContext(ctx, args[0], args[1:]...)
	cmd.Dir = dir
	cmd.Env = env
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.Cancel = func() error {
		return syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
	}
	cmd.WaitDelay = 3 * time.Second
	var buf capBuffer
	buf.max = 1 << 20
	cmd.Stdout = &buf
	cmd.Stderr = &buf
	err := cmd.Run()
	if cmd.Process != nil {
		_ = syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
	}
	return buf.Bytes(), err
}

// capBuffer keeps the last max bytes written.
type capBuffer struct {
	bytes.Buffer
	max int
}

func (c *capBuffer) Write(p []byte) (int, error) {
	n, err := c.Buffer.Write(p)
	if over := c.Buffer.Len() - c.max; over > 0 {
		c.Buffer.Next(over)
	}
	return n, err
}
