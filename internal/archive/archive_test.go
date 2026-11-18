package archive

import (
	"archive/zip"
	"bytes"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"
	"time"
)

type zentry struct {
	name string
	body string
	mode fs.FileMode
}

func makeZip(t *testing.T, entries ...zentry) *bytes.Reader {
	t.Helper()
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	for _, e := range entries {
		hdr := &zip.FileHeader{Name: e.name, Method: zip.Deflate, Modified: time.Now()}
		if e.mode != 0 {
			hdr.SetMode(e.mode)
		}
		w, err := zw.CreateHeader(hdr)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := w.Write([]byte(e.body)); err != nil {
			t.Fatal(err)
		}
	}
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}
	return bytes.NewReader(buf.Bytes())
}

func extract(t *testing.T, r *bytes.Reader, lim Limits) (*Result, string, error) {
	t.Helper()
	dir := t.TempDir()
	res, err := Extract(r, r.Size(), dir, lim)
	return res, dir, err
}

func wantCode(t *testing.T, err error, code string) {
	t.Helper()
	ae, ok := err.(*Error)
	if !ok {
		t.Fatalf("want *Error %s, got %T %v", code, err, err)
	}
	if ae.Code != code {
		t.Fatalf("want code %s, got %s (%s)", code, ae.Code, ae.Msg)
	}
}

func TestZipSlipRejected(t *testing.T) {
	for _, name := range []string{
		"../evil.tex",
		"a/../../evil.tex",
		"/etc/passwd",
		`..\evil.tex`,
		`C:\evil.tex`,
		"ok/..",
	} {
		t.Run(name, func(t *testing.T) {
			z := makeZip(t, zentry{name: "main.tex", body: `\documentclass{article}`}, zentry{name: name, body: "x"})
			_, dir, err := extract(t, z, DefaultLimits)
			wantCode(t, err, "zip_unsafe_path")
			if _, statErr := os.Stat(filepath.Join(filepath.Dir(dir), "evil.tex")); statErr == nil {
				t.Fatal("file written outside destination")
			}
		})
	}
}

func TestSymlinkRejected(t *testing.T) {
	z := makeZip(t, zentry{name: "main.tex", body: "x"}, zentry{name: "link", body: "/etc/passwd", mode: fs.ModeSymlink | 0o777})
	_, _, err := extract(t, z, DefaultLimits)
	wantCode(t, err, "zip_symlink")
}

func TestZipBombDeclaredSize(t *testing.T) {
	big := strings.Repeat("A", 2<<20) // compresses to almost nothing
	z := makeZip(t, zentry{name: "main.tex", body: "x"}, zentry{name: "bomb.txt", body: big})
	_, _, err := extract(t, z, Limits{MaxFiles: 10, MaxTotalBytes: 1 << 20, MaxFileBytes: 10 << 20})
	wantCode(t, err, "zip_too_large")
}

func TestZipBombPerFile(t *testing.T) {
	z := makeZip(t, zentry{name: "bomb.txt", body: strings.Repeat("A", 2<<20)})
	_, _, err := extract(t, z, Limits{MaxFiles: 10, MaxTotalBytes: 100 << 20, MaxFileBytes: 1 << 20})
	wantCode(t, err, "zip_too_large")
}

// A crafted archive can lie about UncompressedSize64; the cap must apply to
// the bytes actually decompressed.
func TestZipBombLyingHeader(t *testing.T) {
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	body := bytes.Repeat([]byte("A"), 3<<20)
	w, _ := zw.CreateHeader(&zip.FileHeader{Name: "bomb.txt", Method: zip.Deflate})
	w.Write(body)
	zw.Close()
	raw := buf.Bytes()
	// Patch the uncompressed size in the central directory record (offset 24
	// from the "PK\x01\x02" signature) to claim 10 bytes.
	idx := bytes.LastIndex(raw, []byte("PK\x01\x02"))
	if idx < 0 {
		t.Fatal("central directory not found")
	}
	raw[idx+24], raw[idx+25], raw[idx+26], raw[idx+27] = 10, 0, 0, 0
	r := bytes.NewReader(raw)
	_, _, err := extract(t, r, Limits{MaxFiles: 10, MaxTotalBytes: 1 << 20, MaxFileBytes: 1 << 20})
	if err == nil {
		t.Fatal("expected an error for a lying header")
	}
}

func TestTooManyFiles(t *testing.T) {
	var es []zentry
	for i := 0; i < 20; i++ {
		es = append(es, zentry{name: strings.Repeat("f", i+1) + ".tex", body: "x"})
	}
	_, _, err := extract(t, makeZip(t, es...), Limits{MaxFiles: 10, MaxTotalBytes: 1 << 20, MaxFileBytes: 1 << 20})
	wantCode(t, err, "zip_too_many_files")
}

func TestUnnestAndJunk(t *testing.T) {
	z := makeZip(t,
		zentry{name: "paper/"},
		zentry{name: "paper/main.tex", body: `\documentclass{article}\begin{document}\end{document}`},
		zentry{name: "paper/figs/a.png", body: "png"},
		zentry{name: "paper/main.aux", body: "junk"},
		zentry{name: "paper/main.log", body: "junk"},
		zentry{name: "paper/main.synctex.gz", body: "junk"},
		zentry{name: "paper/.DS_Store", body: "junk"},
		zentry{name: "__MACOSX/paper/._main.tex", body: "junk"},
		zentry{name: "paper/refs.bbl", body: "kept"},
	)
	res, dir, err := extract(t, z, DefaultLimits)
	if err != nil {
		t.Fatal(err)
	}
	if res.RootName != "paper" {
		t.Errorf("RootName = %q, want paper", res.RootName)
	}
	want := []string{"figs/a.png", "main.tex", "refs.bbl"}
	if strings.Join(res.Files, ",") != strings.Join(want, ",") {
		t.Errorf("files = %v, want %v", res.Files, want)
	}
	if _, err := os.Stat(filepath.Join(dir, "main.tex")); err != nil {
		t.Errorf("main.tex not at root: %v", err)
	}
	if _, err := os.Stat(filepath.Join(dir, "__MACOSX")); err == nil {
		t.Error("__MACOSX extracted")
	}
}

func TestNoUnnestWithRootFile(t *testing.T) {
	z := makeZip(t, zentry{name: "a/x.tex", body: "x"}, zentry{name: "readme.txt", body: "r"})
	res, _, err := extract(t, z, DefaultLimits)
	if err != nil {
		t.Fatal(err)
	}
	if res.RootName != "" {
		t.Errorf("should not unnest, got root %q", res.RootName)
	}
}

func writeFiles(t *testing.T, files map[string]string) (string, []string) {
	t.Helper()
	dir := t.TempDir()
	var list []string
	for p, body := range files {
		full := filepath.Join(dir, filepath.FromSlash(p))
		os.MkdirAll(filepath.Dir(full), 0o755)
		if err := os.WriteFile(full, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
		list = append(list, p)
	}
	sort.Strings(list)
	return dir, list
}

func TestDetectMain(t *testing.T) {
	doc := "\\documentclass{article}\n\\begin{document}\nx\n\\end{document}\n"
	cases := []struct {
		name  string
		files map[string]string
		want  string
	}{
		{"single", map[string]string{"paper.tex": doc, "intro.tex": "\\section{a}"}, "paper.tex"},
		{"prefer main.tex", map[string]string{"aaa.tex": doc, "main.tex": doc}, "main.tex"},
		{"main.tex deeper still wins", map[string]string{"zzz.tex": doc, "src/main.tex": doc}, "src/main.tex"},
		{"shallowest", map[string]string{"a/b/thesis.tex": doc, "a/report.tex": doc}, "a/report.tex"},
		{"commented documentclass ignored", map[string]string{"fake.tex": "% \\documentclass{article}\n", "real.tex": doc}, "real.tex"},
		{"escaped percent is not a comment", map[string]string{"x.tex": "50\\% \\documentclass{article}\n\\begin{document}"}, "x.tex"},
		{"full doc beats standalone fragment", map[string]string{"fig/tikz.tex": "\\documentclass{standalone}", "doc.tex": doc}, "doc.tex"},
		{"none", map[string]string{"chap.tex": "\\section{x}", "a.bib": "@x{}"}, ""},
		{"uppercase extension", map[string]string{"Main.TEX": doc}, "Main.TEX"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			dir, list := writeFiles(t, c.files)
			if got := DetectMain(dir, list); got != c.want {
				t.Errorf("DetectMain = %q, want %q", got, c.want)
			}
		})
	}
}

func TestDetectCompiler(t *testing.T) {
	cases := map[string]string{
		"\\documentclass{article}\n\\usepackage{fontspec}\n":       "xelatex",
		"% !TEX program = lualatex\n\\usepackage{fontspec}\n":      "lualatex",
		"\\documentclass{article}\n% \\usepackage{fontspec}\n":     "pdflatex",
		"\\documentclass{article}\n\\usepackage{luacode}\n":        "lualatex",
		"\\documentclass{article}\n\\usepackage[utf8]{inputenc}\n": "pdflatex",
	}
	for body, want := range cases {
		dir := t.TempDir()
		p := filepath.Join(dir, "main.tex")
		os.WriteFile(p, []byte(body), 0o644)
		if got := DetectCompiler(p); got != want {
			t.Errorf("DetectCompiler(%q) = %s, want %s", body, got, want)
		}
	}
}

func TestWriteZipOnlySrc(t *testing.T) {
	proj := t.TempDir()
	src := filepath.Join(proj, "src")
	build := filepath.Join(proj, "build")
	os.MkdirAll(filepath.Join(src, "chapters"), 0o755)
	os.MkdirAll(filepath.Join(src, "empty"), 0o755)
	os.MkdirAll(build, 0o755)
	os.WriteFile(filepath.Join(src, "main.tex"), []byte("m"), 0o644)
	os.WriteFile(filepath.Join(src, "chapters", "a.tex"), []byte("a"), 0o644)
	os.WriteFile(filepath.Join(build, "main.pdf"), []byte("pdf"), 0o644)
	os.WriteFile(filepath.Join(build, "main.aux"), []byte("aux"), 0o644)
	// A symlink inside src must not be followed.
	os.Symlink("/etc/passwd", filepath.Join(src, "passwd"))

	var buf bytes.Buffer
	if err := WriteZip(&buf, src); err != nil {
		t.Fatal(err)
	}
	zr, err := zip.NewReader(bytes.NewReader(buf.Bytes()), int64(buf.Len()))
	if err != nil {
		t.Fatal(err)
	}
	var names []string
	for _, f := range zr.File {
		names = append(names, f.Name)
	}
	sort.Strings(names)
	want := []string{"chapters/a.tex", "empty/", "main.tex"}
	if strings.Join(names, ",") != strings.Join(want, ",") {
		t.Fatalf("zip entries = %v, want %v", names, want)
	}

	// Round trip.
	out := t.TempDir()
	r := bytes.NewReader(buf.Bytes())
	if _, err := Extract(r, r.Size(), out, DefaultLimits); err != nil {
		t.Fatal(err)
	}
	if b, _ := os.ReadFile(filepath.Join(out, "chapters", "a.tex")); string(b) != "a" {
		t.Errorf("round trip content = %q", b)
	}
}

func TestIsJunk(t *testing.T) {
	for p, want := range map[string]bool{
		"main.tex": false, "refs.bbl": false, "fig.pdf": false,
		"main.aux": true, "x/main.log": true, "__MACOSX/a": true, ".git/config": true,
		"a/.DS_Store": true, "._main.tex": true, "main.synctex.gz": true, "main.fdb_latexmk": true,
	} {
		if got := IsJunk(p); got != want {
			t.Errorf("IsJunk(%q) = %v, want %v", p, got, want)
		}
	}
}

func TestStripComment(t *testing.T) {
	for in, want := range map[string]string{
		`a % b`:      `a `,
		`a \% b`:     `a \% b`,
		`a \\% b`:    `a \\`,
		`no comment`: `no comment`,
	} {
		if got := StripComment(in); got != want {
			t.Errorf("StripComment(%q) = %q, want %q", in, got, want)
		}
	}
}
