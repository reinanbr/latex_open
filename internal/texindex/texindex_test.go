package texindex

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestBuild(t *testing.T) {
	dir := t.TempDir()
	os.MkdirAll(filepath.Join(dir, "chap"), 0o755)
	os.WriteFile(filepath.Join(dir, "main.tex"), []byte(`\documentclass{article}
\newcommand{\R}{\mathbb{R}}
\newcommand\norm[1]{\lVert #1\rVert}
\DeclareMathOperator{\argmax}{arg\,max}
\NewDocumentCommand{\pair}{m m}{(#1,#2)}
\newenvironment{myproof}{}{}
\newtheorem{theorem}{Teorema}
% \label{commented}
\begin{document}
\section{A}\label{sec:a}
\end{document}
`), 0o644)
	os.WriteFile(filepath.Join(dir, "chap", "b.tex"), []byte("x\n\\begin{equation}\\label{eq:b} \\label{ eq:c }\\end{equation}\n"), 0o644)
	os.WriteFile(filepath.Join(dir, "refs.bib"), []byte(`@string{ieee = "IEEE"}
@Article{knuth1984,
  author = {Donald E. Knuth},
  title  = {Literate {P}rogramming},
  year   = 1984,
}
@book{lamport, title = "LaTeX", author="Lamport"}
@comment{ignored}
`), 0o644)
	idx, err := Build(dir)
	if err != nil {
		t.Fatal(err)
	}
	keys := []string{}
	for _, l := range idx.Labels {
		keys = append(keys, l.File+":"+l.Key)
	}
	want := []string{"chap/b.tex:eq:b", "chap/b.tex:eq:c", "main.tex:sec:a"}
	if len(keys) != 3 || keys[0] != want[0] || keys[1] != want[1] || keys[2] != want[2] {
		t.Errorf("labels = %v", keys)
	}
	if idx.Labels[2].Line != 10 {
		t.Errorf("label line = %d", idx.Labels[2].Line)
	}
	if len(idx.Citations) != 2 {
		t.Fatalf("citations = %+v", idx.Citations)
	}
	k := idx.Citations[0]
	if k.Key != "knuth1984" || k.Type != "article" || k.Title != "Literate Programming" || k.Author != "Donald E. Knuth" || k.Year != "1984" {
		t.Errorf("knuth = %+v", k)
	}
	if idx.Citations[1].Title != "LaTeX" || idx.Citations[1].Author != "Lamport" {
		t.Errorf("lamport = %+v", idx.Citations[1])
	}
	macros := map[string]int{}
	for _, m := range idx.Macros {
		macros[m.Name] = m.Args
	}
	if macros["R"] != 0 || macros["norm"] != 1 || macros["pair"] != 2 {
		t.Errorf("macros = %v", macros)
	}
	if _, ok := macros["argmax"]; !ok {
		t.Error("DeclareMathOperator missing")
	}
	if len(idx.Environments) != 2 || idx.Environments[0] != "myproof" || idx.Environments[1] != "theorem" {
		t.Errorf("envs = %v", idx.Environments)
	}
}

func TestBuildUsesAndDefinitions(t *testing.T) {
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, "main.tex"), []byte(`\documentclass[
  12pt, % tamanho
  a4paper
]{abntex2}
\usepackage[T1]{fontenc}
\usepackage{amsmath,
  graphicx} % \usepackage{commented}
\let\oldsection\section
\newif\ifdraft
\newcounter{passo}
\newlength{\gap}
\DeclarePairedDelimiter\abs{\lvert}{\rvert}
\newtcolorbox{caixa}{}
\newtcbtheorem{teo}{Teorema}{}{th}
\lstnewenvironment{codigo}{}{}
\newminted{python}{}
\newmintinline[py]{python}{}
\newlistof{listofquadros}{loq}{Lista de quadros}
\begin{document}
\end{document}
`), 0o644)
	os.WriteFile(filepath.Join(dir, "estilo.sty"), []byte("\\RequirePackage{xcolor}\n"), 0o644)
	idx, err := Build(dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(idx.Classes) != 1 || idx.Classes[0].Name != "abntex2" || idx.Classes[0].Options != "12pt, a4paper" || idx.Classes[0].Line != 1 {
		t.Errorf("classes = %+v", idx.Classes)
	}
	got := map[string]int{}
	for _, p := range idx.Packages {
		got[p.File+":"+p.Name] = p.Line
	}
	want := map[string]int{"main.tex:fontenc": 5, "main.tex:amsmath": 6, "main.tex:graphicx": 6, "estilo.sty:xcolor": 1}
	if len(got) != len(want) {
		t.Errorf("packages = %+v", idx.Packages)
	}
	for k, v := range want {
		if got[k] != v {
			t.Errorf("package %s at line %d, want %d (%+v)", k, got[k], v, idx.Packages)
		}
	}
	macros := map[string]bool{}
	for _, m := range idx.Macros {
		macros[m.Name] = true
	}
	for _, m := range []string{"oldsection", "ifdraft", "drafttrue", "draftfalse", "thepasso", "gap", "abs", "py", "listofquadros"} {
		if !macros[m] {
			t.Errorf("macro %s missing: %+v", m, idx.Macros)
		}
	}
	envs := strings.Join(idx.Environments, " ")
	for _, e := range []string{"caixa", "teo", "teo*", "codigo", "pythoncode"} {
		if !strings.Contains(" "+envs+" ", " "+e+" ") {
			t.Errorf("environment %s missing: %s", e, envs)
		}
	}
	if v := strings.Join(idx.VerbatimEnvironments, " "); v != "codigo pythoncode" {
		t.Errorf("verbatim environments = %q", v)
	}
	if idx.Dynamic {
		t.Error("no dynamic definitions here")
	}
	os.WriteFile(filepath.Join(dir, "x.tex"), []byte("\\expandafter\\def\\csname foo\\endcsname{}\n"), 0o644)
	if idx, _ := Build(dir); !idx.Dynamic {
		t.Error("\\csname definition not flagged")
	}
}

func TestParseTexcount(t *testing.T) {
	out := `Total
Words in text: 120
Words in headers: 7
Words outside text (captions, etc.): 5
Number of headers: 3
Number of floats/tables/figures: 1
Number of math inlines: 2
Number of math displayed: 1
`
	wc := ParseTexcount(out)
	if wc.Words != 120 || wc.Headers != 7 || wc.Captions != 5 || wc.Math != 3 {
		t.Errorf("wc = %+v", wc)
	}
}

func TestCountWordsReal(t *testing.T) {
	if _, err := exec.LookPath("texcount"); err != nil {
		t.Skip("texcount not installed")
	}
	wc, err := CountWords(context.Background(), "../../testdata/sample-project", "main.tex")
	if err != nil {
		t.Fatal(err)
	}
	// The sample has prose in main.tex and the included chapters.
	if wc.Words < 30 || wc.Headers == 0 {
		t.Errorf("unexpected count %+v", wc)
	}
}
