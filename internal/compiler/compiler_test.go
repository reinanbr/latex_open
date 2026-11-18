package compiler

import (
	"context"
	"io"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"testing"
	"time"
)

func quietLog() *slog.Logger { return slog.New(slog.NewTextHandler(io.Discard, nil)) }

func newProject(t *testing.T) Request {
	t.Helper()
	root := t.TempDir()
	src := filepath.Join(root, "src")
	os.MkdirAll(filepath.Join(src, "chapters", "deep"), 0o755)
	os.WriteFile(filepath.Join(src, "main.tex"), []byte(`\documentclass{article}`), 0o644)
	return Request{ProjectID: "P", SrcDir: src, BuildDir: filepath.Join(root, "build"), MainFile: "main.tex"}
}

// fakeRunner writes a PDF and log into the build dir after an optional
// blocking period, honoring cancellation.
type fakeRunner struct {
	block   chan struct{} // if non-nil, wait for it (or ctx)
	running atomic.Int32
	maxSeen atomic.Int32
	calls   atomic.Int32
	fail    bool
}

func (f *fakeRunner) run(ctx context.Context, dir string, args, env []string) ([]byte, error) {
	f.calls.Add(1)
	n := f.running.Add(1)
	defer f.running.Add(-1)
	for {
		m := f.maxSeen.Load()
		if n <= m || f.maxSeen.CompareAndSwap(m, n) {
			break
		}
	}
	if f.block != nil {
		select {
		case <-f.block:
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}
	var outdir string
	for _, a := range args {
		if strings.HasPrefix(a, "-outdir=") {
			outdir = strings.TrimPrefix(a, "-outdir=")
		}
	}
	os.WriteFile(filepath.Join(outdir, "main.log"), []byte("./main.tex:3: Undefined control sequence.\nl.3 \\foo\n\n"), 0o644)
	if f.fail {
		return []byte("Latexmk: Errors"), &exec.ExitError{}
	}
	os.WriteFile(filepath.Join(outdir, "main.pdf"), []byte("%PDF-1.5 fake"), 0o644)
	return []byte("ok"), nil
}

func TestBuildArgs(t *testing.T) {
	args := strings.Join(BuildArgs(Request{BuildDir: "/b", MainFile: "sub/thesis.tex", Options: Options{Compiler: "xelatex", Draft: true, StopOnFirstError: true}}), " ")
	for _, want := range []string{"latexmk", "-norc", "-g", "-pdfxe", "-no-shell-escape", "-synctex=1", "-file-line-error", "-outdir=/b", "-halt-on-error", `-usepretex=\PassOptionsToPackage{draft}{graphicx}`, "sub/thesis.tex"} {
		if !strings.Contains(args, want) {
			t.Errorf("args missing %q: %s", want, args)
		}
	}
	if strings.Contains(args, " -f ") || strings.Contains(args, "shell-escape ") && !strings.Contains(args, "-no-shell-escape") {
		t.Errorf("unexpected args: %s", args)
	}
	args = strings.Join(BuildArgs(Request{BuildDir: "/b", MainFile: "m.tex", Options: Options{Compiler: "pdflatex"}}), " ")
	if !strings.Contains(args, " -f ") || strings.Contains(args, "halt-on-error") || strings.Contains(args, "pretex") {
		t.Errorf("default args: %s", args)
	}
}

func TestBuildArgsLatexDVI(t *testing.T) {
	args := BuildArgs(Request{BuildDir: "/b", MainFile: "m.tex", Options: Options{Compiler: "latex"}})
	joined := strings.Join(args, " ")
	if !strings.Contains(joined, "-pdfps") || !strings.Contains(joined, "-norc") {
		t.Errorf("args: %s", joined)
	}
	found := false
	for i, a := range args {
		if a == "-e" && i+1 < len(args) && strings.Contains(args[i+1], `"dvips -R2 `) && strings.Contains(args[i+1], `$dvips_pdf_switch = ""`) {
			found = true
		}
	}
	if !found {
		t.Errorf("dvips secure mode / 600 dpi not forced: %s", joined)
	}
	if strings.Contains(strings.Join(BuildArgs(Request{BuildDir: "/b", MainFile: "m.tex", Options: Options{Compiler: "pdflatex"}}), " "), "dvips") {
		t.Error("dvips config leaked into pdflatex args")
	}
}

func TestCleanBuildDir(t *testing.T) {
	b := t.TempDir()
	for _, f := range []string{"main.aux", "chap/c.aux", outDirName + "/01ARZ3NDEKTSV4RRFFQ69G5FAV/output.pdf"} {
		p := filepath.Join(b, filepath.FromSlash(f))
		os.MkdirAll(filepath.Dir(p), 0o755)
		os.WriteFile(p, []byte("x"), 0o644)
	}
	if err := cleanBuildDir(b); err != nil {
		t.Fatal(err)
	}
	entries, _ := os.ReadDir(b)
	if len(entries) != 1 || entries[0].Name() != outDirName {
		t.Errorf("left: %v", entries)
	}
	if err := cleanBuildDir(filepath.Join(b, "missing")); err != nil {
		t.Errorf("missing dir: %v", err)
	}
}

func TestCompileSuccessAndSnapshot(t *testing.T) {
	req := newProject(t)
	fr := &fakeRunner{}
	m := NewManager(10*time.Second, quietLog())
	m.Run = fr.run
	m.Keep = 2
	var hook atomic.Int32
	m.OnSuccess = func(Request, *Result) { hook.Add(1) }

	var ids []string
	for i := 0; i < 3; i++ {
		res, err := m.Compile(context.Background(), req)
		if err != nil {
			t.Fatal(err)
		}
		if res.Status != StatusSuccess || !res.PDFAvailable || res.BuildID == "" {
			t.Fatalf("unexpected result %+v", res)
		}
		if len(res.Problems) != 1 || res.Problems[0].Line != 3 {
			t.Errorf("problems: %+v", res.Problems)
		}
		ids = append(ids, res.BuildID)
	}
	if hook.Load() != 3 {
		t.Errorf("OnSuccess called %d times", hook.Load())
	}
	// build/ mirrors src/ folders.
	if _, err := os.Stat(filepath.Join(req.BuildDir, "chapters", "deep")); err != nil {
		t.Errorf("build dir not mirrored: %v", err)
	}
	// Only the last 2 snapshots are kept.
	if _, ok := OutputPath(req.BuildDir, ids[0], "output.pdf"); ok {
		t.Error("oldest snapshot should be pruned")
	}
	if p, ok := OutputPath(req.BuildDir, ids[2], "output.pdf"); !ok {
		t.Error("latest snapshot missing")
	} else if b, _ := os.ReadFile(p); !strings.HasPrefix(string(b), "%PDF") {
		t.Error("snapshot content wrong")
	}
	if _, ok := OutputPath(req.BuildDir, "../../etc", "output.pdf"); ok {
		t.Error("invalid build id accepted")
	}
	if l := Latest(req.BuildDir, true); l == nil || l.BuildID != ids[2] || l.Log != "" {
		t.Errorf("Latest = %+v", l)
	}
	// The src/ tree is never touched by the build.
	entries, _ := os.ReadDir(req.SrcDir)
	if len(entries) != 2 {
		t.Errorf("src/ polluted: %v", entries)
	}
}

func TestCompileFailureKeepsNoStalePDF(t *testing.T) {
	req := newProject(t)
	m := NewManager(10*time.Second, quietLog())
	ok := &fakeRunner{}
	m.Run = ok.run
	if res, _ := m.Compile(context.Background(), req); res.Status != StatusSuccess {
		t.Fatal("first build should succeed")
	}
	bad := &fakeRunner{fail: true}
	m.Run = bad.run
	res, err := m.Compile(context.Background(), req)
	if err != nil {
		t.Fatal(err)
	}
	if res.Status != StatusError || res.PDFAvailable {
		t.Errorf("stale PDF reported: %+v", res)
	}
	if res.Problems[0].Level != "error" {
		t.Errorf("problems: %+v", res.Problems)
	}
}

func TestNewRequestCancelsRunning(t *testing.T) {
	req := newProject(t)
	fr := &fakeRunner{block: make(chan struct{})}
	m := NewManager(10*time.Second, quietLog())
	m.Run = fr.run

	first := make(chan *Result, 1)
	go func() {
		r, _ := m.Compile(context.Background(), req)
		first <- r
	}()
	waitFor(t, func() bool { return fr.running.Load() == 1 })

	// Second request: unblock the runner so it can complete.
	second := make(chan *Result, 1)
	go func() {
		r, _ := m.Compile(context.Background(), req)
		second <- r
	}()
	r1 := <-first
	if r1.Status != StatusCanceled {
		t.Fatalf("first build status = %s, want canceled", r1.Status)
	}
	close(fr.block)
	r2 := <-second
	if r2.Status != StatusSuccess {
		t.Fatalf("second build status = %s", r2.Status)
	}
	if fr.maxSeen.Load() != 1 {
		t.Errorf("builds overlapped: max concurrent = %d", fr.maxSeen.Load())
	}
	if m.Running("P") {
		t.Error("job not cleaned up")
	}
}

func TestBurstOfRequestsOnlyLastRuns(t *testing.T) {
	req := newProject(t)
	fr := &fakeRunner{block: make(chan struct{})}
	m := NewManager(10*time.Second, quietLog())
	m.Run = fr.run
	var wg sync.WaitGroup
	results := make([]*Result, 5)
	for i := 0; i < 5; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			results[i], _ = m.Compile(context.Background(), req)
		}(i)
		time.Sleep(20 * time.Millisecond)
	}
	time.Sleep(50 * time.Millisecond)
	close(fr.block)
	wg.Wait()
	ok := 0
	for _, r := range results {
		if r.Status == StatusSuccess {
			ok++
		}
	}
	if ok != 1 || results[4].Status != StatusSuccess {
		t.Errorf("want only the last build to succeed; statuses: %v", statuses(results))
	}
	if fr.maxSeen.Load() != 1 {
		t.Errorf("builds overlapped")
	}
}

func TestCancelAndClientDisconnect(t *testing.T) {
	req := newProject(t)
	fr := &fakeRunner{block: make(chan struct{})}
	m := NewManager(10*time.Second, quietLog())
	m.Run = fr.run
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan *Result, 1)
	go func() {
		r, _ := m.Compile(ctx, req)
		done <- r
	}()
	waitFor(t, func() bool { return fr.running.Load() == 1 })
	cancel()
	if r := <-done; r.Status != StatusCanceled {
		t.Errorf("status = %s", r.Status)
	}
}

func TestTimeout(t *testing.T) {
	req := newProject(t)
	fr := &fakeRunner{block: make(chan struct{})}
	m := NewManager(100*time.Millisecond, quietLog())
	m.Run = fr.run
	res, err := m.Compile(context.Background(), req)
	if err != nil {
		t.Fatal(err)
	}
	if res.Status != StatusTimeout || !strings.Contains(res.Problems[0].Message, "tempo limite") {
		t.Errorf("result %+v", res)
	}
}

func TestMissingMain(t *testing.T) {
	req := newProject(t)
	m := NewManager(time.Second, quietLog())
	m.Run = (&fakeRunner{}).run
	req.MainFile = ""
	if _, err := m.Compile(context.Background(), req); err != ErrNoMainFile {
		t.Errorf("err = %v", err)
	}
	req.MainFile = "nope.tex"
	if _, err := m.Compile(context.Background(), req); err == nil {
		t.Error("expected error for missing main file")
	}
}

// ExecRunner must kill the whole process group, including grandchildren.
func TestExecRunnerKillsProcessGroup(t *testing.T) {
	if _, err := exec.LookPath("sh"); err != nil {
		t.Skip("no sh")
	}
	dir := t.TempDir()
	pidFile := filepath.Join(dir, "child.pid")
	ctx, cancel := context.WithTimeout(context.Background(), 300*time.Millisecond)
	defer cancel()
	start := time.Now()
	_, err := ExecRunner(ctx, dir, []string{"sh", "-c", "sleep 30 & echo $! > " + pidFile + "; wait"}, os.Environ())
	if err == nil {
		t.Fatal("expected an error from a killed process")
	}
	if time.Since(start) > 5*time.Second {
		t.Fatalf("runner did not stop promptly: %s", time.Since(start))
	}
	b, err := os.ReadFile(pidFile)
	if err != nil {
		t.Fatal(err)
	}
	var pid int
	for _, c := range strings.TrimSpace(string(b)) {
		pid = pid*10 + int(c-'0')
	}
	waitFor(t, func() bool { return syscall.Kill(pid, 0) != nil })
}

func waitFor(t *testing.T, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatal("condition not met in time")
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func statuses(rs []*Result) []string {
	var s []string
	for _, r := range rs {
		s = append(s, r.Status)
	}
	return s
}
