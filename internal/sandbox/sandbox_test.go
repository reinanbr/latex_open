package sandbox

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestMain(m *testing.M) {
	if IsHelper(os.Args) {
		HelperMain(os.Args)
	}
	os.Exit(m.Run())
}

func run(t *testing.T, p Policy, argv ...string) (string, error) {
	t.Helper()
	w := Wrap(argv, p)
	out, err := exec.Command(w[0], w[1:]...).CombinedOutput()
	return string(out), err
}

func TestLandlock(t *testing.T) {
	ok, status := Init(nil)
	t.Log(status)
	if !ok {
		t.Skip(status)
	}
	defer Disable()
	ro, rw, hidden := t.TempDir(), t.TempDir(), t.TempDir()
	for _, d := range []string{ro, hidden} {
		os.WriteFile(filepath.Join(d, "f.txt"), []byte("conteudo"), 0o644)
	}
	p := Policy{RO: []string{ro}, RW: []string{rw}}

	if out, err := run(t, p, "cat", filepath.Join(ro, "f.txt")); err != nil || out != "conteudo" {
		t.Errorf("read-only dir should be readable: %q %v", out, err)
	}
	if _, err := run(t, p, "cat", filepath.Join(hidden, "f.txt")); err == nil {
		t.Error("a directory outside the policy was readable")
	}
	if _, err := run(t, p, "ls", hidden); err == nil {
		t.Error("a directory outside the policy was listable")
	}
	if _, err := run(t, p, "touch", filepath.Join(ro, "new")); err == nil {
		t.Error("read-only dir was writable")
	}
	if out, err := run(t, p, "sh", "-c", "echo x > "+filepath.Join(rw, "new")+" && mkdir "+filepath.Join(rw, "d")+" && cat "+filepath.Join(rw, "new")); err != nil || strings.TrimSpace(out) != "x" {
		t.Errorf("read-write dir: %q %v", out, err)
	}
	// Descendants inherit the restrictions.
	if _, err := run(t, p, "sh", "-c", "cat "+filepath.Join(hidden, "f.txt")); err == nil {
		t.Error("child process escaped the sandbox")
	}
	home, _ := os.UserHomeDir()
	if home != "" {
		if _, err := run(t, p, "ls", home); err == nil {
			t.Error("home directory is visible")
		}
	}
}

func TestWrapDisabled(t *testing.T) {
	Disable()
	argv := []string{"latexmk", "-pdf"}
	if got := Wrap(argv, Policy{}); strings.Join(got, " ") != "latexmk -pdf" {
		t.Errorf("Wrap without sandbox = %v", got)
	}
}
