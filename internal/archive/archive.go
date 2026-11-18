// Package archive imports and exports project sources as zip files.
//
// Import is defensive: it rejects zip-slip paths (absolute, "..", drive
// letters), symlinks, archives with too many entries and archives whose
// total uncompressed size exceeds a limit (enforced on the bytes actually
// written, not on the sizes the archive claims).
package archive

import (
	"archive/zip"
	"bufio"
	"bytes"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strings"
)

// Limits bound what an imported archive may contain.
type Limits struct {
	MaxFiles      int   // number of extracted files
	MaxTotalBytes int64 // total uncompressed bytes
	MaxFileBytes  int64 // single file uncompressed bytes
}

// DefaultLimits are sensible defaults for single-user use.
var DefaultLimits = Limits{MaxFiles: 5000, MaxTotalBytes: 1 << 30, MaxFileBytes: 256 << 20}

// Error is a user-facing import error.
type Error struct {
	Code string // "zip_invalid", "zip_unsafe_path", "zip_symlink", "zip_too_large", "zip_too_many_files"
	Msg  string
}

func (e *Error) Error() string { return e.Msg }

func errf(code, format string, a ...any) error {
	return &Error{Code: code, Msg: fmt.Sprintf(format, a...)}
}

// Result describes a successful extraction.
type Result struct {
	Files    []string // extracted files, project-relative, forward slashes
	RootName string   // name of the single top-level folder that was unnested, if any
	Warnings []string
}

var junkNames = map[string]bool{
	".DS_Store": true, "Thumbs.db": true, "desktop.ini": true, ".texdesk": true,
}

var junkDirs = map[string]bool{
	"__MACOSX": true, ".git": true, ".svn": true, ".hg": true, ".idea": true, ".vscode": true,
}

// Generated files that never belong in src/. Note: .bbl is kept on purpose
// (arXiv-style submissions often ship .bbl without a .bib).
var junkExts = []string{
	".aux", ".log", ".out", ".toc", ".lof", ".lot", ".fls", ".fdb_latexmk",
	".synctex.gz", ".synctex", ".synctex(busy)", ".blg", ".bcf", ".run.xml",
	".nav", ".snm", ".vrb", ".xdv", ".dvi", ".ilg", ".glg", ".brf",
}

// IsJunk reports whether a (cleaned, slash-separated) path should be ignored
// on import.
func IsJunk(p string) bool {
	segs := strings.Split(p, "/")
	for _, s := range segs[:len(segs)-1] {
		if junkDirs[s] {
			return true
		}
	}
	base := segs[len(segs)-1]
	if junkNames[base] || strings.HasPrefix(base, "._") {
		return true
	}
	lower := strings.ToLower(base)
	for _, ext := range junkExts {
		if strings.HasSuffix(lower, ext) {
			return true
		}
	}
	return false
}

// SanitizeEntry normalizes an archive entry name and rejects unsafe ones.
// It returns ("", nil) for entries that are fine but should be skipped (e.g.
// the root "./").
func SanitizeEntry(name string) (string, error) {
	if strings.ContainsRune(name, 0) {
		return "", errf("zip_unsafe_path", "entry %q contains a NUL byte", name)
	}
	n := strings.ReplaceAll(name, "\\", "/")
	if strings.HasPrefix(n, "/") || (len(n) >= 2 && n[1] == ':') {
		return "", errf("zip_unsafe_path", "entry %q has an absolute path", name)
	}
	for _, seg := range strings.Split(n, "/") {
		if seg == ".." {
			return "", errf("zip_unsafe_path", "entry %q escapes the project directory", name)
		}
	}
	c := path.Clean(n)
	if c == "." {
		return "", nil
	}
	return c, nil
}

type entry struct {
	f    *zip.File
	name string
	dir  bool
}

// Extract unpacks the archive into dest (which must exist and be empty).
func Extract(r io.ReaderAt, size int64, dest string, lim Limits) (*Result, error) {
	zr, err := zip.NewReader(r, size)
	if err != nil {
		return nil, errf("zip_invalid", "not a valid zip file: %v", err)
	}
	// Cheap upper bound before looking at anything: junk entries count too.
	if len(zr.File) > lim.MaxFiles*2+100 {
		return nil, errf("zip_too_many_files", "archive has too many entries (%d)", len(zr.File))
	}

	var entries []entry
	var declared uint64
	files := 0
	for _, f := range zr.File {
		name, err := SanitizeEntry(f.Name)
		if err != nil {
			return nil, err
		}
		if name == "" {
			continue
		}
		mode := f.Mode()
		if mode&fs.ModeSymlink != 0 {
			return nil, errf("zip_symlink", "entry %q is a symbolic link; symlinks are not allowed", f.Name)
		}
		if mode&(fs.ModeDevice|fs.ModeNamedPipe|fs.ModeSocket|fs.ModeCharDevice|fs.ModeIrregular) != 0 {
			return nil, errf("zip_unsafe_path", "entry %q is not a regular file", f.Name)
		}
		isDir := f.FileInfo().IsDir() || strings.HasSuffix(f.Name, "/")
		if IsJunk(name) || (isDir && junkDirs[path.Base(name)]) {
			continue
		}
		if !isDir {
			files++
			if files > lim.MaxFiles {
				return nil, errf("zip_too_many_files", "archive has more than %d files", lim.MaxFiles)
			}
			if f.UncompressedSize64 > uint64(lim.MaxFileBytes) {
				return nil, errf("zip_too_large", "file %q is too large when uncompressed", name)
			}
			declared += f.UncompressedSize64
			if declared > uint64(lim.MaxTotalBytes) {
				return nil, errf("zip_too_large", "archive is too large when uncompressed (limit %d MB)", lim.MaxTotalBytes>>20)
			}
		}
		entries = append(entries, entry{f: f, name: name, dir: isDir})
	}
	if files == 0 {
		return nil, errf("zip_invalid", "archive contains no files")
	}

	res := &Result{}
	if root := singleRoot(entries); root != "" {
		res.RootName = root
		kept := entries[:0]
		for _, e := range entries {
			if e.name == root {
				continue
			}
			e.name = strings.TrimPrefix(e.name, root+"/")
			kept = append(kept, e)
		}
		entries = kept
	}

	var written int64
	seen := map[string]bool{}
	for _, e := range entries {
		target := filepath.Join(dest, filepath.FromSlash(e.name))
		if !strings.HasPrefix(target, filepath.Clean(dest)+string(filepath.Separator)) {
			return nil, errf("zip_unsafe_path", "entry %q escapes the project directory", e.name)
		}
		if e.dir {
			if err := os.MkdirAll(target, 0o755); err != nil {
				return nil, err
			}
			continue
		}
		if seen[e.name] {
			res.Warnings = append(res.Warnings, fmt.Sprintf("entrada duplicada ignorada: %s", e.name))
			continue
		}
		seen[e.name] = true
		if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
			return nil, fmt.Errorf("creating %s: %w", e.name, err)
		}
		n, err := extractFile(e.f, target, lim.MaxFileBytes, lim.MaxTotalBytes-written)
		written += n
		if err != nil {
			return nil, err
		}
		res.Files = append(res.Files, e.name)
	}
	sort.Strings(res.Files)
	return res, nil
}

// singleRoot returns the name of the only top-level folder if every entry
// lives under it, or "" otherwise.
func singleRoot(entries []entry) string {
	root := ""
	for _, e := range entries {
		first, rest, nested := strings.Cut(e.name, "/")
		if !nested && !e.dir {
			return "" // a file at the top level
		}
		if root == "" {
			root = first
		} else if root != first {
			return ""
		}
		_ = rest
	}
	return root
}

var errTooLarge = errors.New("too large")

func extractFile(f *zip.File, target string, maxFile, remaining int64) (int64, error) {
	rc, err := f.Open()
	if err != nil {
		return 0, errf("zip_invalid", "cannot read %q: %v", f.Name, err)
	}
	defer rc.Close()
	out, err := os.OpenFile(target, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o644)
	if err != nil {
		return 0, err
	}
	limit := maxFile
	if remaining < limit {
		limit = remaining
	}
	n, err := io.Copy(out, &capReader{r: rc, left: limit})
	cerr := out.Close()
	if errors.Is(err, errTooLarge) {
		return n, errf("zip_too_large", "archive is too large when uncompressed (entry %q exceeds the limit)", f.Name)
	}
	if err != nil {
		return n, errf("zip_invalid", "cannot extract %q: %v", f.Name, err)
	}
	return n, cerr
}

// capReader fails once more than left bytes have been read. This enforces
// limits on actual decompressed bytes, regardless of declared sizes.
type capReader struct {
	r    io.Reader
	left int64
}

func (c *capReader) Read(p []byte) (int, error) {
	if c.left < 0 {
		return 0, errTooLarge
	}
	if int64(len(p)) > c.left+1 {
		p = p[:c.left+1]
	}
	n, err := c.r.Read(p)
	c.left -= int64(n)
	if c.left < 0 {
		return n, errTooLarge
	}
	return n, err
}

// DetectMain picks the root document among files (project-relative paths
// inside srcDir). Preference order:
//  1. .tex files containing an uncommented \documentclass
//     (those that also have \begin{document} win over those that don't);
//  2. among ties, a file named main.tex;
//  3. then the smallest depth; 4. then alphabetical order.
//
// It returns "" if no candidate exists.
func DetectMain(srcDir string, files []string) string {
	type cand struct {
		path   string
		hasDoc bool
		isMain bool
		depth  int
	}
	var cands []cand
	for _, f := range files {
		if !strings.EqualFold(path.Ext(f), ".tex") {
			continue
		}
		dc, doc := scanTex(filepath.Join(srcDir, filepath.FromSlash(f)))
		if !dc {
			continue
		}
		cands = append(cands, cand{
			path: f, hasDoc: doc,
			isMain: strings.EqualFold(path.Base(f), "main.tex"),
			depth:  strings.Count(f, "/"),
		})
	}
	if len(cands) == 0 {
		return ""
	}
	sort.Slice(cands, func(i, j int) bool {
		a, b := cands[i], cands[j]
		if a.hasDoc != b.hasDoc {
			return a.hasDoc
		}
		if a.isMain != b.isMain {
			return a.isMain
		}
		if a.depth != b.depth {
			return a.depth < b.depth
		}
		return a.path < b.path
	})
	return cands[0].path
}

// scanTex reports whether the file has an uncommented \documentclass and
// \begin{document}. Only the first 1 MB is read.
func scanTex(p string) (documentclass, beginDocument bool) {
	f, err := os.Open(p)
	if err != nil {
		return false, false
	}
	defer f.Close()
	sc := bufio.NewScanner(io.LimitReader(f, 1<<20))
	sc.Buffer(make([]byte, 64*1024), 1<<20)
	for sc.Scan() {
		line := StripComment(sc.Text())
		if strings.Contains(line, `\documentclass`) {
			documentclass = true
		}
		if strings.Contains(line, `\begin{document}`) {
			beginDocument = true
		}
		if documentclass && beginDocument {
			return
		}
	}
	return
}

// StripComment removes a TeX comment (an unescaped %) from a line.
func StripComment(line string) string {
	for i := 0; i < len(line); i++ {
		switch line[i] {
		case '\\':
			i++ // skip escaped char, e.g. \%
		case '%':
			return line[:i]
		}
	}
	return line
}

// DetectCompiler guesses the engine from the main file: a "% !TEX program"
// magic comment wins; otherwise fontspec/unicode-math/polyglossia imply
// xelatex, luacode implies lualatex, and pdflatex is the default.
func DetectCompiler(mainPath string) string {
	b, err := os.ReadFile(mainPath)
	if err != nil {
		return "pdflatex"
	}
	if len(b) > 1<<20 {
		b = b[:1<<20]
	}
	lower := bytes.ToLower(b)
	for _, line := range strings.Split(string(lower), "\n") {
		l := strings.TrimSpace(line)
		if strings.HasPrefix(l, "%") && strings.Contains(l, "!tex") && strings.Contains(l, "program") {
			for _, c := range []string{"lualatex", "xelatex", "pdflatex"} {
				if strings.Contains(l, c) {
					return c
				}
			}
		}
	}
	var code strings.Builder
	for _, line := range strings.Split(string(b), "\n") {
		code.WriteString(StripComment(line))
		code.WriteByte('\n')
	}
	s := code.String()
	switch {
	case strings.Contains(s, "luacode") || strings.Contains(s, `\directlua`):
		return "lualatex"
	case strings.Contains(s, "{fontspec}") || strings.Contains(s, "{unicode-math}") || strings.Contains(s, "{polyglossia}"):
		return "xelatex"
	}
	return "pdflatex"
}

// WriteZip writes every regular file under srcDir into a zip archive.
// Symlinks and anything outside srcDir are never included.
func WriteZip(w io.Writer, srcDir string) error {
	zw := zip.NewWriter(w)
	err := filepath.WalkDir(srcDir, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if p == srcDir {
			return nil
		}
		rel, err := filepath.Rel(srcDir, p)
		if err != nil {
			return err
		}
		name := filepath.ToSlash(rel)
		if d.IsDir() {
			// Only emit explicit entries for empty folders.
			ents, err := os.ReadDir(p)
			if err == nil && len(ents) == 0 {
				_, err = zw.Create(name + "/")
			}
			return err
		}
		if !d.Type().IsRegular() {
			return nil
		}
		info, err := d.Info()
		if err != nil {
			return err
		}
		hdr, err := zip.FileInfoHeader(info)
		if err != nil {
			return err
		}
		hdr.Name = name
		hdr.Method = zip.Deflate
		fw, err := zw.CreateHeader(hdr)
		if err != nil {
			return err
		}
		f, err := os.Open(p)
		if err != nil {
			return err
		}
		_, err = io.Copy(fw, f)
		f.Close()
		return err
	})
	if err != nil {
		zw.Close()
		return err
	}
	return zw.Close()
}
