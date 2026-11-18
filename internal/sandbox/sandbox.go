// Package sandbox confines the external tools texdesk runs on untrusted
// projects (latexmk and the TeX engines, bibtex/biber, pandoc, Ghostscript,
// pdftoppm, texcount) with Landlock, the unprivileged Linux filesystem
// sandbox (kernel ≥ 5.13).
//
// A sandboxed command only sees the system and TeX installation (read-only),
// the project's own files (read-only) and its build directory (read-write).
// The user's home directory, other projects and everything else on disk are
// invisible, so a malicious document cannot pull e.g. ~/.ssh/id_rsa into its
// PDF (LuaLaTeX has to run with openin_any=r, which TeX alone cannot
// restrict).
//
// Mechanism: Wrap rewrites a command line so that texdesk re-executes itself
// as a small helper (HelperArg) that installs the Landlock rules on itself and
// then execs the real program; the rules are inherited by every descendant.
// Where Landlock is unavailable, Wrap returns the command unchanged and Init
// reports why, so texdesk degrades to TeX's own restrictions.
package sandbox

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// HelperArg is the hidden first argument that turns the texdesk binary into
// the sandbox helper: texdesk __sandbox-exec [--ro P]... [--rw P]... -- PROG ARGS...
const HelperArg = "__sandbox-exec"

// Policy lists extra paths for one command, on top of the base system paths.
type Policy struct {
	RO []string
	RW []string
}

var (
	mu      sync.RWMutex
	enabled bool
	self    string
	base    Policy
)

// Enabled reports whether commands are being sandboxed.
func Enabled() bool {
	mu.RLock()
	defer mu.RUnlock()
	return enabled
}

// IsHelper reports whether args (os.Args) request the helper mode.
func IsHelper(args []string) bool { return len(args) > 1 && args[1] == HelperArg }

// Init probes Landlock, computes the base read-only/read-write paths and
// verifies the helper end to end. extraRO adds directories that must stay
// readable (e.g. where the TeX binaries live). It returns a human-readable
// status; on failure sandboxing stays off.
func Init(extraRO []string) (bool, string) {
	abi, err := landlockABI()
	if err != nil {
		return false, "Landlock indisponível (" + err.Error() + "); os comandos rodam só com as restrições do próprio TeX"
	}
	exe, err := os.Executable()
	if err != nil {
		return false, "não foi possível localizar o executável: " + err.Error()
	}
	b := systemPolicy()
	home, _ := os.UserHomeDir()
	b.RO = append(b.RO, dropBroad(extraRO, home)...)

	mu.Lock()
	self, base, enabled = exe, b, true
	mu.Unlock()

	// End-to-end self test: the helper must be able to run a program, and
	// the program must not see a directory outside the policy.
	if err := selfTest(); err != nil {
		mu.Lock()
		enabled = false
		mu.Unlock()
		return false, "sandbox Landlock desativado: o autoteste falhou (" + err.Error() + ")"
	}
	return true, fmt.Sprintf("sandbox Landlock ativo (ABI v%d)", abi)
}

// Disable turns sandboxing off (e.g. --no-sandbox).
func Disable() {
	mu.Lock()
	enabled = false
	mu.Unlock()
}

// Wrap returns argv rewritten to run under the sandbox with the base policy
// plus p. argv[0] is resolved through PATH first. Without sandboxing, argv is
// returned unchanged.
func Wrap(argv []string, p Policy) []string {
	mu.RLock()
	on, exe, b := enabled, self, base
	mu.RUnlock()
	if !on || len(argv) == 0 {
		return argv
	}
	prog, err := exec.LookPath(argv[0])
	if err != nil {
		return argv // let the caller report "not found" as usual
	}
	if abs, err := filepath.Abs(prog); err == nil {
		prog = abs
	}
	out := []string{exe, HelperArg}
	for _, d := range append(append([]string{}, b.RO...), p.RO...) {
		out = append(out, "--ro", d)
	}
	for _, d := range append(append([]string{}, b.RW...), p.RW...) {
		out = append(out, "--rw", d)
	}
	out = append(out, "--", prog)
	return append(out, argv[1:]...)
}

// systemPolicy: what TeX, Perl (latexmk, biber), pandoc and Ghostscript need.
func systemPolicy() Policy {
	p := Policy{
		RO: []string{
			"/usr", "/etc", "/lib", "/lib32", "/lib64", "/libx32", "/bin", "/sbin", "/opt",
			"/var/lib/texmf", "/var/cache/fontconfig", "/var/cache/fonts",
			"/dev/urandom", "/dev/random", "/dev/zero",
		},
		RW: []string{"/dev/null"},
	}
	home, _ := os.UserHomeDir()
	if home != "" {
		// User fonts (XeLaTeX/LuaLaTeX with fontspec) are not secrets.
		p.RO = append(p.RO, filepath.Join(home, ".fonts"), filepath.Join(home, ".local/share/fonts"))
		p.RW = append(p.RW, filepath.Join(home, ".cache/fontconfig"))
	}
	// TeX installation and per-user trees (TEXMFHOME has personal packages;
	// TEXMFVAR must be writable for luaotfload's and mktexpk's caches).
	for _, v := range []string{"SELFAUTOPARENT", "TEXMFDIST", "TEXMFLOCAL", "TEXMFSYSVAR", "TEXMFSYSCONFIG", "TEXMFHOME", "TEXMFCONFIG"} {
		p.RO = append(p.RO, kpseVar(v)...)
	}
	for _, d := range kpseVar("TEXMFVAR") {
		_ = os.MkdirAll(d, 0o755)
		p.RW = append(p.RW, d)
	}
	p.RO = dropBroad(p.RO, home)
	p.RW = dropBroad(p.RW, home)
	return p
}

// dropBroad removes "/" and any ancestor of the home directory: kpathsea's
// SELFAUTOPARENT is "/" when TeX lives in /usr/bin, and whitelisting it
// would expose everything.
func dropBroad(dirs []string, home string) []string {
	out := dirs[:0]
	for _, d := range dirs {
		d = filepath.Clean(d)
		if d == "/" || (home != "" && (d == home || strings.HasPrefix(home+"/", d+"/"))) {
			continue
		}
		out = append(out, d)
	}
	return out
}

// kpseVar expands a kpathsea variable into plain directories.
func kpseVar(name string) []string {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, "kpsewhich", "-var-value", name).Output()
	if err != nil {
		return nil
	}
	var dirs []string
	for _, d := range strings.FieldsFunc(strings.TrimSpace(string(out)), func(r rune) bool { return r == ':' || r == ';' }) {
		d = strings.TrimPrefix(d, "!!")
		if d == "" || strings.ContainsAny(d, "{}$") || !filepath.IsAbs(d) {
			continue
		}
		dirs = append(dirs, filepath.Clean(d))
	}
	return dirs
}

func selfTest() error {
	hidden, err := os.MkdirTemp("", "texdesk-sbx-*")
	if err != nil {
		return err
	}
	defer os.RemoveAll(hidden)
	secret := filepath.Join(hidden, "secret")
	if err := os.WriteFile(secret, []byte("x"), 0o600); err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	run := func(argv []string) ([]byte, error) {
		w := Wrap(argv, Policy{})
		return exec.CommandContext(ctx, w[0], w[1:]...).CombinedOutput()
	}
	// "cat" must run (system paths readable) …
	if out, err := run([]string{"cat", "/etc/hostname"}); err != nil {
		return fmt.Errorf("o helper não executou um comando: %v %s", err, strings.TrimSpace(string(out)))
	}
	// … but must not read a file outside the policy.
	if _, err := run([]string{"cat", secret}); err == nil {
		return fmt.Errorf("um arquivo fora da política continuou legível")
	}
	return nil
}
