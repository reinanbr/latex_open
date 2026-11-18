// Package texindex scans a project's sources for things the editor offers in
// autocomplete: \label keys, bibliography keys, user-defined macros and
// environments. It also wraps texcount for word counts.
package texindex

import (
	"bufio"
	"context"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"texdesk/internal/sandbox"
)

type Label struct {
	Key  string `json:"key"`
	File string `json:"file"`
	Line int    `json:"line"`
}

type Citation struct {
	Key    string `json:"key"`
	Type   string `json:"type"`
	Title  string `json:"title,omitempty"`
	Author string `json:"author,omitempty"`
	Year   string `json:"year,omitempty"`
	File   string `json:"file"`
}

type Macro struct {
	Name string `json:"name"` // without backslash
	Args int    `json:"args"`
	File string `json:"file"`
}

// Use is a \documentclass, \usepackage or \RequirePackage of the project.
type Use struct {
	Name    string `json:"name"`
	Options string `json:"options,omitempty"`
	File    string `json:"file"`
	Line    int    `json:"line"`
}

type Index struct {
	Labels       []Label    `json:"labels"`
	Citations    []Citation `json:"citations"`
	Macros       []Macro    `json:"macros"`
	Environments []string   `json:"environments"`
	// VerbatimEnvironments are user-defined environments whose body is code
	// (\lstnewenvironment, \newminted, \DefineVerbatimEnvironment...).
	VerbatimEnvironments []string `json:"verbatimEnvironments"`
	Packages             []Use    `json:"packages"`
	Classes              []Use    `json:"classes"`
	// Dynamic is set when a source defines commands with names built at
	// run time (\csname, \@namedef...): the set of commands is not fully known.
	Dynamic bool `json:"dynamic,omitempty"`
}

const maxFileSize = 2 << 20

var (
	reLabel  = regexp.MustCompile(`\\label\s*\{([^{}]+)\}`)
	reNewCmd = regexp.MustCompile(`\\(?:re)?newcommand\*?\s*\{?\\([a-zA-Z@]+)\}?\s*(?:\[(\d)\])?`)
	reDef    = regexp.MustCompile(`\\(?:def|gdef|edef|xdef)\s*\\([a-zA-Z@]+)`)
	reMathOp = regexp.MustCompile(`\\DeclareMathOperator\*?\s*\{?\\([a-zA-Z@]+)\}?`)
	reDocCmd = regexp.MustCompile(`\\(?:New|Renew|Provide|Declare)DocumentCommand\s*\{?\\([a-zA-Z@]+)\}?\s*\{([^{}]*)\}`)
	reNewEnv = regexp.MustCompile(`\\(?:re)?newenvironment\*?\s*\{([^{}]+)\}|\\(?:New|Renew)DocumentEnvironment\s*\{([^{}]+)\}|\\newtheorem\*?\s*\{([^{}]+)\}`)
	// Other definitions of one command (no argument count).
	reDefine  = regexp.MustCompile(`\\(?:providecommand|DeclareRobustCommand|(?:re)?newrobustcmd|(?:re)?newcommandx|(?:New|Renew|Declare)CommandCopy|NewExpandableDocumentCommand|(?:global\s*)?let|newlength|newsavebox|newcount|newdimen|newskip|newmuskip|newtoks|newbox|newwrite|newread|chardef|mathchardef|countdef|dimendef|DeclarePairedDelimiter[XP]?|DeclareMathSymbol|DeclareMathDelimiter|DeclareMathAccent|DeclareTextFontCommand|DeclareOldFontCommand|DeclareMathAlphabet|DeclareSymbolFontAlphabet|newfontfamily|newfontface|setmathfont|newif|font|DeclareCiteCommand|DeclareMultiCiteCommand)\*?\s*\{?\s*\\([a-zA-Z@]+)`)
	reNamed   = regexp.MustCompile(`\\(?:newlistof|newfixedcaption)\s*(?:\[[^\]]*\]\s*)?\{\\?([A-Za-z]+)\}`)
	reCounter = regexp.MustCompile(`\\newcounter\s*\{([a-zA-Z@]+)\}`)
	// Environments defined by packages' helper commands.
	reEnvLike = regexp.MustCompile(`\\(?:lstnewenvironment|newtcolorbox|(?:Declare|New)TColorBox|newtcblisting|DeclareTCBListing|newtcbtheorem|newmdenv|newfloat|DeclareFloatingEnvironment|newlist|declaretheorem|NewEnviron|(?:Declare|Provide)DocumentEnvironment|newmintedfile|newenvironmentx|newtheorem\*)\s*(?:\[[^\]]*\]\s*)?\{([^{}\\]+)\}`)
	reVerbEnv = regexp.MustCompile(`\\(?:lstnewenvironment|newtcblisting|DeclareTCBListing|DefineVerbatimEnvironment|CustomVerbatimEnvironment|RecustomVerbatimEnvironment)\s*(?:\[[^\]]*\]\s*)?\{([^{}\\]+)\}`)
	reMinted  = regexp.MustCompile(`\\newminted\s*(?:\[([^\]]*)\])?\s*\{([^{}]+)\}`)
	reMintInl = regexp.MustCompile(`\\newmintinline\s*(?:\[([^\]]*)\])?\s*\{([^{}]+)\}`)
	reDynamic = regexp.MustCompile(`\\(?:expandafter\s*\\(?:[gex]?def|let|newcommand|renewcommand|providecommand)\s*\\csname|@namedef|cs[gex]?def|csletcs|cslet)\b`)
	reUse     = regexp.MustCompile(`\\(documentclass|usepackage|RequirePackage|LoadClass)\s*(?:\[([^\]]*)\])?\s*\{([^{}]*)\}`)
	reBibEnt  = regexp.MustCompile(`(?i)@([a-z]+)\s*[{(]\s*([^,\s]+)\s*,`)
)

// Build scans every .tex/.sty/.cls/.bib file under srcDir.
func Build(srcDir string) (*Index, error) {
	idx := &Index{Labels: []Label{}, Citations: []Citation{}, Macros: []Macro{}, Environments: []string{}, Packages: []Use{}, Classes: []Use{}, VerbatimEnvironments: []string{}}
	envs := map[string]bool{}
	macros := map[string]bool{}
	verb := map[string]bool{}
	err := filepath.WalkDir(srcDir, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		if !d.Type().IsRegular() {
			return nil
		}
		ext := strings.ToLower(filepath.Ext(p))
		if ext != ".tex" && ext != ".sty" && ext != ".cls" && ext != ".bib" && ext != ".ltx" {
			return nil
		}
		info, err := d.Info()
		if err != nil || info.Size() > maxFileSize {
			return nil
		}
		b, err := os.ReadFile(p)
		if err != nil {
			return nil
		}
		rel, _ := filepath.Rel(srcDir, p)
		rel = filepath.ToSlash(rel)
		if ext == ".bib" {
			idx.Citations = append(idx.Citations, ParseBib(string(b), rel)...)
			return nil
		}
		scanTeX(string(b), rel, idx, macros, envs, verb)
		scanUses(string(b), rel, idx)
		return nil
	})
	sort.Slice(idx.Labels, func(i, j int) bool { return idx.Labels[i].Key < idx.Labels[j].Key })
	sort.Slice(idx.Citations, func(i, j int) bool { return idx.Citations[i].Key < idx.Citations[j].Key })
	for e := range envs {
		idx.Environments = append(idx.Environments, e)
	}
	sort.Strings(idx.Environments)
	for e := range verb {
		idx.VerbatimEnvironments = append(idx.VerbatimEnvironments, e)
	}
	sort.Strings(idx.VerbatimEnvironments)
	return idx, err
}

func stripComment(line string) string {
	for i := 0; i < len(line); i++ {
		switch line[i] {
		case '\\':
			i++
		case '%':
			return line[:i]
		}
	}
	return line
}

func scanTeX(text, file string, idx *Index, macros, envs, verb map[string]bool) {
	sc := bufio.NewScanner(strings.NewReader(text))
	sc.Buffer(make([]byte, 64*1024), maxFileSize)
	n := 0
	for sc.Scan() {
		n++
		line := stripComment(sc.Text())
		if !strings.Contains(line, `\`) {
			continue
		}
		for _, m := range reLabel.FindAllStringSubmatch(line, -1) {
			idx.Labels = append(idx.Labels, Label{Key: strings.TrimSpace(m[1]), File: file, Line: n})
		}
		addMacro := func(name string, args int) {
			if !macros[name] {
				macros[name] = true
				idx.Macros = append(idx.Macros, Macro{Name: name, Args: args, File: file})
			}
		}
		for _, m := range reNewCmd.FindAllStringSubmatch(line, -1) {
			a, _ := strconv.Atoi(m[2])
			addMacro(m[1], a)
		}
		for _, m := range reDef.FindAllStringSubmatch(line, -1) {
			addMacro(m[1], 0)
		}
		for _, m := range reMathOp.FindAllStringSubmatch(line, -1) {
			addMacro(m[1], 0)
		}
		for _, m := range reDocCmd.FindAllStringSubmatch(line, -1) {
			// xparse arg spec: count m/o/O{..}/s/... letters roughly.
			addMacro(m[1], strings.Count(m[2], "m"))
		}
		for _, m := range reDefine.FindAllStringSubmatch(line, -1) {
			addMacro(m[1], 0)
			if strings.HasPrefix(m[1], "if") && strings.Contains(m[0], "newif") {
				addMacro(m[1][2:]+"true", 0)
				addMacro(m[1][2:]+"false", 0)
			}
		}
		for _, m := range reCounter.FindAllStringSubmatch(line, -1) {
			addMacro("the"+m[1], 0)
		}
		for _, m := range reNamed.FindAllStringSubmatch(line, -1) {
			addMacro(m[1], 0)
		}
		for _, m := range reMintInl.FindAllStringSubmatch(line, -1) {
			if m[1] != "" {
				addMacro(m[1], 1)
			} else {
				addMacro(strings.TrimSpace(m[2])+"inline", 1)
			}
		}
		if reDynamic.MatchString(line) {
			idx.Dynamic = true
		}
		for _, m := range reNewEnv.FindAllStringSubmatch(line, -1) {
			for _, g := range m[1:] {
				if g = strings.TrimSpace(g); g != "" {
					envs[g] = true
				}
			}
		}
		for _, m := range reEnvLike.FindAllStringSubmatch(line, -1) {
			if g := strings.TrimSpace(m[1]); g != "" {
				envs[g] = true
				if strings.HasPrefix(m[0], `\newtcbtheorem`) {
					envs[g+"*"] = true
				}
			}
		}
		for _, m := range reVerbEnv.FindAllStringSubmatch(line, -1) {
			if g := strings.TrimSpace(m[1]); g != "" {
				envs[g] = true
				verb[g] = true
			}
		}
		for _, m := range reMinted.FindAllStringSubmatch(line, -1) {
			name := m[1]
			if name == "" {
				name = strings.TrimSpace(m[2]) + "code"
			}
			if name != "code" {
				envs[name] = true
				verb[name] = true
			}
		}
	}
}

// scanUses records \documentclass, \usepackage and \RequirePackage, whose
// options often span several lines.
func scanUses(text, file string, idx *Index) {
	lines := strings.Split(text, "\n")
	starts := make([]int, len(lines))
	var b strings.Builder
	for i, l := range lines {
		starts[i] = b.Len()
		// Keep offsets: replace the comment with spaces.
		c := stripComment(l)
		b.WriteString(c)
		b.WriteString(strings.Repeat(" ", len(l)-len(c)))
		b.WriteByte('\n')
	}
	code := b.String()
	for _, m := range reUse.FindAllStringSubmatchIndex(code, -1) {
		kind := code[m[2]:m[3]]
		opts := ""
		if m[4] >= 0 {
			opts = strings.Join(strings.Fields(code[m[4]:m[5]]), " ")
		}
		line := sort.SearchInts(starts, m[0]+1)
		for _, name := range strings.Split(code[m[6]:m[7]], ",") {
			name = strings.TrimSpace(name)
			if name == "" || strings.ContainsAny(name, `\#`) {
				continue
			}
			u := Use{Name: name, Options: opts, File: file, Line: line}
			if kind == "documentclass" || kind == "LoadClass" {
				idx.Classes = append(idx.Classes, u)
			} else {
				idx.Packages = append(idx.Packages, u)
			}
		}
	}
}

// ParseBib extracts entries (key, type, title, author, year) from BibTeX.
func ParseBib(text, file string) []Citation {
	var out []Citation
	locs := reBibEnt.FindAllStringSubmatchIndex(text, -1)
	for i, l := range locs {
		typ := strings.ToLower(text[l[2]:l[3]])
		if typ == "string" || typ == "comment" || typ == "preamble" {
			continue
		}
		end := len(text)
		if i+1 < len(locs) {
			end = locs[i+1][0]
		}
		body := text[l[1]:end]
		out = append(out, Citation{
			Key: text[l[4]:l[5]], Type: typ, File: file,
			Title: bibField(body, "title"), Author: bibField(body, "author"), Year: bibField(body, "year"),
		})
	}
	return out
}

func bibField(body, name string) string {
	re := regexp.MustCompile(`(?i)(?:^|[,\s])` + name + `\s*=\s*`)
	loc := re.FindStringIndex(body)
	if loc == nil {
		return ""
	}
	rest := body[loc[1]:]
	if rest == "" {
		return ""
	}
	var val string
	switch rest[0] {
	case '{':
		depth := 0
		for i := 0; i < len(rest); i++ {
			if rest[i] == '{' {
				depth++
			} else if rest[i] == '}' {
				depth--
				if depth == 0 {
					val = rest[1:i]
					break
				}
			}
		}
	case '"':
		if j := strings.IndexByte(rest[1:], '"'); j >= 0 {
			val = rest[1 : j+1]
		}
	default:
		j := strings.IndexAny(rest, ",}\n")
		if j < 0 {
			j = len(rest)
		}
		val = rest[:j]
	}
	val = strings.NewReplacer("{", "", "}", "", "\n", " ", "\t", " ").Replace(val)
	val = strings.Join(strings.Fields(val), " ")
	if len(val) > 200 {
		val = val[:200] + "…"
	}
	return val
}

// WordCount is the summary reported by texcount.
type WordCount struct {
	Words    int    `json:"words"`
	Headers  int    `json:"headers"`
	Captions int    `json:"captions"`
	Math     int    `json:"math"`
	Source   string `json:"source"`
}

var reCount = regexp.MustCompile(`(?m)^(Words in text|Words in headers|Words outside text \(captions, etc\.\)|Number of math inlines|Number of math displayed): (\d+)`)

// CountWords runs texcount on the main file (following \input/\include).
func CountWords(ctx context.Context, srcDir, mainFile string) (*WordCount, error) {
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	argv := sandbox.Wrap([]string{"texcount", "-inc", "-total", "-utf8", "-nocol", "-q", mainFile}, sandbox.Policy{RO: []string{srcDir}})
	cmd := exec.CommandContext(ctx, argv[0], argv[1:]...)
	cmd.Dir = srcDir
	out, err := cmd.Output()
	if err != nil && len(out) == 0 {
		return nil, err
	}
	return ParseTexcount(string(out)), nil
}

// ParseTexcount reads texcount's -total summary.
func ParseTexcount(out string) *WordCount {
	wc := &WordCount{Source: "texcount"}
	for _, m := range reCount.FindAllStringSubmatch(out, -1) {
		n, _ := strconv.Atoi(m[2])
		switch {
		case strings.HasPrefix(m[1], "Words in text"):
			wc.Words = n
		case strings.HasPrefix(m[1], "Words in headers"):
			wc.Headers = n
		case strings.HasPrefix(m[1], "Words outside"):
			wc.Captions = n
		default:
			wc.Math += n
		}
	}
	return wc
}
