package export

import (
	"context"
	"os"
	"os/exec"
	"strings"
	"testing"
	"time"
)

func TestDetectProfile(t *testing.T) {
	cases := []struct {
		code string
		want profile
	}{
		{`\documentclass[12pt,english,brazil]{abntex2}`, profile{ABNT: true, Lang: "pt-BR"}},
		{"\\documentclass{article}\n\\usepackage[alf]{abntex2cite}\n\\usepackage[english]{babel}", profile{ABNT: true, Lang: "en"}},
		{"\\documentclass{article}\n\\usepackage[brazilian,english]{babel}", profile{Lang: "en"}},
		{"\\documentclass{article}\n\\usepackage{polyglossia}\n\\setmainlanguage[variant=brazilian]{portuguese}", profile{Lang: "pt-BR"}},
		{`\documentclass{report}`, profile{}},
	}
	for _, c := range cases {
		if got := detectProfile(c.code); got != c.want {
			t.Errorf("detectProfile(%q) = %+v, want %+v", c.code, got, c.want)
		}
	}
}

func TestABNTPreprocess(t *testing.T) {
	in := `\titulo{T}\autor{A}\data{2026}
\imprimircapa
\imprimirfolhaderosto*
\imprimirfolhaderostoX
\begin{fichacatalografica}ficha\end{fichacatalografica}
\begin{folhadeaprovacao}
aprovação
\end{folhadeaprovacao}
\begin{resumo}R\end{resumo}
\begin{resumo}[Abstract]A\end{resumo}
\begin{siglas}\item[X] Xis\end{siglas}
\begin{agradecimentos}Obrigado\end{agradecimentos}
\begin{citacao}longa\end{citacao}
Segundo \citeonline[p. 3]{k}, e \citeauthoronline{k}; \apud{a}{b}; \apudonline[p. 1]{c}{d}.
\fonte{Autor}\nota{Obs}
\begin{apendicesenv}\chapter{Ap}\end{apendicesenv}`
	got := abntPreprocess(in)
	for _, want := range []string{
		`\title{T}\author{A}\date{2026}`,
		`\imprimirfolhaderostoX`, // other macros with the same prefix stay
		`\chapter*{Resumo}R`, `\chapter*{Abstract}A`,
		"\\chapter*{Lista de abreviaturas e siglas}\n\\begin{description}\\item[X] Xis\\end{description}",
		`\chapter*{Agradecimentos}Obrigado`,
		`\begin{quote}longa\end{quote}`,
		`\citet[p. 3]{k}`, `\citeauthor{k}`, `\cite{a} apud \cite{b}`, `\citet{c} apud \citet{d}`,
		`\par Fonte: {Autor}\par Nota: {Obs}`,
		`\chapter{Ap}`,
	} {
		if !strings.Contains(got, want) {
			t.Errorf("missing %q in\n%s", want, got)
		}
	}
	for _, gone := range []string{"ficha", "aprovação", `\imprimircapa`, `\imprimirfolhaderosto*`, "apendicesenv", "citeonline", `\end{resumo}`} {
		if strings.Contains(got, gone) {
			t.Errorf("%q should have been removed:\n%s", gone, got)
		}
	}
}

func TestTikzSpans(t *testing.T) {
	tex := "a\n\\begin{tikzpicture}x\\end{tikzpicture}\n% \\begin{tikzpicture}no\\end{tikzpicture}\n" +
		"b \\begin {tikzpicture}[scale=2]y\n\\end{tikzpicture} c"
	spans := tikzSpans(tex)
	if len(spans) != 2 {
		t.Fatalf("spans = %v", spans)
	}
	got := replaceSpans(tex, spans, func(i int) string { return "<" + string(rune('A'+i)) + ">" })
	want := "a\n<A>\n% \\begin{tikzpicture}no\\end{tikzpicture}\nb <B> c"
	if got != want {
		t.Errorf("got %q, want %q", got, want)
	}
}

func TestUnwrapLanguageEnvs(t *testing.T) {
	in := "\\begin{otherlanguage*}{english}A\\end{otherlanguage*} \\begin{otherlanguage}[variant=us]{english}B\\end{otherlanguage}"
	if got := unwrapLanguageEnvs(in); got != "A B" {
		t.Errorf("got %q", got)
	}
}

func TestDropFrontMatterCSL(t *testing.T) {
	in := "---\nbibliography: r.bib\ncsl: /tmp/w/abnt.csl\nlang: pt-BR\n---\n\nx\n"
	if got := dropFrontMatterBibliography(in); got != "---\nlang: pt-BR\n---\n\nx\n" {
		t.Errorf("got %q", got)
	}
}

// texTools returns pandoc + converters + pdflatex, or skips.
func texTools(t *testing.T) (Tools, string) {
	t.Helper()
	tools := lookTools(t)
	if tools.Pdftoppm == "" && tools.Gs == "" {
		t.Skip("no PDF→PNG converter")
	}
	engine, err := exec.LookPath("pdflatex")
	if err != nil {
		t.Skip("pdflatex not installed")
	}
	if out, err := exec.Command("kpsewhich", "preview.sty").Output(); err != nil || len(out) == 0 {
		t.Skip("preview.sty not installed")
	}
	return tools, engine
}

// Same TeX restrictions as a normal compile (see compiler.PolicyEnv).
var testEngineEnv = []string{"openout_any=p", "openin_any=p", "shell_escape=f"}

func TestMarkdownRendersTikz(t *testing.T) {
	tools, engine := texTools(t)
	src := t.TempDir()
	write(t, src, map[string]string{
		"main.tex": "\\documentclass{article}\n\\usepackage{tikz}\n\\definecolor{marca}{RGB}{200,30,30}\n" +
			"\\begin{document}\nAntes.\n\n\\begin{figure}\n\\centering\n" +
			"\\begin{tikzpicture}\\fill[marca] (0,0) rectangle (1,1);\\end{tikzpicture}\n" +
			"\\caption{Quadrado}\n\\end{figure}\n\n" +
			"% \\begin{tikzpicture}\\draw (0,0) -- (1,1);\\end{tikzpicture}\n" +
			"\\begin{tikzpicture}\\draw (0,0) circle (1);\\end{tikzpicture}\n\nDepois.\n\\end{document}\n",
	})
	res, err := Markdown(context.Background(), Options{
		SrcDir: src, MainFile: "main.tex", WorkDir: t.TempDir(), Tools: tools,
		Engine: engine, EngineEnv: testEngineEnv,
	})
	if err != nil {
		t.Fatal(err)
	}
	md := string(res.Markdown)
	for _, want := range []string{"media/tikz/figura-01.png", "media/tikz/figura-02.png", "Quadrado", "Antes.", "Depois."} {
		if !strings.Contains(md, want) {
			t.Errorf("missing %q in\n%s\nwarnings: %v", want, md, res.Warnings)
		}
	}
	if len(res.Media) != 2 {
		t.Errorf("media = %v", res.Media)
	}
	for k, p := range res.Media {
		b, err := os.ReadFile(p)
		if err != nil || !strings.HasPrefix(string(b), "\x89PNG") {
			t.Errorf("%s is not a PNG (%v)", k, err)
		}
	}
}

func TestMarkdownTikzWithoutEngine(t *testing.T) {
	tools := lookTools(t)
	src := t.TempDir()
	write(t, src, map[string]string{
		"main.tex": "\\documentclass{article}\n\\usepackage{tikz}\n\\begin{document}\nA\n\n" +
			"\\begin{tikzpicture}\\draw (0,0) -- (1,1);\\end{tikzpicture}\n\\end{document}\n",
	})
	res, err := Markdown(context.Background(), Options{SrcDir: src, MainFile: "main.tex", WorkDir: t.TempDir(), Tools: tools})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(res.Markdown), "Figura TikZ não convertida") {
		t.Errorf("no placeholder:\n%s", res.Markdown)
	}
	if !strings.Contains(strings.Join(res.Warnings, "\n"), "TikZ") {
		t.Errorf("no warning: %v", res.Warnings)
	}
}

// The abnTeX2 fixture; skipped where abnTeX2 is not installed (Debian:
// texlive-publishers). Run with TEXMFHOME pointing at a local copy otherwise.
func TestMarkdownABNTProject(t *testing.T) {
	tools, engine := texTools(t)
	if out, err := exec.Command("kpsewhich", "abntex2.cls").Output(); err != nil || len(out) == 0 {
		t.Skip("abnTeX2 not installed")
	}
	res, err := Markdown(context.Background(), Options{
		SrcDir: "../../testdata/abntex2-project", MainFile: "main.tex", WorkDir: t.TempDir(), Tools: tools,
		Engine: engine, EngineEnv: testEngineEnv, Now: time.Date(2026, 1, 2, 0, 0, 0, 0, time.UTC),
	})
	if err != nil {
		t.Fatal(err)
	}
	md := string(res.Markdown)
	for _, want := range []string{
		"title: Estudo de Caso sobre Editores LaTeX", "- Fulana de Tal", "lang: pt-BR",
		"# Resumo", "Este trabalho investiga", "# Abstract",
		"# Lista de abreviaturas e siglas", "Associação Brasileira de Normas Técnicas",
		"Knuth (1984)",    // \citeonline → narrative
		"(Lamport, 1994)", // author-date
		"apud",            // \apud kept
		"> Uma citação",   // citacao → blockquote
		"media/tikz/figura-01.png", "Um diagrama simples", "Fonte: <span>Elaborado",
		"# Introdução", "# Conclusão", "# Questionário",
		"KNUTH, Donald E. Literate Programming. **The Computer Journal**, v. 27", // ABNT reference list
		"This work studies",
	} {
		if !strings.Contains(md, want) {
			t.Errorf("missing %q", want)
		}
	}
	for _, gone := range []string{"Ficha catalográfica", "english\n", "csl:", "bibliography:", "citeonline", "imprimircapa"} {
		if strings.Contains(md, gone) {
			t.Errorf("%q should not be in the output", gone)
		}
	}
	if t.Failed() {
		t.Logf("markdown:\n%s\nwarnings: %v", md, res.Warnings)
	}
}
