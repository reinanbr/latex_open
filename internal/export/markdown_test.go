package export

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"testing"
	"time"
)

func write(t *testing.T, root string, files map[string]string) {
	t.Helper()
	for name, body := range files {
		p := filepath.Join(root, filepath.FromSlash(name))
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
}

func TestFlatten(t *testing.T) {
	src := t.TempDir()
	outside := filepath.Join(t.TempDir(), "secret.tex")
	os.WriteFile(outside, []byte("SEGREDO"), 0o644)
	write(t, src, map[string]string{
		"main.tex": `\documentclass{article}
\begin{document}
\input{chap/a}
\include{chap/c}
% \input{commented}
\input{/etc/hostname}\input{../x}
\input{link}
\input{missing}
\input plain
\begin{verbatim}
\input{chap/a}
\end{verbatim}
\subfile{sub}
\end{document}
`,
		"chap/a.tex": "A-start \\input{chap/b} A-end\n",
		"chap/b.tex": "B \\input{chap/a}\n", // cycle back to a
		"chap/c.tex": "C\n",
		"plain.tex":  "PLAIN\n",
		"sub.tex":    "\\documentclass[main]{subfiles}\n\\begin{document}\nSUBBODY\n\\end{document}\n",
	})
	if err := os.Symlink(outside, filepath.Join(src, "link.tex")); err != nil {
		t.Fatal(err)
	}
	var warns []string
	out, err := Flatten(src, "main.tex", func(s string) { warns = append(warns, s) })
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"A-start B \n A-end", "C\n", "PLAIN", "SUBBODY", "% \\input{commented}", "\\begin{verbatim}\n\\input{chap/a}\n\\end{verbatim}"} {
		if !strings.Contains(out, want) {
			t.Errorf("missing %q in\n%s", want, out)
		}
	}
	for _, bad := range []string{"SEGREDO", "\\documentclass[main]", "\\input{/etc", "\\input{../x}", "\\input{missing}"} {
		if strings.Contains(out, bad) {
			t.Errorf("unexpected %q in output", bad)
		}
	}
	w := strings.Join(warns, "\n")
	for _, want := range []string{"\\input{chap/a} ignorado: inclusão circular", "\\input{/etc/hostname} ignorado: o caminho sai do projeto", "\\input{../x} ignorado: o caminho sai do projeto", "\\input{missing} ignorado: arquivo não encontrado", "\\input{link} ignorado"} {
		if !strings.Contains(w, want) {
			t.Errorf("missing warning %q in\n%s", want, w)
		}
	}
	if _, err := Flatten(src, "nope.tex", func(string) {}); err == nil {
		t.Error("missing main file should fail")
	}
}

func TestPandocWarnings(t *testing.T) {
	got := PandocWarnings(`[WARNING] Could not load translations for en-US
  data file translations/en.yaml not found
[WARNING] The term Abstract has no translation defined.
[WARNING] Could not convert TeX math \foo, rendering as TeX:
  \foo
other noise
`)
	if len(got) != 1 || !strings.HasPrefix(got[0], `Could not convert TeX math \foo`) {
		t.Errorf("warnings = %q", got)
	}
}

func TestDropFrontMatterBibliography(t *testing.T) {
	in := "---\nbibliography:\n- a.bib\n- b.bib\ntitle: T\n---\n\n# X\n"
	if got := dropFrontMatterBibliography(in); got != "---\ntitle: T\n---\n\n# X\n" {
		t.Errorf("got %q", got)
	}
	if got := dropFrontMatterBibliography("---\nbibliography: r.bib\n---\n\nbody\n"); got != "body\n" {
		t.Errorf("only-bib front matter: %q", got)
	}
}

func TestMediaRewrite(t *testing.T) {
	src, work := t.TempDir(), t.TempDir()
	write(t, src, map[string]string{
		"figures/a.png": "png",
		"b.pdf":         "%PDF",
		"figs/c.jpg":    "jpg",
		"d.eps":         "%!PS",
	})
	var calls []string
	run := func(_ context.Context, _ string, _ []byte, name string, args ...string) ([]byte, []byte, error) {
		calls = append(calls, name)
		switch name {
		case "pdftoppm":
			os.WriteFile(args[len(args)-1]+".png", []byte("png"), 0o644)
		case "gs":
			// No output: conversion "fails".
		}
		return nil, nil, nil
	}
	var warns []string
	m := &mediaCollector{
		opts:         Options{SrcDir: src, WorkDir: work, Tools: Tools{Pdftoppm: "pdftoppm", Gs: "gs"}, Run: run},
		warn:         func(s string) { warns = append(warns, s) },
		done:         map[string]string{},
		files:        map[string]string{},
		graphicsPath: []string{"figs/"},
	}
	md := `<img src="figures/a" style="width:35.0%" />
<embed src="b.pdf" style="width:3cm" />
![image](c)
![image](d.eps)
![x](/etc/hostname)
![y](../../etc/passwd)
![z](http://example.com/i.png)
<img src="figures/a" />
`
	got := m.rewrite(context.Background(), md)
	want := `<img src="media/figures/a.png" style="width:35.0%" />
<img src="media/b.png" style="width:3cm" />
![image](media/figs/c.jpg)
![image](media/d.eps)
![x](/etc/hostname)
![y](../../etc/passwd)
![z](http://example.com/i.png)
<img src="media/figures/a.png" />
`
	if got != want {
		t.Errorf("got\n%s\nwant\n%s", got, want)
	}
	if len(m.files) != 4 || m.files["media/figures/a.png"] != filepath.Join(src, "figures/a.png") || m.files["media/b.png"] != filepath.Join(work, "media/b.png") {
		t.Errorf("files = %v", m.files)
	}
	w := strings.Join(warns, "\n")
	if !strings.Contains(w, `"/etc/hostname": fora do projeto`) || !strings.Contains(w, "não foi possível converter d.eps") {
		t.Errorf("warnings:\n%s", w)
	}
	sort.Strings(calls)
	if strings.Join(calls, ",") != "gs,pdftoppm" {
		t.Errorf("calls = %v", calls)
	}
}

func lookTools(t *testing.T) Tools {
	t.Helper()
	p, err := exec.LookPath("pandoc")
	if err != nil {
		t.Skip("pandoc not installed")
	}
	tl := Tools{Pandoc: p}
	tl.Pdftoppm, _ = exec.LookPath("pdftoppm")
	tl.Gs, _ = exec.LookPath("gs")
	return tl
}

func TestMarkdownSampleProject(t *testing.T) {
	tools := lookTools(t)
	res, err := Markdown(context.Background(), Options{
		SrcDir: "../../testdata/sample-project", MainFile: "main.tex", WorkDir: t.TempDir(),
		Tools: tools, Now: time.Date(2026, 1, 2, 0, 0, 0, 0, time.UTC),
	})
	if err != nil {
		t.Fatal(err)
	}
	md := string(res.Markdown)
	for _, want := range []string{"title: Projeto de Exemplo do texdesk", "date: 2026-01-02", "# Introdução", "# Métodos", "(Knuth 1984)", `src="media/figures/sample.png"`, "| TeX "} {
		if !strings.Contains(md, want) {
			t.Errorf("missing %q in\n%s", want, md)
		}
	}
	if strings.Contains(md, "bibliography:") {
		t.Error("front matter still lists the bibliography")
	}
	if _, ok := res.Media["media/figures/sample.png"]; !ok || len(res.Media) != 1 {
		t.Errorf("media = %v", res.Media)
	}
	for _, w := range res.Warnings {
		t.Logf("warning: %s", w)
	}
}

const tinyPDF = `%PDF-1.1
1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj
2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj
3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 100 50]>>endobj
trailer<</Root 1 0 R>>
%%EOF
`

const tinyEPS = `%!PS-Adobe-3.0 EPSF-3.0
%%BoundingBox: 0 0 50 50
newpath 0 0 moveto 50 50 lineto stroke
showpage
`

func TestMarkdownConvertsFigures(t *testing.T) {
	tools := lookTools(t)
	if tools.Pdftoppm == "" && tools.Gs == "" {
		t.Skip("no converters")
	}
	src := t.TempDir()
	write(t, src, map[string]string{
		"main.tex": "\\documentclass{article}\\usepackage{graphicx}\\graphicspath{{img/}}\n\\begin{document}\nTexto.\n\n" +
			"\\includegraphics[width=3cm]{plot}\n\n\\includegraphics{diagram.eps}\n\\end{document}\n",
		"img/plot.pdf":    tinyPDF,
		"img/diagram.eps": tinyEPS,
	})
	work := t.TempDir()
	res, err := Markdown(context.Background(), Options{SrcDir: src, MainFile: "main.tex", WorkDir: work, Tools: tools})
	if err != nil {
		t.Fatal(err)
	}
	md := string(res.Markdown)
	if !strings.Contains(md, `<img src="media/img/plot.png"`) {
		t.Errorf("pdf figure not converted:\n%s\nwarnings: %v", md, res.Warnings)
	}
	if tools.Gs != "" && !strings.Contains(md, "media/img/diagram.png") {
		t.Errorf("eps figure not converted:\n%s\nwarnings: %v", md, res.Warnings)
	}
	for k, p := range res.Media {
		b, err := os.ReadFile(p)
		if err != nil || !strings.HasPrefix(string(b), "\x89PNG") {
			t.Errorf("%s is not a PNG (%v)", k, err)
		}
	}
}
