package compiler

import (
	"path"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
)

// Problem is one structured diagnostic extracted from the logs.
type Problem struct {
	Level string `json:"level"`          // "error" | "warning" | "typesetting"
	File  string `json:"file,omitempty"` // project-relative; empty when not in src/
	Line  int    `json:"line,omitempty"`
	// Source names the file when it is not a project source (e.g. the
	// generated "main.bbl" or a package such as "hyperref.sty").
	Source  string `json:"source,omitempty"`
	Message string `json:"message"`
	Raw     string `json:"raw"`
}

// PathMapper turns paths found in logs into project-relative paths.
type PathMapper struct {
	SrcDir   string // absolute
	BuildDir string // absolute
}

// Rel maps a log path to a project-relative path, or "" when the file is
// not part of the user's sources (TeX distribution files, generated files).
func (pm PathMapper) Rel(p string) string {
	p = strings.TrimSpace(p)
	p = strings.Trim(p, `"`)
	if p == "" {
		return ""
	}
	if filepath.IsAbs(p) {
		if pm.SrcDir != "" {
			if r, err := filepath.Rel(pm.SrcDir, p); err == nil && !strings.HasPrefix(r, "..") {
				return filepath.ToSlash(r)
			}
		}
		return ""
	}
	p = strings.TrimPrefix(filepath.ToSlash(filepath.Clean(p)), "./")
	if strings.HasPrefix(p, "../") {
		return ""
	}
	return p
}

var (
	reFileLineError = regexp.MustCompile(`^(.*?\.[A-Za-z0-9]+):(\d+): (.*)$`)
	reBangError     = regexp.MustCompile(`^! (.*)$`)
	reContextLine   = regexp.MustCompile(`^l\.(\d+) `)
	reWarning       = regexp.MustCompile(`^(?:(LaTeX(?: Font)?)|Package ([\w.-]+)|Class ([\w.-]+)|Module ([\w.-]+)) (Warning|Info): (.*)$`)
	reInputLine     = regexp.MustCompile(`on input line (\d+)`)
	reBadBox        = regexp.MustCompile(`^(Overfull|Underfull|Tight|Loose) \\[hv]box .*?(?:lines? (\d+)(?:--\d+)?|detected at line (\d+)|while \\output is active)`)
	rePdfTeXWarning = regexp.MustCompile(`^(?:pdfTeX|LuaTeX|XeTeX) warning(?: \(.*?\))?: (.*)$`)
	reMissingChar   = regexp.MustCompile(`^Missing character: `)
)

// ParseTeXLog extracts problems from a (pdf|xe|lua)latex .log file produced
// with -file-line-error and max_print_line large enough to avoid wrapping.
func ParseTeXLog(log string, pm PathMapper, mainFile string) []Problem {
	lines := strings.Split(strings.ReplaceAll(log, "\r\n", "\n"), "\n")
	var out []Problem
	var stack []string // file names ("" for non-file parens)

	current := func() string {
		for i := len(stack) - 1; i >= 0; i-- {
			if stack[i] != "" {
				return pm.Rel(stack[i])
			}
		}
		return mainFile
	}

	// errorBlock collects an error's context until the help text ends.
	errorBlock := func(start int) (end int, ctxLine int) {
		end = start + 1
		sawContext := false
		for end < len(lines) && end < start+40 {
			l := lines[end]
			if m := reContextLine.FindStringSubmatch(l); m != nil && !sawContext {
				ctxLine, _ = strconv.Atoi(m[1])
				sawContext = true
			}
			// The block ends at the first blank line after the l.N context,
			// or at the next diagnostic.
			if sawContext && strings.TrimSpace(l) == "" {
				break
			}
			if !sawContext && end > start+1 && (reFileLineError.MatchString(l) || reBangError.MatchString(l)) {
				break
			}
			end++
		}
		return end, ctxLine
	}

	for i := 0; i < len(lines); i++ {
		line := lines[i]

		if m := reFileLineError.FindStringSubmatch(line); m != nil && looksLikeErrorPath(m[1]) {
			n, _ := strconv.Atoi(m[2])
			end, _ := errorBlock(i)
			p := Problem{
				Level: "error", File: pm.Rel(m[1]), Line: n,
				Message: cleanMessage(m[3]), Raw: strings.Join(lines[i:min(end, len(lines))], "\n"),
			}
			if p.File == "" {
				p.Source = filepath.Base(m[1])
			}
			out = append(out, p)
			i = end - 1
			continue
		}

		if m := reBangError.FindStringSubmatch(line); m != nil {
			end, ctx := errorBlock(i)
			out = append(out, Problem{
				Level: "error", File: current(), Line: ctx,
				Message: cleanMessage(m[1]), Raw: strings.Join(lines[i:min(end, len(lines))], "\n"),
			})
			i = end - 1
			continue
		}

		if m := reWarning.FindStringSubmatch(line); m != nil {
			src := firstNonEmpty(m[1], m[2], m[3], m[4])
			kind := m[5]
			// Continuation lines are prefixed with "(<package>)" + spaces.
			raw := []string{line}
			msg := m[6]
			prefix := "(" + src + ")"
			if m[1] == "LaTeX Font" {
				prefix = "(Font)"
			}
			j := i + 1
			for j < len(lines) && strings.HasPrefix(lines[j], prefix) {
				raw = append(raw, lines[j])
				msg += " " + strings.TrimSpace(strings.TrimPrefix(lines[j], prefix))
				j++
			}
			i = j - 1
			if kind == "Info" {
				continue
			}
			p := Problem{Level: "warning", File: current(), Message: cleanMessage(msg), Raw: strings.Join(raw, "\n")}
			if mm := reInputLine.FindStringSubmatch(msg); mm != nil {
				p.Line, _ = strconv.Atoi(mm[1])
			}
			if m[2] != "" || m[3] != "" {
				p.Message = src + ": " + p.Message
			}
			out = append(out, p)
			continue
		}

		if m := reBadBox.FindStringSubmatch(line); m != nil {
			p := Problem{Level: "typesetting", File: current(), Message: strings.TrimSpace(line), Raw: line}
			if m[2] != "" {
				p.Line, _ = strconv.Atoi(m[2])
			} else if m[3] != "" {
				p.Line, _ = strconv.Atoi(m[3])
			}
			// Skip the box contents (document text) up to the blank line.
			j := i + 1
			for j < len(lines) && strings.TrimSpace(lines[j]) != "" && j < i+30 {
				j++
			}
			p.Raw = strings.Join(lines[i:j], "\n")
			out = append(out, p)
			i = j - 1
			continue
		}

		if m := rePdfTeXWarning.FindStringSubmatch(line); m != nil {
			out = append(out, Problem{Level: "warning", File: current(), Message: cleanMessage(m[1]), Raw: line})
			continue
		}

		if reMissingChar.MatchString(line) {
			continue
		}

		stack = trackParens(line, stack)
	}
	return dedupe(out)
}

// trackParens updates the open-file stack: "(" followed by a path pushes it,
// any other "(" pushes a placeholder, ")" pops.
func trackParens(line string, stack []string) []string {
	for i := 0; i < len(line); i++ {
		switch line[i] {
		case '(':
			rest := line[i+1:]
			end := strings.IndexAny(rest, " ()\t\"")
			if end < 0 {
				end = len(rest)
			}
			tok := rest[:end]
			if looksLikePath(tok) {
				stack = append(stack, tok)
				i += end
			} else {
				stack = append(stack, "")
			}
		case ')':
			if len(stack) > 0 {
				stack = stack[:len(stack)-1]
			}
		}
	}
	return stack
}

func looksLikePath(s string) bool {
	if s == "" || strings.ContainsAny(s, "{}\\`'") {
		return false
	}
	if strings.HasPrefix(s, "./") || strings.HasPrefix(s, "/") || strings.HasPrefix(s, "../") {
		return true
	}
	ext := filepath.Ext(s)
	return len(ext) >= 2 && len(ext) <= 12 && !strings.ContainsAny(ext, ",;:")
}

// looksLikeErrorPath is stricter than looksLikePath: the prefix of a
// file:line:error message must be a plain path (luaotfload and friends print
// "pkg | stage : … file.lua:70: …" lines that must not be taken as sources).
func looksLikeErrorPath(s string) bool {
	if strings.ContainsAny(s, "\"|×<>") || strings.Contains(s, " : ") {
		return false
	}
	return looksLikePath(s)
}

func cleanMessage(s string) string {
	s = strings.TrimSpace(s)
	s = strings.TrimPrefix(s, "LaTeX Error: ")
	return s
}

func firstNonEmpty(ss ...string) string {
	for _, s := range ss {
		if s != "" {
			return s
		}
	}
	return ""
}

func dedupe(ps []Problem) []Problem {
	seen := map[string]bool{}
	out := ps[:0]
	for _, p := range ps {
		k := p.Level + "\x00" + p.File + "\x00" + strconv.Itoa(p.Line) + "\x00" + p.Message
		if seen[k] {
			continue
		}
		seen[k] = true
		out = append(out, p)
	}
	return out
}

var (
	reBibExpecting = regexp.MustCompile(`^(I was expecting .*?|I'm skipping .*?|.*?)---line (\d+) of file (\S+)`)
	reBibOpen      = regexp.MustCompile(`^I couldn't open (?:database|style|auxiliary) file (\S+)`)
	reBibFound     = regexp.MustCompile(`^I found no (\\\w+) command`)
	reBibWarning   = regexp.MustCompile(`^Warning--(.*)$`)
	reBibWarnLoc   = regexp.MustCompile(`^--line (\d+) of file (\S+)`)
	reBiberMsg     = regexp.MustCompile(`^\[\d+\] [\w.:]+> (ERROR|WARN) - (.*)$`)
	reBiberSource  = regexp.MustCompile(`INFO - Found BibTeX data source '([^']+)'`)
	reBiberLine    = regexp.MustCompile(`, line (\d+),`)
)

// ParseBibLog extracts problems from a BibTeX or Biber .blg file.
func ParseBibLog(blg string, pm PathMapper) []Problem {
	lines := strings.Split(strings.ReplaceAll(blg, "\r\n", "\n"), "\n")
	var out []Problem
	var sources []string
	for _, l := range lines {
		if m := reBiberSource.FindStringSubmatch(l); m != nil {
			sources = append(sources, m[1])
		}
	}
	for i := 0; i < len(lines); i++ {
		l := lines[i]
		if m := reBiberMsg.FindStringSubmatch(l); m != nil {
			p := Problem{Level: "warning", Message: "Biber: " + m[2], Raw: l}
			if m[1] == "ERROR" {
				p.Level = "error"
			}
			if strings.Contains(m[2], "BibTeX subsystem") && len(sources) == 1 {
				p.File = pm.Rel(sources[0])
				if lm := reBiberLine.FindStringSubmatch(m[2]); lm != nil {
					p.Line, _ = strconv.Atoi(lm[1])
				}
			}
			out = append(out, p)
			continue
		}
		if m := reBibExpecting.FindStringSubmatch(l); m != nil {
			n, _ := strconv.Atoi(m[2])
			raw := []string{l}
			for j := i + 1; j < len(lines) && j < i+4 && strings.HasPrefix(lines[j], " :"); j++ {
				raw = append(raw, lines[j])
			}
			out = append(out, Problem{Level: "error", File: pm.Rel(m[3]), Line: n, Message: "BibTeX: " + strings.TrimSpace(m[1]), Raw: strings.Join(raw, "\n")})
			continue
		}
		if m := reBibOpen.FindStringSubmatch(l); m != nil {
			out = append(out, Problem{Level: "error", File: pm.Rel(m[1]), Message: "BibTeX: " + l, Raw: l})
			continue
		}
		if m := reBibFound.FindStringSubmatch(l); m != nil {
			out = append(out, Problem{Level: "error", Message: "BibTeX: " + l, Raw: l})
			continue
		}
		if m := reBibWarning.FindStringSubmatch(l); m != nil {
			p := Problem{Level: "warning", Message: "BibTeX: " + m[1], Raw: l}
			if i+1 < len(lines) {
				if lm := reBibWarnLoc.FindStringSubmatch(lines[i+1]); lm != nil {
					p.Line, _ = strconv.Atoi(lm[1])
					p.File = pm.Rel(lm[2])
					p.Raw += "\n" + lines[i+1]
					i++
				}
			}
			out = append(out, p)
		}
	}
	return dedupe(out)
}

// SortProblems orders errors first, then warnings, then typesetting, keeping
// log order within each level.
func SortProblems(ps []Problem) []Problem {
	rank := map[string]int{"error": 0, "warning": 1, "typesetting": 2}
	out := make([]Problem, 0, len(ps))
	for r := 0; r <= 2; r++ {
		for _, p := range ps {
			if rank[p.Level] == r {
				out = append(out, p)
			}
		}
	}
	return out
}

// PostProcess removes expected noise caused by texdesk's own policy and adds
// actionable hints.
func PostProcess(ps []Problem) []Problem {
	out := ps[:0]
	for _, p := range ps {
		// Shell escape is always disabled on purpose; epstopdf announces it on
		// every run that loads graphicx. Real EPS failures surface below.
		if strings.Contains(p.Message, "Shell escape feature is not enabled") {
			continue
		}
		if h := missingFileHint(p.Message); h != "" && !strings.Contains(p.Message, " — ") {
			p.Message += " — " + h
		}
		if strings.Contains(p.Message, "-eps-converted-to.pdf") {
			p.Message += " — figuras EPS não são convertidas automaticamente (shell-escape desativado por segurança); converta-as para PDF (ex.: epstopdf figura.eps) e envie o .pdf"
		}
		out = append(out, p)
	}
	return out
}

var reUnknownGraphicsExt = regexp.MustCompile(`Unknown graphics extension: \.(png|jpe?g|pdf|gif)`)

// dviFigureHints explains missing figures in DVI mode (the "latex"
// compiler), where graphicx only takes EPS: \includegraphics{fig} looks for
// fig.eps, and fig.png is refused.
func dviFigureHints(ps []Problem) []Problem {
	const hint = "no compilador LaTeX (DVI → PDF) as figuras precisam estar em EPS; para PNG, JPG ou PDF use o pdfLaTeX (Configurações de compilação)"
	for i, p := range ps {
		if strings.Contains(p.Message, " — ") {
			continue
		}
		if m := reMissingFile.FindStringSubmatch(p.Message); m != nil {
			switch strings.ToLower(path.Ext(m[1])) {
			case "", ".eps", ".ps", ".png", ".jpg", ".jpeg", ".pdf":
				ps[i].Message += " — " + hint
			}
		} else if reUnknownGraphicsExt.MatchString(p.Message) {
			ps[i].Message += " — " + hint
		}
	}
	return ps
}

var (
	reMissingFile  = regexp.MustCompile("File `([^']+)' not found")
	reMissingStyle = regexp.MustCompile(`couldn't open (?:style|database) file (\S+)`)
)

// Packages whose files are commonly missing from smaller TeX installations.
var knownPackages = []struct{ prefix, hint string }{
	{"abntex2", "o abnTeX2 não está instalado no servidor: no Debian/Ubuntu instale texlive-publishers (sudo apt install texlive-publishers); no TeX Live, tlmgr install abntex2"},
	{"preview.sty", "instale o pacote preview (Debian/Ubuntu: preview-latex-style; TeX Live: tlmgr install preview)"},
	{"minted", "o minted precisa de shell-escape, que o texdesk mantém desativado por segurança; use o pacote listings"},
	{"siunitx", "instale texlive-science (Debian/Ubuntu) ou tlmgr install siunitx"},
	{"biblatex-abnt", "instale texlive-bibtex-extra (Debian/Ubuntu) ou tlmgr install biblatex-abnt"},
}

// missingFileHint explains how to install a class/package/style that TeX
// or BibTeX could not find.
func missingFileHint(msg string) string {
	var file string
	if m := reMissingFile.FindStringSubmatch(msg); m != nil {
		file = m[1]
	} else if m := reMissingStyle.FindStringSubmatch(msg); m != nil {
		file = m[1]
	} else {
		return ""
	}
	for _, k := range knownPackages {
		if strings.HasPrefix(file, k.prefix) {
			return k.hint
		}
	}
	switch path.Ext(file) {
	case ".cls", ".sty", ".bst", ".cfg", ".def", ".clo", ".bbx", ".cbx", ".lbx":
	default:
		return "" // the project's own \input, figure or .bib: the message says it
	}
	return "este arquivo não está instalado no TeX do servidor; descubra o pacote com apt-file search " + file +
		" (Debian/Ubuntu) ou tlmgr search --global --file /" + file + " (TeX Live) e instale-o"
}
