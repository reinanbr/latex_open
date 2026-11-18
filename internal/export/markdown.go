// Package export converts projects to other formats. Markdown goes through
// pandoc (LaTeX → GitHub-flavored Markdown).
//
// Security: pandoc follows \input/\include and reads images from anywhere the
// server user can read. To keep a malicious project from pulling in files
// outside its src/ directory, texdesk
//   - flattens \input/\include/\subfile itself, resolving paths inside src/;
//   - runs pandoc with --sandbox (no file access besides its arguments);
//   - collects images itself (instead of pandoc's --extract-media), again
//     resolving them inside src/, converting PDF/EPS to PNG.
package export

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"html"
	"io"
	"os"
	"os/exec"
	"path"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"

	"texdesk/internal/project"
	"texdesk/internal/sandbox"
)

// Tools holds the executable paths; empty means "not installed".
type Tools struct {
	Pandoc   string
	Pdftoppm string
	Gs       string
}

type Options struct {
	SrcDir   string
	MainFile string // relative to SrcDir
	WorkDir  string // empty scratch directory for converted media
	Tools    Tools
	Timeout  time.Duration // for pandoc; image conversions get their own limit
	Now      time.Time     // replaces \today (pandoc's sandbox has no clock)
	// Engine (pdflatex/xelatex/lualatex) used to render TikZ figures, with
	// the VAR=value restrictions of a normal compile; empty = no rendering.
	Engine    string
	EngineEnv []string
	Run       Runner // nil = exec
}

// Result of a Markdown export.
type Result struct {
	Markdown []byte
	// Media maps the path inside the export ("media/figures/a.png") to the
	// file on disk (in WorkDir).
	Media    map[string]string
	Warnings []string
}

// Runner runs a command; replaceable in tests.
type Runner func(ctx context.Context, dir string, stdin []byte, name string, args ...string) (stdout, stderr []byte, err error)

func execRunner(ctx context.Context, dir string, stdin []byte, name string, args ...string) ([]byte, []byte, error) {
	cmd := exec.CommandContext(ctx, name, args...)
	cmd.Dir = dir
	cmd.Env = append(os.Environ(), "LC_ALL=C.UTF-8")
	if stdin != nil {
		cmd.Stdin = bytes.NewReader(stdin)
	}
	var out, errb bytes.Buffer
	cmd.Stdout = &limitedBuffer{buf: &out, max: 64 << 20}
	cmd.Stderr = &limitedBuffer{buf: &errb, max: 1 << 20}
	cmd.WaitDelay = 3 * time.Second
	err := cmd.Run()
	return out.Bytes(), errb.Bytes(), err
}

type limitedBuffer struct {
	buf *bytes.Buffer
	max int
}

func (l *limitedBuffer) Write(p []byte) (int, error) {
	if room := l.max - l.buf.Len(); room > 0 {
		if len(p) > room {
			l.buf.Write(p[:room])
		} else {
			l.buf.Write(p)
		}
	}
	return len(p), nil
}

// ErrPandocMissing is returned when pandoc is not installed.
var ErrPandocMissing = errors.New("pandoc não está instalado")

const (
	maxWarnings   = 25
	maxImages     = 500
	convertTimout = 30 * time.Second
)

// Markdown converts the project to GitHub-flavored Markdown.
func Markdown(ctx context.Context, o Options) (*Result, error) {
	if o.Tools.Pandoc == "" {
		return nil, ErrPandocMissing
	}
	if o.Run == nil {
		// pandoc, pdftoppm and gs see the sources (read-only) and the
		// scratch directory, nothing else.
		pol := sandbox.Policy{RO: []string{o.SrcDir}, RW: []string{o.WorkDir}}
		o.Run = func(ctx context.Context, dir string, stdin []byte, name string, args ...string) ([]byte, []byte, error) {
			argv := sandbox.Wrap(append([]string{name}, args...), pol)
			// Temporary files (gs) go to the scratch dir, the only writable one.
			argv = append([]string{"env", "TMPDIR=" + o.WorkDir}, argv...)
			return execRunner(ctx, dir, stdin, argv[0], argv[1:]...)
		}
	}
	if o.Timeout <= 0 {
		o.Timeout = 60 * time.Second
	}
	if o.Now.IsZero() {
		o.Now = time.Now()
	}
	w := &warnings{}

	tex, err := Flatten(o.SrcDir, o.MainFile, w.add)
	if err != nil {
		return nil, err
	}
	tex = reToday.ReplaceAllString(tex, o.Now.Format("2006-01-02"))
	code := stripComments(tex)
	prof := detectProfile(code)
	m := &mediaCollector{opts: o, warn: w.add, done: map[string]string{}, files: map[string]string{}, graphicsPath: graphicsPaths(code)}

	// TikZ first: it needs the original preamble.
	tex = m.renderTikz(ctx, tex)
	if prof.ABNT {
		tex = abntPreprocess(tex)
	}
	tex = unwrapLanguageEnvs(tex)

	args := []string{"--sandbox", "-f", "latex", "-t", "gfm", "-s", "--wrap=preserve"}
	if prof.Lang != "" {
		// Language of generated terms (citeproc: "et al.", "In:", "p.").
		args = append(args, "-M", "lang="+prof.Lang)
	}
	bibs := bibFiles(code, o.SrcDir, w.add)
	if len(bibs) > 0 {
		args = append(args, "--citeproc")
		for _, b := range bibs {
			args = append(args, "--bibliography="+b)
		}
		if prof.ABNT {
			csl := filepath.Join(o.WorkDir, "abnt.csl")
			if err := os.WriteFile(csl, abntCSL, 0o644); err == nil {
				args = append(args, "--csl="+csl)
			}
		}
	} else if reCite.MatchString(code) {
		w.add("o documento tem citações, mas nenhum arquivo .bib foi encontrado; elas ficarão vazias")
	}

	pctx, cancel := context.WithTimeout(ctx, o.Timeout)
	defer cancel()
	out, stderr, err := o.Run(pctx, o.SrcDir, []byte(tex), o.Tools.Pandoc, args...)
	if pctx.Err() != nil {
		return nil, fmt.Errorf("pandoc excedeu o tempo limite (%s)", o.Timeout)
	}
	if err != nil {
		return nil, fmt.Errorf("pandoc falhou: %s", firstLines(string(stderr), 5))
	}
	for _, msg := range PandocWarnings(string(stderr)) {
		w.add("pandoc: " + msg)
	}
	md := dropFrontMatterBibliography(string(out))
	md = m.rewrite(ctx, md)

	return &Result{Markdown: []byte(md), Media: m.files, Warnings: w.list}, nil
}

// ------------------------------------------------------------- warnings

type warnings struct {
	list []string
	seen map[string]bool
}

func (w *warnings) add(msg string) {
	if w.seen == nil {
		w.seen = map[string]bool{}
	}
	if w.seen[msg] {
		return
	}
	w.seen[msg] = true
	if len(w.list) == maxWarnings {
		w.list = append(w.list, "(mais avisos omitidos)")
	}
	if len(w.list) > maxWarnings {
		return
	}
	if len(msg) > 240 {
		msg = msg[:240] + "…"
	}
	w.list = append(w.list, msg)
}

// PandocWarnings extracts "[WARNING]" messages (with their continuation
// lines), dropping noise caused by the sandbox (translation data files).
func PandocWarnings(stderr string) []string {
	var out []string
	var cur []string
	flush := func() {
		if len(cur) == 0 {
			return
		}
		msg := strings.Join(cur, " ")
		cur = nil
		if strings.Contains(msg, "translation") {
			return
		}
		out = append(out, msg)
	}
	for _, line := range strings.Split(stderr, "\n") {
		switch {
		case strings.HasPrefix(line, "[WARNING]"):
			flush()
			cur = []string{strings.TrimSpace(strings.TrimPrefix(line, "[WARNING]"))}
		case cur != nil && strings.HasPrefix(line, " "):
			cur = append(cur, strings.TrimSpace(line))
		default:
			flush()
		}
	}
	flush()
	return out
}

func firstLines(s string, n int) string {
	lines := strings.Split(strings.TrimSpace(s), "\n")
	if len(lines) > n {
		lines = lines[:n]
	}
	if len(lines) == 0 || lines[0] == "" {
		return "erro desconhecido"
	}
	return strings.Join(lines, " ")
}

// ------------------------------------------------------------ flattening

var (
	reInclude = regexp.MustCompile(`\\(input|include|subfile)\b(?:\s*\{([^{}]*)\}|\s+([^\s{}\\%]+))`)
	reToday   = regexp.MustCompile(`\\today\b`)
	reVerbBeg = regexp.MustCompile(`\\begin\s*\{(verbatim\*?|Verbatim|lstlisting|minted|comment)\}`)
	reCite    = regexp.MustCompile(`\\[a-zA-Z]*cite[a-zA-Z]*\*?\s*[\[{]`)
	reBib     = regexp.MustCompile(`\\(?:bibliography|addbibresource)\s*(?:\[[^\]]*\])?\s*\{([^{}]+)\}`)
	reGPath   = regexp.MustCompile(`\\graphicspath\s*\{((?:\s*\{[^{}]*\})+)\s*\}`)
	reGDir    = regexp.MustCompile(`\{([^{}]*)\}`)
	reDocBody = regexp.MustCompile(`(?s)\\begin\s*\{document\}(.*)\\end\s*\{document\}`)
)

const (
	maxDepth     = 20
	maxFlatBytes = 32 << 20
)

// Flatten inlines \input, \include and \subfile starting at mainFile. Every
// path is resolved inside srcDir; anything else is dropped with a warning.
func Flatten(srcDir, mainFile string, warn func(string)) (string, error) {
	f := &flattener{src: srcDir, warn: warn}
	text, err := f.file(mainFile, 0)
	if err != nil {
		return "", err
	}
	return text, nil
}

type flattener struct {
	src   string
	warn  func(string)
	stack []string
	size  int
}

func (f *flattener) read(rel string) (string, string, error) {
	abs, err := project.ResolveIn(f.src, rel)
	if err != nil {
		return "", "", err
	}
	fi, err := os.Stat(abs)
	if err != nil {
		return "", "", err
	}
	if !fi.Mode().IsRegular() {
		return "", "", os.ErrNotExist
	}
	b, err := os.ReadFile(abs)
	if err != nil {
		return "", "", err
	}
	clean, _ := project.CleanRel(rel)
	return string(b), clean, nil
}

func (f *flattener) file(rel string, depth int) (string, error) {
	text, clean, err := f.read(rel)
	if err != nil {
		if depth == 0 {
			return "", fmt.Errorf("arquivo principal %q não encontrado", rel)
		}
		return "", err
	}
	f.size += len(text)
	if f.size > maxFlatBytes {
		return "", fmt.Errorf("documento grande demais para exportar (> %d MB)", maxFlatBytes>>20)
	}
	f.stack = append(f.stack, clean)
	defer func() { f.stack = f.stack[:len(f.stack)-1] }()

	var b strings.Builder
	verbatim := ""
	lines := strings.SplitAfter(text, "\n")
	for _, line := range lines {
		if verbatim != "" {
			b.WriteString(line)
			if strings.Contains(line, `\end{`+verbatim+`}`) {
				verbatim = ""
			}
			continue
		}
		code, comment := splitComment(line)
		if m := reVerbBeg.FindStringSubmatch(code); m != nil && !strings.Contains(code, `\end{`+m[1]+`}`) {
			verbatim = m[1]
			b.WriteString(line)
			continue
		}
		code = reInclude.ReplaceAllStringFunc(code, func(cmd string) string {
			sm := reInclude.FindStringSubmatch(cmd)
			name := strings.TrimSpace(sm[2])
			if name == "" {
				name = strings.TrimSpace(sm[3])
			}
			return f.include(sm[1], name, depth)
		})
		b.WriteString(code)
		b.WriteString(comment)
	}
	return b.String(), nil
}

// include returns the replacement text for \kind{name}.
func (f *flattener) include(kind, name string, depth int) string {
	if name == "" {
		return ""
	}
	orig := `\` + kind + `{` + name + `}`
	name = strings.TrimPrefix(name, "./")
	cands := []string{name}
	if path.Ext(name) == "" {
		cands = []string{name + ".tex", name}
	} else if kind == "include" {
		cands = []string{name + ".tex"}
	}
	for _, c := range cands {
		if _, err := project.CleanRel(c); err != nil {
			f.warn(fmt.Sprintf("%s ignorado: o caminho sai do projeto", orig))
			return ""
		}
		if _, _, err := f.read(c); err != nil {
			continue
		}
		clean, _ := project.CleanRel(c)
		for _, s := range f.stack {
			if s == clean {
				f.warn(fmt.Sprintf("%s ignorado: inclusão circular", orig))
				return ""
			}
		}
		if depth+1 > maxDepth {
			f.warn(fmt.Sprintf("%s ignorado: inclusões aninhadas demais", orig))
			return ""
		}
		text, err := f.file(c, depth+1)
		if err != nil {
			f.warn(fmt.Sprintf("%s ignorado: %v", orig, err))
			return ""
		}
		if kind == "subfile" {
			if m := reDocBody.FindStringSubmatch(text); m != nil {
				text = m[1]
			}
		}
		if !strings.HasSuffix(text, "\n") {
			text += "\n"
		}
		return text
	}
	f.warn(fmt.Sprintf("%s ignorado: arquivo não encontrado", orig))
	return ""
}

// splitComment splits a line at its first unescaped %.
func splitComment(line string) (code, comment string) {
	for i := 0; i < len(line); i++ {
		switch line[i] {
		case '\\':
			i++
		case '%':
			return line[:i], line[i:]
		}
	}
	return line, ""
}

func stripComments(text string) string {
	var b strings.Builder
	for _, line := range strings.SplitAfter(text, "\n") {
		code, comment := splitComment(line)
		b.WriteString(code)
		if comment != "" && strings.HasSuffix(comment, "\n") {
			b.WriteByte('\n')
		}
	}
	return b.String()
}

// bibFiles lists .bib files referenced by \bibliography/\addbibresource,
// as paths relative to srcDir (pandoc runs there).
func bibFiles(code, srcDir string, warn func(string)) []string {
	var out []string
	seen := map[string]bool{}
	for _, m := range reBib.FindAllStringSubmatch(code, -1) {
		for _, name := range strings.Split(m[1], ",") {
			name = strings.TrimPrefix(strings.TrimSpace(name), "./")
			if name == "" {
				continue
			}
			if !strings.HasSuffix(strings.ToLower(name), ".bib") {
				name += ".bib"
			}
			clean, err := project.CleanRel(name)
			if err != nil {
				warn(fmt.Sprintf("bibliografia %q ignorada: o caminho sai do projeto", name))
				continue
			}
			abs, err := project.ResolveIn(srcDir, clean)
			if err != nil {
				warn(fmt.Sprintf("bibliografia %q ignorada: o caminho sai do projeto", name))
				continue
			}
			if fi, err := os.Stat(abs); err != nil || !fi.Mode().IsRegular() {
				warn(fmt.Sprintf("bibliografia %q não encontrada", name))
				continue
			}
			if !seen[clean] {
				seen[clean] = true
				out = append(out, clean)
			}
		}
	}
	return out
}

func graphicsPaths(code string) []string {
	var out []string
	for _, m := range reGPath.FindAllStringSubmatch(code, -1) {
		for _, d := range reGDir.FindAllStringSubmatch(m[1], -1) {
			if dir := strings.TrimSpace(d[1]); dir != "" {
				out = append(out, dir)
			}
		}
	}
	return out
}

// pandoc -s copies --bibliography and --csl into the YAML front matter; the
// exported Markdown ships neither (and the paths are the server's), so drop them.
func dropFrontMatterBibliography(md string) string {
	if !strings.HasPrefix(md, "---\n") {
		return md
	}
	end := strings.Index(md[4:], "\n---\n")
	if end < 0 {
		return md
	}
	front := strings.Split(md[4:4+end], "\n")
	var keep []string
	skipping := false
	for _, l := range front {
		if strings.HasPrefix(l, "bibliography:") || strings.HasPrefix(l, "csl:") {
			skipping = true
			continue
		}
		if skipping && (strings.HasPrefix(l, "- ") || strings.HasPrefix(l, "  ")) {
			continue
		}
		skipping = false
		keep = append(keep, l)
	}
	rest := md[4+end+len("\n---\n"):]
	if len(keep) == 0 {
		return strings.TrimLeft(rest, "\n")
	}
	return "---\n" + strings.Join(keep, "\n") + "\n---\n" + rest
}

// ---------------------------------------------------------------- media

var (
	reMdImg   = regexp.MustCompile(`!\[((?:[^\]\\]|\\.)*)\]\((<[^>\n]*>|[^)\s]+)((?:\s+"[^"]*")?)\)`)
	reHTMLImg = regexp.MustCompile(`<(img|embed)(\s[^>]*?)?\ssrc="([^"]*)"([^>]*)>`)
)

// Extensions tried for \includegraphics{name} without one (graphicx order).
var imageExts = []string{".pdf", ".png", ".jpg", ".jpeg", ".eps", ".svg", ".gif", ".PDF", ".PNG", ".JPG", ".JPEG", ".EPS"}

var webImage = map[string]bool{".png": true, ".jpg": true, ".jpeg": true, ".gif": true, ".svg": true, ".webp": true}

type mediaCollector struct {
	opts         Options
	warn         func(string)
	graphicsPath []string
	done         map[string]string // original link -> new link
	files        map[string]string // export path -> disk path
}

func (m *mediaCollector) rewrite(ctx context.Context, md string) string {
	md = reMdImg.ReplaceAllStringFunc(md, func(s string) string {
		sm := reMdImg.FindStringSubmatch(s)
		link := strings.TrimSuffix(strings.TrimPrefix(sm[2], "<"), ">")
		nl := m.link(ctx, link)
		if nl == link {
			return s
		}
		if strings.ContainsAny(nl, " ()<>") {
			nl = "<" + nl + ">"
		}
		return "![" + sm[1] + "](" + nl + sm[3] + ")"
	})
	return reHTMLImg.ReplaceAllStringFunc(md, func(s string) string {
		sm := reHTMLImg.FindStringSubmatch(s)
		link := html.UnescapeString(sm[3])
		nl := m.link(ctx, link)
		if nl == link {
			return s
		}
		tag := sm[1]
		if tag == "embed" && webImage[strings.ToLower(path.Ext(nl))] {
			tag = "img"
		}
		return "<" + tag + sm[2] + ` src="` + html.EscapeString(nl) + `"` + sm[4] + ">"
	})
}

// link copies (and converts) the image a link refers to into the export and
// returns the new link; unresolvable links are returned unchanged.
func (m *mediaCollector) link(ctx context.Context, link string) string {
	if nl, ok := m.done[link]; ok {
		return nl
	}
	nl := m.resolve(ctx, link)
	m.done[link] = nl
	return nl
}

func (m *mediaCollector) resolve(ctx context.Context, link string) string {
	if link == "" || strings.Contains(link, "://") || strings.HasPrefix(link, "data:") || strings.HasPrefix(link, "#") {
		return link
	}
	if len(m.files) >= maxImages {
		m.warn("imagens demais; as restantes não foram incluídas")
		return link
	}
	rel, abs, err := m.find(link)
	if err != nil {
		m.warn(fmt.Sprintf("imagem %q: %v", link, err))
		return link
	}
	ext := strings.ToLower(path.Ext(rel))
	if ext == ".pdf" || ext == ".eps" || ext == ".ps" {
		pngRel := "media/" + strings.TrimSuffix(rel, path.Ext(rel)) + ".png"
		out := filepath.Join(m.opts.WorkDir, filepath.FromSlash(pngRel))
		if err := m.convert(ctx, ext, abs, out); err == nil {
			m.files[pngRel] = out
			return pngRel
		} else {
			m.warn(fmt.Sprintf("não foi possível converter %s para PNG (%v); o link aponta para o arquivo original", rel, err))
		}
	}
	m.files["media/"+rel] = abs
	return "media/" + rel
}

// find resolves an image path like LaTeX would: relative to the project
// root or a \graphicspath directory, trying the usual extensions.
func (m *mediaCollector) find(link string) (rel, abs string, err error) {
	dirs := append([]string{""}, m.graphicsPath...)
	exts := []string{""}
	if path.Ext(link) == "" {
		exts = append(imageExts, "")
	}
	outside := false
	for _, d := range dirs {
		for _, e := range exts {
			cand := path.Join(d, link+e)
			clean, err := project.CleanRel(strings.TrimPrefix(cand, "./"))
			if err != nil {
				outside = true
				continue
			}
			a, err := project.ResolveIn(m.opts.SrcDir, clean)
			if err != nil {
				outside = true
				continue
			}
			if fi, err := os.Stat(a); err == nil && fi.Mode().IsRegular() {
				return clean, a, nil
			}
		}
	}
	if outside {
		return "", "", errors.New("fora do projeto, ignorada")
	}
	return "", "", errors.New("não encontrada no projeto")
}

func (m *mediaCollector) convert(ctx context.Context, ext, in, out string) error {
	if err := os.MkdirAll(filepath.Dir(out), 0o755); err != nil {
		return err
	}
	cctx, cancel := context.WithTimeout(ctx, convertTimout)
	defer cancel()
	t := m.opts.Tools
	var err error
	var stderr []byte
	switch {
	case ext == ".pdf" && t.Pdftoppm != "":
		prefix := strings.TrimSuffix(out, ".png")
		_, stderr, err = m.opts.Run(cctx, m.opts.WorkDir, nil, t.Pdftoppm, "-png", "-r", "150", "-singlefile", "-f", "1", "-l", "1", in, prefix)
	case t.Gs != "":
		args := []string{"-dSAFER", "-dBATCH", "-dNOPAUSE", "-dQUIET", "-sDEVICE=pngalpha", "-r150", "-dFirstPage=1", "-dLastPage=1"}
		if ext != ".pdf" {
			args = append(args, "-dEPSCrop")
		}
		_, stderr, err = m.opts.Run(cctx, m.opts.WorkDir, nil, t.Gs, append(args, "-sOutputFile="+out, in)...)
	case ext == ".pdf":
		return errors.New("pdftoppm e gs não estão instalados")
	default:
		return errors.New("gs (Ghostscript) não está instalado")
	}
	if err != nil {
		if cctx.Err() != nil {
			return errors.New("tempo limite excedido")
		}
		return fmt.Errorf("%s", firstLines(string(stderr), 2))
	}
	if fi, err := os.Stat(out); err != nil || fi.Size() == 0 {
		return errors.New("o conversor não gerou a imagem")
	}
	return nil
}

// ------------------------------------------------------------------ zip

// SortedMedia returns the media paths in a stable order.
func (r *Result) SortedMedia() []string {
	keys := make([]string, 0, len(r.Media))
	for k := range r.Media {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}

// CopyFile streams a media file into w.
func CopyFile(w io.Writer, p string) error {
	f, err := os.Open(p)
	if err != nil {
		return err
	}
	defer f.Close()
	_, err = io.Copy(w, f)
	return err
}
