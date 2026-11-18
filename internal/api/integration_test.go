package api

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"io"
	"io/fs"
	"log/slog"
	"mime/multipart"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"texdesk/internal/compiler"
	"texdesk/internal/project"
	"texdesk/internal/sandbox"
	"texdesk/internal/tools"
)

// Integration tests run the real TeX toolchain; they are skipped when it is
// not installed. Run with: make test-integration
func requireTeX(t *testing.T) *tools.Capabilities {
	t.Helper()
	if testing.Short() {
		t.Skip("short mode")
	}
	for _, bin := range []string{"latexmk", "pdflatex", "bibtex"} {
		if _, err := exec.LookPath(bin); err != nil {
			t.Skipf("%s not installed", bin)
		}
	}
	return tools.Detect()
}

func newRealEnv(t *testing.T) *testEnv {
	caps := requireTeX(t)
	store, err := project.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	srv := New(Config{Addr: "127.0.0.1:8080", MaxUploadBytes: 50 << 20, CompileTimeout: 2 * time.Minute}, store, caps, log)
	return &testEnv{t: t, srv: srv, store: store}
}

// zipDir zips a directory tree (inside a top-level folder, like a user would).
func zipDir(t *testing.T, dir string) []byte {
	t.Helper()
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	err := filepath.WalkDir(dir, func(p string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return err
		}
		rel, _ := filepath.Rel(dir, p)
		w, err := zw.Create("sample-project/" + filepath.ToSlash(rel))
		if err != nil {
			return err
		}
		b, err := os.ReadFile(p)
		if err != nil {
			return err
		}
		_, err = w.Write(b)
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
	zw.Close()
	return buf.Bytes()
}

func (e *testEnv) importZip(data []byte) string {
	e.t.Helper()
	var body bytes.Buffer
	mw := multipart.NewWriter(&body)
	fw, _ := mw.CreateFormFile("file", "sample.zip")
	fw.Write(data)
	mw.Close()
	rec := e.do("POST", "/api/projects", &body, map[string]string{"Content-Type": mw.FormDataContentType()})
	expect(e.t, rec, http.StatusCreated)
	var res createResponse
	json.Unmarshal(rec.Body.Bytes(), &res)
	return res.Project.ID
}

func (e *testEnv) compileProject(id string, opts map[string]any) compiler.Result {
	e.t.Helper()
	rec := e.json("POST", "/api/projects/"+id+"/compile", opts)
	expect(e.t, rec, http.StatusOK)
	var res compiler.Result
	if err := json.Unmarshal(rec.Body.Bytes(), &res); err != nil {
		e.t.Fatal(err)
	}
	return res
}

func TestIntegrationSampleProject(t *testing.T) {
	e := newRealEnv(t)
	id := e.importZip(zipDir(t, "../../testdata/sample-project"))

	res := e.compileProject(id, map[string]any{})
	if res.Status != "success" || !res.PDFAvailable {
		t.Fatalf("compile status=%s pdf=%v problems=%+v\n%s", res.Status, res.PDFAvailable, res.Problems, res.Output)
	}
	for _, p := range res.Problems {
		if p.Level == "error" {
			t.Errorf("unexpected error: %+v", p)
		}
		if strings.Contains(p.Message, "undefined") {
			t.Errorf("references/citations should be resolved after latexmk reruns: %+v", p)
		}
	}

	rec := e.do("GET", "/api/projects/"+id+"/compile/"+res.BuildID+"/pdf", nil, nil)
	expect(t, rec, http.StatusOK)
	if !bytes.HasPrefix(rec.Body.Bytes(), []byte("%PDF-")) || rec.Header().Get("Content-Type") != "application/pdf" {
		t.Fatalf("not a PDF: %q %s", rec.Body.Bytes()[:min(16, rec.Body.Len())], rec.Header().Get("Content-Type"))
	}
	rec = e.do("GET", "/api/projects/"+id+"/compile/"+res.BuildID+"/log", nil, nil)
	expect(t, rec, http.StatusOK)
	if !strings.Contains(rec.Body.String(), "pdfTeX") {
		t.Error("log endpoint did not return the TeX log")
	}
	rec = e.do("GET", "/api/projects/"+id+"/export/pdf", nil, nil)
	expect(t, rec, http.StatusOK)
	if !strings.Contains(rec.Header().Get("Content-Disposition"), ".pdf") {
		t.Error("export/pdf should be an attachment")
	}

	// src/ stays clean: no build artifacts leak into the user's files or zip.
	rec = e.do("GET", "/api/projects/"+id+"/export/zip", nil, nil)
	zr, _ := zip.NewReader(bytes.NewReader(rec.Body.Bytes()), int64(rec.Body.Len()))
	for _, f := range zr.File {
		for _, bad := range []string{".aux", ".log", ".pdf", ".synctex", ".bbl", ".fls"} {
			if strings.HasSuffix(f.Name, bad) || strings.Contains(f.Name, bad+".") {
				t.Errorf("artifact in exported zip: %s", f.Name)
			}
		}
	}

	// SyncTeX both ways on the build the user is looking at.
	q := "/api/projects/" + id + "/synctex/forward?file=chapters/intro.tex&line=5&col=1&buildId=" + res.BuildID
	rec = e.do("GET", q, nil, nil)
	expect(t, rec, http.StatusOK)
	var box struct {
		Page       int
		X, Y, W, H float64
	}
	json.Unmarshal(rec.Body.Bytes(), &box)
	if box.Page != 1 || box.W <= 0 || box.H <= 0 || box.Y <= 0 {
		t.Fatalf("forward box = %+v", box)
	}
	rec = e.do("GET", "/api/projects/"+id+"/synctex/inverse?page=1&x="+ftoa(box.X+5)+"&y="+ftoa(box.Y+box.H/2), nil, nil)
	expect(t, rec, http.StatusOK)
	var loc struct {
		File string
		Line int
	}
	json.Unmarshal(rec.Body.Bytes(), &loc)
	if loc.File != "chapters/intro.tex" || loc.Line < 4 || loc.Line > 7 {
		t.Errorf("inverse = %+v", loc)
	}
	rec = e.do("GET", "/api/projects/"+id+"/synctex/forward?file=../etc/passwd&line=1", nil, nil)
	expect(t, rec, http.StatusBadRequest)

	// Index and word count.
	rec = e.do("GET", "/api/projects/"+id+"/index", nil, nil)
	expect(t, rec, http.StatusOK)
	for _, want := range []string{`"sec:intro"`, `"eq:euler"`, `"knuth1984"`, `"lamport1994"`} {
		if !strings.Contains(rec.Body.String(), want) {
			t.Errorf("index missing %s", want)
		}
	}
	if _, err := exec.LookPath("texcount"); err == nil {
		rec = e.do("GET", "/api/projects/"+id+"/wordcount", nil, nil)
		expect(t, rec, http.StatusOK)
		if !strings.Contains(rec.Body.String(), `"source":"texcount"`) {
			t.Errorf("wordcount = %s", rec.Body.String())
		}
	}

	// Markdown export: a zip (the sample has a figure) with warnings header.
	if _, err := exec.LookPath("pandoc"); err == nil {
		rec = e.do("GET", "/api/projects/"+id+"/export/md", nil, nil)
		expect(t, rec, http.StatusOK)
		if rec.Header().Get("Content-Type") != "application/zip" || rec.Header().Get("X-Texdesk-Media") != "1" {
			t.Fatalf("md export headers: %v", rec.Header())
		}
		zr, err := zip.NewReader(bytes.NewReader(rec.Body.Bytes()), int64(rec.Body.Len()))
		if err != nil {
			t.Fatal(err)
		}
		names := map[string]string{}
		for _, f := range zr.File {
			rc, _ := f.Open()
			b, _ := io.ReadAll(rc)
			rc.Close()
			names[f.Name] = string(b)
		}
		md, ok := names["sample.md"]
		if !ok || !strings.Contains(md, "# Introdução") || !strings.Contains(md, `src="media/figures/sample.png"`) {
			t.Errorf("md zip: files=%v md=%q", len(names), md)
		}
		if _, ok := names["media/figures/sample.png"]; !ok {
			t.Error("figure missing from md zip")
		}
		if w, _ := url.QueryUnescape(rec.Header().Get("X-Texdesk-Warnings")); w != "[]" && w != "null" {
			t.Logf("md warnings: %s", w)
		}
	}

	// Draft mode and other engines.
	if res := e.compileProject(id, map[string]any{"draft": true}); res.Status != "success" {
		t.Errorf("draft compile: %s %+v", res.Status, res.Problems)
	}
	if _, err := exec.LookPath("lualatex"); err == nil {
		if res := e.compileProject(id, map[string]any{"compiler": "lualatex"}); !res.PDFAvailable {
			t.Errorf("lualatex compile: %s %+v", res.Status, res.Problems)
		}
	}
}

func TestIntegrationErrorsStillServePDF(t *testing.T) {
	e := newRealEnv(t)
	m, _ := e.store.CreateBlank("broken")
	broken := "\\documentclass{article}\n\\begin{document}\nOlá \\undefinedmacro\n\nTexto \\ref{nada}.\n\\end{document}\n"
	if _, err := e.store.WriteFile(m.ID, "main.tex", strings.NewReader(broken), 1<<20); err != nil {
		t.Fatal(err)
	}
	res := e.compileProject(m.ID, map[string]any{})
	if res.Status != "error" {
		t.Fatalf("status = %s", res.Status)
	}
	if !res.PDFAvailable {
		t.Error("PDF should still be served when TeX recovered from errors")
	}
	assertHas(t, res.Problems, "error", "main.tex", 3, "Undefined control sequence")
	assertHas(t, res.Problems, "warning", "main.tex", 5, "Reference `nada'")

	// A project-supplied latexmkrc must never run.
	marker := filepath.Join(t.TempDir(), "pwned")
	rc := "system('touch " + marker + "');\n"
	e.store.WriteFile(m.ID, "latexmkrc", strings.NewReader(rc), 1<<20)
	e.store.WriteFile(m.ID, ".latexmkrc", strings.NewReader(rc), 1<<20)
	// Nor shell escape.
	e.store.WriteFile(m.ID, "main.tex", strings.NewReader("\\documentclass{article}\n\\begin{document}\n\\immediate\\write18{touch "+marker+"}\nx\n\\end{document}\n"), 1<<20)
	e.compileProject(m.ID, map[string]any{})
	if _, err := os.Stat(marker); err == nil {
		t.Fatal("latexmkrc or \\write18 was executed")
	}
}

// A project must not be able to read files outside its directory, even with
// LuaLaTeX (which runs with openin_any=r): the Landlock sandbox blocks it.
func TestIntegrationLuaLaTeXCannotReadOutside(t *testing.T) {
	e := newRealEnv(t)
	if _, err := exec.LookPath("lualatex"); err != nil {
		t.Skip("lualatex not installed")
	}
	if !sandbox.Enabled() {
		t.Skip("Landlock sandbox unavailable on this kernel")
	}
	secret := filepath.Join(t.TempDir(), "secret.tex")
	os.WriteFile(secret, []byte("SEGREDOXYZ\n"), 0o644)
	m, _ := e.store.CreateBlank("leak")
	src := "% !TEX program = lualatex\n\\documentclass{article}\n\\begin{document}\nA\\input{" + secret + "}B\n\\end{document}\n"
	e.store.WriteFile(m.ID, "main.tex", strings.NewReader(src), 1<<20)
	res := e.compileProject(m.ID, map[string]any{"compiler": "lualatex"})
	if strings.Contains(res.Log, "SEGREDOXYZ") || strings.Contains(res.Output, "SEGREDOXYZ") {
		t.Fatal("secret content leaked into the build")
	}
	if pdf, ok := compiler.OutputPath(e.store.BuildDir(m.ID), res.BuildID, "output.pdf"); ok {
		if out, err := exec.Command("pdftotext", pdf, "-").Output(); err == nil && strings.Contains(string(out), "SEGREDOXYZ") {
			t.Fatal("secret content leaked into the PDF")
		}
	}
	// Sanity: the same file inside the project is readable.
	e.store.WriteFile(m.ID, "inside.tex", strings.NewReader("DENTROXYZ\n"), 1<<20)
	e.store.WriteFile(m.ID, "main.tex", strings.NewReader(strings.Replace(src, secret, "inside", 1)), 1<<20)
	res = e.compileProject(m.ID, map[string]any{"compiler": "lualatex"})
	if !res.PDFAvailable || res.Compiler != "lualatex" {
		t.Fatalf("inside compile: %s %s %+v", res.Status, res.Compiler, res.Problems)
	}
	pdf, _ := compiler.OutputPath(e.store.BuildDir(m.ID), res.BuildID, "output.pdf")
	if out, err := exec.Command("pdftotext", pdf, "-").Output(); err == nil && !strings.Contains(string(out), "DENTROXYZ") {
		t.Errorf("file inside the project not included: %q", out)
	}
}

func ftoa(f float64) string { return strconv.FormatFloat(f, 'f', 2, 64) }

func assertHas(t *testing.T, ps []compiler.Problem, level, file string, line int, msg string) {
	t.Helper()
	for _, p := range ps {
		if p.Level == level && p.File == file && p.Line == line && strings.Contains(p.Message, msg) {
			return
		}
	}
	t.Errorf("missing %s %s:%d %q in %+v", level, file, line, msg, ps)
}

// A missing class gets an actionable hint instead of just "Emergency stop".
func TestIntegrationMissingClassHint(t *testing.T) {
	e := newRealEnv(t)
	m, _ := e.store.CreateBlank("missing")
	e.store.WriteFile(m.ID, "main.tex", strings.NewReader("\\documentclass{texdeskmissingclass}\n\\begin{document}\nx\n\\end{document}\n"), 1<<20)
	res := e.compileProject(m.ID, map[string]any{})
	for _, p := range res.Problems {
		if strings.Contains(p.Message, "texdeskmissingclass.cls' not found") {
			if !strings.Contains(p.Message, "apt-file search texdeskmissingclass.cls") {
				t.Errorf("no install hint: %q", p.Message)
			}
			return
		}
	}
	t.Fatalf("missing-class problem not reported: %+v", res.Problems)
}

// abnTeX2 thesis: compiles cleanly and exports to Markdown with ABNT
// citations and the TikZ figure as PNG. Needs abnTeX2 (Debian:
// texlive-publishers) and preview.sty; TEXMFHOME may point at local copies.
func TestIntegrationABNTProject(t *testing.T) {
	e := newRealEnv(t)
	for _, f := range []string{"abntex2.cls", "preview.sty"} {
		if out, err := exec.Command("kpsewhich", f).Output(); err != nil || len(out) == 0 {
			t.Skipf("%s not installed", f)
		}
	}
	id := e.importZip(zipDir(t, "../../testdata/abntex2-project"))
	res := e.compileProject(id, map[string]any{})
	t.Logf("compile: %d ms", res.DurationMs)
	if res.Status != "success" || !res.PDFAvailable {
		t.Fatalf("compile status=%s pdf=%v problems=%+v\n%s", res.Status, res.PDFAvailable, res.Problems, res.Output)
	}
	for _, p := range res.Problems {
		if p.Level == "error" || strings.Contains(p.Message, "undefined") {
			t.Errorf("unexpected problem: %+v", p)
		}
	}

	if e.srv.caps.Pandoc.Path == "" {
		t.Skip("pandoc not installed")
	}
	start := time.Now()
	rec := e.do("GET", "/api/projects/"+id+"/export/md", nil, nil)
	expect(t, rec, http.StatusOK)
	t.Logf("markdown export: %s", time.Since(start).Round(time.Millisecond))
	zr, err := zip.NewReader(bytes.NewReader(rec.Body.Bytes()), int64(rec.Body.Len()))
	if err != nil {
		t.Fatalf("export is not a zip (%s): %v", rec.Header().Get("Content-Type"), err)
	}
	var md string
	names := map[string]bool{}
	for _, f := range zr.File {
		names[f.Name] = true
		if strings.HasSuffix(f.Name, ".md") {
			r, _ := f.Open()
			b, _ := io.ReadAll(r)
			md = string(b)
		}
	}
	if !names["media/tikz/figura-01.png"] {
		t.Errorf("zip entries: %v", names)
	}
	for _, want := range []string{"lang: pt-BR", "Segundo Knuth (1984)", "KNUTH, Donald E.", "media/tikz/figura-01.png"} {
		if !strings.Contains(md, want) {
			t.Errorf("missing %q in\n%s", want, md)
		}
	}
}

// "LaTeX" compiler: latex → DVI → dvips → ps2pdf, under the sandbox, with dvips in
// secure mode (a backtick special must not run), SyncTeX, and "recompile
// from scratch" keeping earlier snapshots.
func TestIntegrationLatexDVIAndClean(t *testing.T) {
	e := newRealEnv(t)
	if !e.srv.caps.Latex.Available {
		t.Skipf("latex/dvipdf unavailable: %s", e.srv.caps.Latex.Reason)
	}
	marker := filepath.Join(t.TempDir(), "pwned")
	m, _ := e.store.CreateBlank("dvi")
	src := "\\documentclass{article}\n\\begin{document}\nOlá DVIXYZ $x^2$.\n" +
		"\\special{psfile=\"`touch " + marker + "\"}\n\\end{document}\n"
	e.store.WriteFile(m.ID, "main.tex", strings.NewReader(src), 1<<20)
	res := e.compileProject(m.ID, map[string]any{"compiler": "latex"})
	if _, err := os.Stat(marker); err == nil {
		t.Fatal("dvips executed a shell command")
	}
	if !res.PDFAvailable || res.Compiler != "latex" {
		t.Fatalf("status=%s pdf=%v problems=%+v\n%s", res.Status, res.PDFAvailable, res.Problems, res.Output)
	}
	pdf, _ := compiler.OutputPath(e.store.BuildDir(m.ID), res.BuildID, "output.pdf")
	if out, err := exec.Command("pdftotext", pdf, "-").Output(); err == nil && !strings.Contains(string(out), "DVIXYZ") {
		t.Errorf("pdf text: %q", out)
	}
	rec := e.do("GET", "/api/projects/"+m.ID+"/synctex/forward?file=main.tex&line=3&col=1&buildId="+res.BuildID, nil, nil)
	expect(t, rec, http.StatusOK)

	// Recompile from scratch: aux files go, earlier snapshots stay.
	e.store.WriteFile(m.ID, "main.tex", strings.NewReader("\\documentclass{article}\n\\begin{document}\nB\n\\end{document}\n"), 1<<20)
	res2 := e.compileProject(m.ID, map[string]any{"compiler": "pdflatex", "clean": true})
	if res2.Status != "success" {
		t.Fatalf("clean compile: %s %+v", res2.Status, res2.Problems)
	}
	if _, err := os.Stat(filepath.Join(e.store.BuildDir(m.ID), "main.dvi")); err == nil {
		t.Error("clean compile kept main.dvi")
	}
	rec = e.do("GET", "/api/projects/"+m.ID+"/compile/"+res.BuildID+"/pdf", nil, nil)
	expect(t, rec, http.StatusOK)
}
