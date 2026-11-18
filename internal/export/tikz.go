package export

import (
	"context"
	_ "embed"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

var (
	reTikzBegin = regexp.MustCompile(`\\begin\s*\{tikzpicture\}`)
	reTikzEnd   = regexp.MustCompile(`\\end\s*\{tikzpicture\}`)
	reBeginDoc  = regexp.MustCompile(`\\begin\s*\{document\}`)
)

type span struct{ from, to int }

// tikzSpans finds top-level tikzpicture environments outside comments.
func tikzSpans(tex string) []span {
	var out []span
	pos := 0
	for {
		loc := reTikzBegin.FindStringIndex(tex[pos:])
		if loc == nil {
			return out
		}
		start := pos + loc[0]
		lineStart := strings.LastIndexByte(tex[:start], '\n') + 1
		if _, comment := splitComment(tex[lineStart:start]); comment != "" {
			pos = pos + loc[1]
			continue
		}
		end := reTikzEnd.FindStringIndex(tex[pos+loc[1]:])
		if end == nil {
			return out
		}
		stop := pos + loc[1] + end[1]
		out = append(out, span{start, stop})
		pos = stop
	}
}

// renderTikz compiles every tikzpicture of the document (with the
// document's own preamble, so colors, libraries and macros apply) to one
// cropped PDF page each via the preview package, converts the pages to PNG
// and replaces each environment with \includegraphics of its image.
//
// Pages and pictures are matched by order; if the counts disagree (a
// picture failed), nothing is substituted, to never attach the wrong image.
func (m *mediaCollector) renderTikz(ctx context.Context, tex string) string {
	spans := tikzSpans(tex)
	if len(spans) == 0 {
		return tex
	}
	placeholder := func(reason string) string {
		m.warn(fmt.Sprintf("%d figura(s) TikZ não foram convertidas: %s", len(spans), reason))
		return replaceSpans(tex, spans, func(int) string { return `\emph{[Figura TikZ não convertida]}` })
	}
	o := m.opts
	if o.Engine == "" {
		return placeholder("nenhum compilador LaTeX disponível")
	}
	if o.Tools.Pdftoppm == "" && o.Tools.Gs == "" {
		return placeholder("pdftoppm e gs não estão instalados")
	}
	doc := reBeginDoc.FindStringIndex(tex)
	if doc == nil {
		return placeholder("o documento não tem \\begin{document}")
	}

	dir := filepath.Join(o.WorkDir, "tikz")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return placeholder(err.Error())
	}
	var b strings.Builder
	b.WriteString(tex[:doc[0]])
	b.WriteString("\n\\usepackage[active,tightpage]{preview}\n\\PreviewEnvironment{tikzpicture}\n\\setlength\\PreviewBorder{6pt}\n\\pagestyle{empty}\n\\begin{document}\n")
	for _, s := range spans {
		b.WriteString(tex[s.from:s.to])
		b.WriteString("\n\n")
	}
	b.WriteString("\\end{document}\n")
	src := filepath.Join(dir, "tikz.tex")
	if err := os.WriteFile(src, []byte(b.String()), 0o644); err != nil {
		return placeholder(err.Error())
	}

	// Same restrictions as a normal compile; TEXMFOUTPUT lets openin_any=p
	// read the generated file from the scratch dir.
	args := append(append([]string{}, o.EngineEnv...), "TEXMFOUTPUT="+dir, o.Engine,
		"-interaction=nonstopmode", "-no-shell-escape", "-output-directory="+dir, src)
	cctx, cancel := context.WithTimeout(ctx, o.Timeout)
	defer cancel()
	_, _, _ = o.Run(cctx, o.SrcDir, nil, "env", args...)
	pdf := filepath.Join(dir, "tikz.pdf")
	if _, err := os.Stat(pdf); err != nil {
		if cctx.Err() != nil {
			return placeholder("tempo limite excedido")
		}
		return placeholder("a compilação das figuras falhou (veja se o documento compila)")
	}

	links := make([]string, len(spans))
	for i := range spans {
		rel := fmt.Sprintf("media/tikz/figura-%02d.png", i+1)
		out := filepath.Join(o.WorkDir, filepath.FromSlash(rel))
		if err := m.convertPage(ctx, pdf, i+1, out); err != nil {
			return placeholder(fmt.Sprintf("página %d: %v", i+1, err))
		}
		links[i] = rel
	}
	// One page too many means a picture produced extra output: unsafe to map.
	extra := filepath.Join(dir, "extra.png")
	if m.convertPage(ctx, pdf, len(spans)+1, extra) == nil {
		return placeholder("o número de páginas geradas não corresponde ao de figuras")
	}
	for _, l := range links {
		m.done[l] = l
		m.files[l] = filepath.Join(o.WorkDir, filepath.FromSlash(l))
	}
	return replaceSpans(tex, spans, func(i int) string { return `\includegraphics{` + links[i] + `}` })
}

func replaceSpans(tex string, spans []span, repl func(i int) string) string {
	var b strings.Builder
	last := 0
	for i, s := range spans {
		b.WriteString(tex[last:s.from])
		b.WriteString(repl(i))
		last = s.to
	}
	b.WriteString(tex[last:])
	return b.String()
}

// convertPage renders one PDF page to PNG at 200 dpi.
func (m *mediaCollector) convertPage(ctx context.Context, pdf string, page int, out string) error {
	if err := os.MkdirAll(filepath.Dir(out), 0o755); err != nil {
		return err
	}
	cctx, cancel := context.WithTimeout(ctx, convertTimout)
	defer cancel()
	t := m.opts.Tools
	p := fmt.Sprint(page)
	var err error
	if t.Pdftoppm != "" {
		_, _, err = m.opts.Run(cctx, m.opts.WorkDir, nil, t.Pdftoppm, "-png", "-r", "200", "-singlefile", "-f", p, "-l", p, pdf, strings.TrimSuffix(out, ".png"))
	} else {
		_, _, err = m.opts.Run(cctx, m.opts.WorkDir, nil, t.Gs, "-dSAFER", "-dBATCH", "-dNOPAUSE", "-dQUIET", "-sDEVICE=pngalpha", "-r200",
			"-dFirstPage="+p, "-dLastPage="+p, "-sOutputFile="+out, pdf)
	}
	if err != nil {
		return err
	}
	if fi, err := os.Stat(out); err != nil || fi.Size() == 0 {
		return fmt.Errorf("página inexistente")
	}
	return nil
}

// ABNT citation style (CSL), used for abnTeX2 documents.
//
//go:embed csl/associacao-brasileira-de-normas-tecnicas.csl
var abntCSL []byte
