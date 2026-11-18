package compiler

import (
	"os"
	"strconv"
	"strings"
	"testing"
)

func readFixture(t *testing.T, name string) string {
	t.Helper()
	b, err := os.ReadFile("testdata/" + name)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

var pm = PathMapper{SrcDir: "/data/projects/P/src", BuildDir: "/data/projects/P/build"}

type want struct {
	level, file string
	line        int
	msgContains string
}

func assertHas(t *testing.T, ps []Problem, w want) {
	t.Helper()
	for _, p := range ps {
		if p.Level == w.level && p.File == w.file && p.Line == w.line && strings.Contains(p.Message, w.msgContains) {
			return
		}
	}
	var sb strings.Builder
	for _, p := range ps {
		sb.WriteString("\n  " + p.Level + " " + p.File + ":" + strconv.Itoa(p.Line) + " " + p.Message)
	}
	t.Errorf("missing problem %+v; got:%s", w, sb.String())
}

func TestParseErrorsLog(t *testing.T) {
	ps := ParseTeXLog(readFixture(t, "errors.log"), pm, "main.tex")
	for _, w := range []want{
		{"error", "chapters/bad.tex", 2, "Undefined control sequence"},
		{"error", "main.tex", 7, "File ended while scanning use of \\textbf"},
		{"error", "main.tex", 8, "Undefined control sequence"},
		{"error", "main.tex", 12, `\begin{itemize} on input line 10 ended by \end{enumerate}`},
		{"warning", "main.tex", 6, "Reference `sec:nao-existe' on page 1 undefined"},
		{"warning", "main.tex", 6, "Citation `ghost2020' on page 1 undefined"},
		{"warning", "main.tex", 0, "There were undefined references"},
		{"typesetting", "main.tex", 9, "Overfull \\hbox (239.09506pt too wide)"},
		// Errors inside the generated .bbl are reported without a source file.
		{"error", "", 1, "Missing $ inserted"},
	} {
		assertHas(t, ps, w)
	}
	// The error raw text includes the l.N context but not the next error.
	for _, p := range ps {
		if p.File == "chapters/bad.tex" {
			if !strings.Contains(p.Raw, "l.2 \\undefinedincapitulo") || strings.Contains(p.Raw, "main.tex:7") {
				t.Errorf("unexpected raw block:\n%s", p.Raw)
			}
		}
		if p.Level == "" || p.Message == "" {
			t.Errorf("incomplete problem %+v", p)
		}
	}
	// Font info lines are not warnings.
	for _, p := range ps {
		if strings.Contains(p.Message, "External font") {
			t.Errorf("info reported as problem: %+v", p)
		}
	}
}

func TestParseCleanLog(t *testing.T) {
	ps := ParseTeXLog(readFixture(t, "sample-ok.log"), pm, "main.tex")
	for _, p := range ps {
		if p.Level == "error" {
			t.Errorf("unexpected error in clean log: %+v", p)
		}
	}
}

func TestParseBibTeX(t *testing.T) {
	ps := ParseBibLog(readFixture(t, "errors.blg"), pm)
	assertHas(t, ps, want{"error", "refs.bib", 3, "I was expecting a `,' or a `}'"})
	assertHas(t, ps, want{"warning", "", 0, `I didn't find a database entry for "ghost2020"`})
}

func TestParseBiber(t *testing.T) {
	ps := ParseBibLog(readFixture(t, "biber.blg"), pm)
	assertHas(t, ps, want{"error", "refs.bib", 7, "syntax error"})
	tex := ParseTeXLog(readFixture(t, "biber.log"), pm, "main.tex")
	assertHas(t, tex, want{"warning", "main.tex", 5, "Citation 'missingkey' on page 1 undefined"})
}

func TestSyntheticCases(t *testing.T) {
	log := strings.Join([]string{
		"(./main.tex (/usr/share/texlive/texmf-dist/tex/latex/base/article.cls",
		"Document Class: article",
		") (./chapters/intro.tex",
		"Package natbib Warning: Citation `x' on page 2 undefined on input line 14.",
		"",
		"Package hyperref Warning: Token not allowed in a PDF string (Unicode):",
		"(hyperref)                removing `math shift' on input line 20.",
		"",
		"Underfull \\hbox (badness 10000) in paragraph at lines 30--31",
		"[]\\OT1/cmr/m/n/10 text with ( unbalanced paren",
		"",
		")",
		"! Undefined control sequence.",
		"l.42 \\foo",
		"",
		"LaTeX Font Warning: Font shape `OT1/cmr/bx/sc' undefined",
		"(Font)              using `OT1/cmr/bx/n' instead on input line 50.",
		"",
		"Class beamer Warning: Something odd.",
		")",
	}, "\n")
	ps := ParseTeXLog(log, pm, "main.tex")
	assertHas(t, ps, want{"warning", "chapters/intro.tex", 14, "natbib: Citation `x' on page 2 undefined"})
	assertHas(t, ps, want{"warning", "chapters/intro.tex", 20, "hyperref: Token not allowed in a PDF string (Unicode): removing `math shift'"})
	assertHas(t, ps, want{"typesetting", "chapters/intro.tex", 30, "Underfull \\hbox (badness 10000)"})
	// After intro.tex closed, we are back in main.tex despite the "(" in box text.
	assertHas(t, ps, want{"error", "main.tex", 42, "Undefined control sequence"})
	assertHas(t, ps, want{"warning", "main.tex", 50, "Font shape `OT1/cmr/bx/sc' undefined using"})
	assertHas(t, ps, want{"warning", "main.tex", 0, "beamer: Something odd."})

	// Tool chatter that merely contains "file.lua:70:" is not a source error.
	lua := ParseTeXLog(`luaotfload | load :     × "...luaotfload-multiscript.lua:70: attempt to index a nil value (local 'f')".`, pm, "main.tex")
	for _, p := range lua {
		if p.File != "" && p.File != "main.tex" {
			t.Errorf("tool output parsed as source location: %+v", p)
		}
	}
}

func TestCompileEnv(t *testing.T) {
	has := func(env []string, kv string) bool {
		for _, e := range env {
			if e == kv {
				return true
			}
		}
		return false
	}
	for _, eng := range []string{"pdflatex", "xelatex"} {
		if env := CompileEnv(eng); !has(env, "openin_any=p") || !has(env, "openout_any=p") || !has(env, "shell_escape=f") {
			t.Errorf("%s env not paranoid", eng)
		}
	}
	if env := CompileEnv("lualatex"); !has(env, "openin_any=r") || !has(env, "shell_escape=f") {
		t.Error("lualatex env")
	}
}

func TestPathMapper(t *testing.T) {
	for in, out := range map[string]string{
		"./main.tex":                         "main.tex",
		"chapters/a.tex":                     "chapters/a.tex",
		"/data/projects/P/src/x/y.tex":       "x/y.tex",
		"/data/projects/P/build/main.bbl":    "",
		"/usr/share/texlive/tex/latex/a.sty": "",
		"../outside.tex":                     "",
	} {
		if got := pm.Rel(in); got != out {
			t.Errorf("Rel(%q) = %q, want %q", in, got, out)
		}
	}
}

func TestSortProblems(t *testing.T) {
	ps := SortProblems([]Problem{{Level: "typesetting"}, {Level: "warning", Message: "a"}, {Level: "error"}, {Level: "warning", Message: "b"}})
	got := []string{}
	for _, p := range ps {
		got = append(got, p.Level+p.Message)
	}
	if strings.Join(got, ",") != "error,warninga,warningb,typesetting" {
		t.Errorf("order: %v", got)
	}
}

func TestDumpFixture(t *testing.T) {
	if os.Getenv("DUMP") == "" {
		t.Skip()
	}
	for _, p := range SortProblems(append(ParseTeXLog(readFixture(t, "errors.log"), pm, "main.tex"), ParseBibLog(readFixture(t, "errors.blg"), pm)...)) {
		t.Logf("%-11s %-18s %3d  %s", p.Level, p.File, p.Line, p.Message)
	}
}

func TestPostProcess(t *testing.T) {
	ps := PostProcess([]Problem{
		{Level: "warning", Message: "epstopdf: Shell escape feature is not enabled."},
		{Level: "error", Message: "File `fig-eps-converted-to.pdf' not found."},
		{Level: "warning", Message: "keep me"},
	})
	if len(ps) != 2 || !strings.Contains(ps[0].Message, "converta-as para PDF") || ps[1].Message != "keep me" {
		t.Errorf("PostProcess = %+v", ps)
	}
}

func TestMissingFileHint(t *testing.T) {
	ps := PostProcess([]Problem{
		{Level: "error", Message: "File `abntex2.cls' not found."},
		{Level: "error", Message: "I couldn't open style file abntex2-alf.bst"},
		{Level: "error", Message: "File `foo.sty' not found."},
		{Level: "error", Message: "File `chapters/x.tex' not found."},
		{Level: "error", Message: "BibTeX: I couldn't open database file abntex2-options.bib"},
		{Level: "error", Message: "BibTeX: I couldn't open database file refs.bib"},
	})
	if !strings.Contains(ps[0].Message, "texlive-publishers") || !strings.Contains(ps[1].Message, "texlive-publishers") {
		t.Errorf("abntex2 hints: %q / %q", ps[0].Message, ps[1].Message)
	}
	if !strings.Contains(ps[2].Message, "apt-file search foo.sty") {
		t.Errorf("generic hint: %q", ps[2].Message)
	}
	if ps[3].Message != "File `chapters/x.tex' not found." {
		t.Errorf("tex file must not get a package hint: %q", ps[3].Message)
	}
	if !strings.Contains(ps[4].Message, "texlive-publishers") || strings.Contains(ps[5].Message, " — ") {
		t.Errorf("bib hints: %q / %q", ps[4].Message, ps[5].Message)
	}
}

func TestDVIFigureHints(t *testing.T) {
	ps := dviFigureHints([]Problem{
		{Level: "error", Message: "File `figures/sample' not found."},
		{Level: "error", Message: "Unknown graphics extension: .png."},
		{Level: "error", Message: "File `chapters/x.tex' not found."},
	})
	if !strings.Contains(ps[0].Message, "EPS") || !strings.Contains(ps[1].Message, "EPS") || strings.Contains(ps[2].Message, "EPS") {
		t.Errorf("%q / %q / %q", ps[0].Message, ps[1].Message, ps[2].Message)
	}
}
