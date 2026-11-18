// Package compiler runs latexmk for a project, one compilation per project
// at a time (a new request cancels the running one), parses the logs into
// structured problems and keeps a few per-build snapshots of the outputs.
package compiler

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log/slog"
	"os"
	"path"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"sync"
	"time"

	"texdesk/internal/sandbox"
	"texdesk/internal/ulid"
)

// Engines maps compiler names to latexmk flags.
var Engines = map[string]string{
	"pdflatex": "-pdf",
	"latex":    "-pdfps", // latex → DVI → dvips → ps2pdf (Ghostscript)
	"xelatex":  "-pdfxe",
	"lualatex": "-pdflua",
}

// Options are per-request compile settings.
type Options struct {
	Compiler         string `json:"compiler,omitempty"`
	Draft            bool   `json:"draft,omitempty"`
	StopOnFirstError bool   `json:"stopOnFirstError,omitempty"`
	// Clean removes the auxiliary files of earlier runs first ("recompile
	// from scratch"); the build snapshots are kept.
	Clean bool `json:"clean,omitempty"`
}

// Request identifies what to compile.
type Request struct {
	ProjectID string
	SrcDir    string // absolute
	BuildDir  string // absolute
	MainFile  string // relative to SrcDir, forward slashes
	Options
}

// Status values.
const (
	StatusSuccess  = "success"
	StatusError    = "error"
	StatusTimeout  = "timeout"
	StatusCanceled = "canceled"
)

// Result is returned to the client and persisted (without Log/Output) as
// result.json in the build snapshot.
type Result struct {
	Status       string    `json:"status"`
	BuildID      string    `json:"buildId"`
	DurationMs   int64     `json:"durationMs"`
	PDFAvailable bool      `json:"pdfAvailable"`
	Log          string    `json:"log"`
	Output       string    `json:"output"`
	Problems     []Problem `json:"problems"`
	Compiler     string    `json:"compiler"`
	MainFile     string    `json:"mainFile"`
	Draft        bool      `json:"draft"`
	StartedAt    time.Time `json:"startedAt"`
}

// Runner executes a command; it must kill the whole process tree when ctx is
// done. ExecRunner is the production implementation.
type Runner func(ctx context.Context, dir string, args, env []string) ([]byte, error)

// ErrNoMainFile is returned when the project has no main file configured.
var ErrNoMainFile = errors.New("project has no main file")

type job struct {
	cancel context.CancelFunc
	done   chan struct{}
}

// Manager serializes compilations per project and bounds global concurrency.
type Manager struct {
	Timeout time.Duration
	Run     Runner
	Keep    int // number of build snapshots kept per project
	// OnSuccess is called after a successful build (hook for version
	// history: e.g. snapshot src/).
	OnSuccess func(req Request, res *Result)

	log  *slog.Logger
	sem  chan struct{}
	mu   sync.Mutex
	jobs map[string]*job
}

// NewManager creates a manager with sensible defaults.
func NewManager(timeout time.Duration, log *slog.Logger) *Manager {
	n := runtime.NumCPU() / 2
	if n < 1 {
		n = 1
	}
	if timeout <= 0 {
		timeout = 60 * time.Second
	}
	return &Manager{
		Timeout: timeout,
		Run:     ExecRunner,
		Keep:    5,
		log:     log,
		sem:     make(chan struct{}, n),
		jobs:    map[string]*job{},
	}
}

// Cancel stops the running compilation of a project, if any, and waits for it.
func (m *Manager) Cancel(projectID string) {
	m.mu.Lock()
	j := m.jobs[projectID]
	m.mu.Unlock()
	if j != nil {
		j.cancel()
		<-j.done
	}
}

// CancelAll stops every running compilation (shutdown).
func (m *Manager) CancelAll() {
	m.mu.Lock()
	jobs := make([]*job, 0, len(m.jobs))
	for _, j := range m.jobs {
		jobs = append(jobs, j)
	}
	m.mu.Unlock()
	for _, j := range jobs {
		j.cancel()
		<-j.done
	}
}

// Running reports whether a compilation is in progress for the project.
func (m *Manager) Running(projectID string) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.jobs[projectID] != nil
}

// Compile runs latexmk. A newer Compile for the same project cancels this
// one, which then returns a result with StatusCanceled.
func (m *Manager) Compile(ctx context.Context, req Request) (*Result, error) {
	if req.MainFile == "" {
		return nil, ErrNoMainFile
	}
	if req.Compiler == "" {
		req.Compiler = "pdflatex"
	}
	if _, ok := Engines[req.Compiler]; !ok {
		return nil, fmt.Errorf("unknown compiler %q", req.Compiler)
	}

	jctx, cancel := context.WithCancel(ctx)
	me := &job{cancel: cancel, done: make(chan struct{})}
	m.mu.Lock()
	prev := m.jobs[req.ProjectID]
	m.jobs[req.ProjectID] = me
	m.mu.Unlock()
	defer func() {
		cancel()
		m.mu.Lock()
		if m.jobs[req.ProjectID] == me {
			delete(m.jobs, req.ProjectID)
		}
		m.mu.Unlock()
		close(me.done)
	}()

	start := time.Now()
	canceled := func() *Result {
		return &Result{Status: StatusCanceled, Compiler: req.Compiler, MainFile: req.MainFile, Problems: []Problem{},
			StartedAt: start.UTC(), DurationMs: time.Since(start).Milliseconds()}
	}

	// Wait for the previous build of this project to stop: they share build/.
	if prev != nil {
		prev.cancel()
		select {
		case <-prev.done:
		case <-jctx.Done():
			return canceled(), nil
		}
	}
	select {
	case m.sem <- struct{}{}:
		defer func() { <-m.sem }()
	case <-jctx.Done():
		return canceled(), nil
	}
	if jctx.Err() != nil {
		return canceled(), nil
	}
	return m.run(jctx, req, start)
}

func (m *Manager) run(jctx context.Context, req Request, start time.Time) (*Result, error) {
	mainAbs := filepath.Join(req.SrcDir, filepath.FromSlash(req.MainFile))
	if fi, err := os.Stat(mainAbs); err != nil || !fi.Mode().IsRegular() {
		return nil, fmt.Errorf("main file %q not found", req.MainFile)
	}
	if req.Clean {
		if err := cleanBuildDir(req.BuildDir); err != nil {
			return nil, fmt.Errorf("cleaning build dir: %w", err)
		}
	}
	if err := prepareBuildDir(req.SrcDir, req.BuildDir); err != nil {
		return nil, fmt.Errorf("preparing build dir: %w", err)
	}
	job := strings.TrimSuffix(path.Base(req.MainFile), path.Ext(req.MainFile))
	out := func(ext string) string { return filepath.Join(req.BuildDir, job+ext) }
	// Never serve a stale PDF from an earlier run as if it were new.
	for _, ext := range []string{".pdf", ".synctex.gz", ".synctex"} {
		_ = os.Remove(out(ext))
	}

	// Confine latexmk and everything it spawns: read the sources, write only
	// the build directory (temporary files included).
	tmp := filepath.Join(req.BuildDir, ".tmp")
	_ = os.MkdirAll(tmp, 0o755)
	args := sandbox.Wrap(BuildArgs(req), sandbox.Policy{RO: []string{req.SrcDir}, RW: []string{req.BuildDir}})
	env := append(CompileEnv(req.Compiler), "TMPDIR="+tmp)
	tctx, tcancel := context.WithTimeout(jctx, m.Timeout)
	defer tcancel()
	output, runErr := m.Run(tctx, req.SrcDir, args, env)
	dur := time.Since(start)

	res := &Result{
		Compiler: req.Compiler, MainFile: req.MainFile, Draft: req.Draft,
		StartedAt: start.UTC(), DurationMs: dur.Milliseconds(), Output: tail(string(output), 256<<10),
	}
	switch {
	case jctx.Err() != nil:
		res.Status = StatusCanceled
		res.Problems = []Problem{}
		m.log.Info("compile canceled", "project", req.ProjectID)
		return res, nil
	case errors.Is(tctx.Err(), context.DeadlineExceeded):
		res.Status = StatusTimeout
	case runErr == nil:
		res.Status = StatusSuccess
	default:
		res.Status = StatusError
	}

	pm := PathMapper{SrcDir: req.SrcDir, BuildDir: req.BuildDir}
	if b, err := readTail(out(".log"), 8<<20); err == nil {
		res.Log = string(b)
		res.Problems = ParseTeXLog(res.Log, pm, req.MainFile)
	}
	if fi, err := os.Stat(out(".blg")); err == nil && !fi.ModTime().Before(start) {
		if b, err := readTail(out(".blg"), 1<<20); err == nil {
			res.Problems = append(res.Problems, ParseBibLog(string(b), pm)...)
		}
	}
	if fi, err := os.Stat(out(".pdf")); err == nil && fi.Size() > 0 {
		res.PDFAvailable = true
	} else if res.Status == StatusSuccess {
		res.Status = StatusError
	}
	if res.Status == StatusTimeout {
		res.Problems = append([]Problem{{
			Level:   "error",
			Message: fmt.Sprintf("A compilação excedeu o tempo limite de %s e foi interrompida.", m.Timeout),
			Raw:     "timeout",
		}}, res.Problems...)
	}
	if res.Status == StatusError && !hasErrors(res.Problems) {
		res.Problems = append(res.Problems, Problem{
			Level: "error", Message: summarizeOutput(res.Output, res.PDFAvailable), Raw: tail(res.Output, 4096),
		})
	}
	if res.Problems == nil {
		res.Problems = []Problem{}
	}
	res.Problems = PostProcess(res.Problems)
	if req.Compiler == "latex" {
		res.Problems = dviFigureHints(res.Problems)
	}
	res.Problems = SortProblems(res.Problems)

	res.BuildID = ulid.New()
	if err := m.snapshot(req, res, out); err != nil {
		return nil, fmt.Errorf("saving build output: %w", err)
	}
	m.log.Info("compiled", "project", req.ProjectID, "status", res.Status, "build", res.BuildID,
		"compiler", req.Compiler, "dur_ms", res.DurationMs, "problems", len(res.Problems))
	if res.Status == StatusSuccess && m.OnSuccess != nil {
		m.OnSuccess(req, res)
	}
	return res, nil
}

// BuildArgs returns the latexmk command line for a request.
func BuildArgs(req Request) []string {
	args := []string{
		"latexmk",
		"-norc", // never run a project-supplied latexmkrc (it is Perl code)
		"-g",    // always rerun: "Recompile" after an error must really compile
		Engines[req.Compiler],
		"-interaction=nonstopmode",
		"-file-line-error",
		"-synctex=1",
		"-no-shell-escape",
		"-outdir=" + req.BuildDir,
	}
	if req.Compiler == "latex" {
		// dvips must never run commands: -R2 blocks backtick specials and
		// the E option of config files. No "-P pdf": without Type 1 fonts
		// (cm-super) it renders 8000 dpi bitmaps, minutes and huge PDFs.
		// This is texdesk's fixed code, not the project's (-norc applies).
		args = append(args, "-e", `$dvips = "dvips -R2 %O -o %D %S"; $dvips_pdf_switch = ""; $ps2pdf = "ps2pdf -dSAFER -dALLOWPSTRANSPARENCY %O %S %D";`)
	}
	if req.StopOnFirstError {
		args = append(args, "-halt-on-error")
	} else {
		args = append(args, "-f") // keep going (bibtex, reruns) past errors
	}
	if req.Draft {
		// Fast draft: figures become boxes. (pdfTeX's -draftmode would
		// produce no PDF at all.)
		args = append(args, `-usepretex=\PassOptionsToPackage{draft}{graphicx}\PassOptionsToPackage{draft}{graphics}`)
	}
	return append(args, req.MainFile)
}

// CompileEnv returns the environment for an engine run.
func CompileEnv(engine string) []string {
	// No reads of dotfiles or of absolute paths outside the TeX tree
	// (\input{/etc/passwd} fails). LuaLaTeX needs "r" instead of "p":
	// luaotfload reads its font database and system fonts by absolute path.
	openin := "openin_any=p"
	if engine == "lualatex" {
		openin = "openin_any=r"
	}
	return append(os.Environ(), policyEnv(openin)...)
}

// PolicyEnv is CompileEnv without the inherited environment (VAR=value
// pairs to put in front of another TeX run, e.g. the export's TikZ render).
func PolicyEnv(engine string) []string {
	return CompileEnv(engine)[len(os.Environ()):]
}

func policyEnv(openin string) []string {
	return []string{
		// Unwrapped log lines make the log parser reliable.
		"max_print_line=10000", "error_line=254", "half_error_line=238",
		// No writes outside the working/output dirs.
		"openout_any=p", openin,
		// Belt and braces: disable even restricted \write18.
		"shell_escape=f",
	}
}

// prepareBuildDir mirrors src/'s folder structure into build/, because
// \include{chapters/x} writes build/chapters/x.aux and TeX will not create
// directories.
func prepareBuildDir(src, build string) error {
	if err := os.MkdirAll(build, 0o755); err != nil {
		return err
	}
	return filepath.WalkDir(src, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if !d.IsDir() || p == src {
			return nil
		}
		rel, err := filepath.Rel(src, p)
		if err != nil {
			return err
		}
		return os.MkdirAll(filepath.Join(build, rel), 0o755)
	})
}

const outDirName = ".texdesk-out"

// cleanBuildDir deletes everything in build/ except the snapshots.
func cleanBuildDir(build string) error {
	entries, err := os.ReadDir(build)
	if errors.Is(err, fs.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	for _, e := range entries {
		if e.Name() == outDirName {
			continue
		}
		if err := os.RemoveAll(filepath.Join(build, e.Name())); err != nil {
			return err
		}
	}
	return nil
}

func (m *Manager) snapshot(req Request, res *Result, out func(string) string) error {
	dir := filepath.Join(req.BuildDir, outDirName, res.BuildID)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	if res.PDFAvailable {
		if err := copyFile(out(".pdf"), filepath.Join(dir, "output.pdf")); err != nil {
			return err
		}
		_ = copyFile(out(".synctex.gz"), filepath.Join(dir, "output.synctex.gz"))
	}
	if err := os.WriteFile(filepath.Join(dir, "output.log"), []byte(res.Log), 0o644); err != nil {
		return err
	}
	meta := *res
	meta.Log, meta.Output = "", ""
	b, _ := json.Marshal(meta)
	if err := os.WriteFile(filepath.Join(dir, "result.json"), b, 0o644); err != nil {
		return err
	}
	m.prune(filepath.Join(req.BuildDir, outDirName), res.BuildID)
	return nil
}

func (m *Manager) prune(root, keepID string) {
	ids := listBuilds(root)
	keep := m.Keep
	if keep < 1 {
		keep = 1
	}
	for i := 0; i < len(ids)-keep; i++ {
		if ids[i] != keepID {
			_ = os.RemoveAll(filepath.Join(root, ids[i]))
		}
	}
}

// listBuilds returns build ids, oldest first (ULIDs sort by time).
func listBuilds(root string) []string {
	entries, _ := os.ReadDir(root)
	var ids []string
	for _, e := range entries {
		if e.IsDir() && ulid.Valid(e.Name()) {
			ids = append(ids, e.Name())
		}
	}
	sort.Strings(ids)
	return ids
}

// OutputPath returns the path of a snapshot file ("output.pdf",
// "output.log", "output.synctex.gz") after validating the build id.
func OutputPath(buildDir, buildID, name string) (string, bool) {
	if !ulid.Valid(buildID) {
		return "", false
	}
	p := filepath.Join(buildDir, outDirName, buildID, name)
	if _, err := os.Stat(p); err != nil {
		return "", false
	}
	return p, true
}

// Latest returns the newest build's stored result (without log), or nil.
func Latest(buildDir string, withPDF bool) *Result {
	root := filepath.Join(buildDir, outDirName)
	ids := listBuilds(root)
	for i := len(ids) - 1; i >= 0; i-- {
		b, err := os.ReadFile(filepath.Join(root, ids[i], "result.json"))
		if err != nil {
			continue
		}
		var r Result
		if json.Unmarshal(b, &r) != nil {
			continue
		}
		if withPDF && !r.PDFAvailable {
			continue
		}
		return &r
	}
	return nil
}

func hasErrors(ps []Problem) bool {
	for _, p := range ps {
		if p.Level == "error" {
			return true
		}
	}
	return false
}

func summarizeOutput(out string, pdf bool) string {
	for _, l := range strings.Split(out, "\n") {
		l = strings.TrimSpace(l)
		if strings.HasPrefix(l, "Latexmk: ") && (strings.Contains(l, "rror") || strings.Contains(l, "Missing") || strings.Contains(l, "not found")) {
			return l
		}
	}
	if pdf {
		return "A compilação terminou com erros (veja o log bruto)."
	}
	return "A compilação falhou e nenhum PDF foi gerado (veja o log bruto)."
}

func tail(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return "…\n" + s[len(s)-n:]
}

func readTail(p string, max int64) ([]byte, error) {
	f, err := os.Open(p)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	fi, err := f.Stat()
	if err != nil {
		return nil, err
	}
	if fi.Size() > max {
		if _, err := f.Seek(-max, io.SeekEnd); err != nil {
			return nil, err
		}
	}
	return io.ReadAll(f)
}

func copyFile(src, dst string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	tmp := dst + ".tmp"
	out, err := os.Create(tmp)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		os.Remove(tmp)
		return err
	}
	if err := out.Close(); err != nil {
		os.Remove(tmp)
		return err
	}
	return os.Rename(tmp, dst)
}
