package project

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestCleanRel(t *testing.T) {
	ok := map[string]string{
		"main.tex":           "main.tex",
		"a/b/c.tex":          "a/b/c.tex",
		"./a//b/":            "a/b",
		`chapters\intro.tex`: "chapters/intro.tex",
		"figuras/ç ã é.png":  "figuras/ç ã é.png",
		"a/./b":              "a/b",
	}
	for in, want := range ok {
		got, err := CleanRel(in)
		if err != nil || got != want {
			t.Errorf("CleanRel(%q) = %q, %v; want %q", in, got, err, want)
		}
	}
	bad := []string{"", ".", "..", "../x", "a/../../x", "a/../b", "/etc/passwd", `C:\x`, "c:/x", "a\x00b", `..\x`, "./"}
	for _, in := range bad {
		if got, err := CleanRel(in); !errors.Is(err, ErrInvalidPath) {
			t.Errorf("CleanRel(%q) = %q, %v; want ErrInvalidPath", in, got, err)
		}
	}
}

func newStore(t *testing.T) *Store {
	t.Helper()
	s, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	return s
}

func TestBlankProjectAndFileOps(t *testing.T) {
	s := newStore(t)
	m, err := s.CreateBlank("  Minha {tese} & cia  ")
	if err != nil {
		t.Fatal(err)
	}
	if m.Name != "Minha {tese} & cia" || m.MainFile != "main.tex" || m.Compiler != "pdflatex" {
		t.Fatalf("unexpected meta: %+v", m)
	}
	b, _ := os.ReadFile(filepath.Join(s.SrcDir(m.ID), "main.tex"))
	if !strings.Contains(string(b), `\title{Minha \{tese\} \& cia}`) {
		t.Errorf("title not escaped:\n%s", b)
	}
	if _, err := os.Stat(s.BuildDir(m.ID)); err != nil {
		t.Errorf("build dir missing: %v", err)
	}

	if _, err := s.Create(m.ID, "chapters", "folder"); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Create(m.ID, "chapters/intro.tex", "file"); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Create(m.ID, "chapters/intro.tex", "file"); !errors.Is(err, ErrExists) {
		t.Errorf("duplicate create: %v", err)
	}
	if _, err := s.WriteFile(m.ID, "chapters/intro.tex", strings.NewReader("hello"), 100); err != nil {
		t.Fatal(err)
	}
	if _, err := s.WriteFile(m.ID, "big.txt", strings.NewReader(strings.Repeat("x", 101)), 100); err == nil {
		t.Error("expected size error")
	}

	// Moving the folder containing the main file keeps mainFile in sync.
	if _, err := s.Rename(m.ID, "main.tex", "chapters/main.tex"); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Rename(m.ID, "chapters", "src"); err != nil {
		t.Fatal(err)
	}
	got, _ := s.Get(m.ID)
	if got.MainFile != "src/main.tex" {
		t.Errorf("mainFile after rename = %q", got.MainFile)
	}
	if _, err := s.Rename(m.ID, "src", "src/inner"); err == nil {
		t.Error("moving a folder into itself must fail")
	}

	tree, err := s.Tree(m.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(tree.Children) != 1 || tree.Children[0].Path != "src" || len(tree.Children[0].Children) != 2 {
		t.Errorf("unexpected tree: %+v", tree.Children)
	}

	if err := s.Remove(m.ID, "src"); err != nil {
		t.Fatal(err)
	}
	got, _ = s.Get(m.ID)
	if got.MainFile != "" {
		t.Errorf("mainFile should be cleared after deletion, got %q", got.MainFile)
	}

	if err := s.Delete(m.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Get(m.ID); !errors.Is(err, ErrNotFound) {
		t.Errorf("Get after delete: %v", err)
	}
}

func TestPathsStayInsideSrc(t *testing.T) {
	s := newStore(t)
	m, _ := s.CreateBlank("x")
	for _, p := range []string{"../meta.json", "../build/x", "/etc/passwd", "a/../../meta.json"} {
		if _, err := s.WriteFile(m.ID, p, strings.NewReader("x"), 10); !errors.Is(err, ErrInvalidPath) {
			t.Errorf("WriteFile(%q): %v", p, err)
		}
		if _, _, err := s.OpenFile(m.ID, p); !errors.Is(err, ErrInvalidPath) {
			t.Errorf("OpenFile(%q): %v", p, err)
		}
	}
	// A symlink planted inside src/ pointing outside must not be followed.
	outside := t.TempDir()
	if err := os.Symlink(outside, filepath.Join(s.SrcDir(m.ID), "escape")); err != nil {
		t.Skip("symlinks unsupported")
	}
	if _, err := s.WriteFile(m.ID, "escape/pwn.txt", strings.NewReader("x"), 10); !errors.Is(err, ErrInvalidPath) {
		t.Errorf("write through symlink: %v", err)
	}
	if _, err := os.Stat(filepath.Join(outside, "pwn.txt")); err == nil {
		t.Error("file written outside src through symlink")
	}
}

func TestInvalidIDs(t *testing.T) {
	s := newStore(t)
	for _, id := range []string{"", "..", "../../etc", "01HZZZZZZZZZZZZZZZZZZZZZZZ"} {
		if _, err := s.Get(id); !errors.Is(err, ErrNotFound) {
			t.Errorf("Get(%q): %v", id, err)
		}
		if _, err := s.Tree(id); !errors.Is(err, ErrNotFound) {
			t.Errorf("Tree(%q): %v", id, err)
		}
	}
}

func TestUpdate(t *testing.T) {
	s := newStore(t)
	m, _ := s.CreateBlank("x")
	s.Create(m.ID, "other.tex", "file")
	s.Create(m.ID, "fig.png", "file")
	bad := []Patch{
		{Compiler: ptr("context")},
		{MainFile: ptr("missing.tex")},
		{MainFile: ptr("fig.png")},
		{MainFile: ptr("../x.tex")},
		{Name: ptr("   ")},
	}
	for _, p := range bad {
		if _, err := s.Update(m.ID, p); err == nil {
			t.Errorf("Update(%+v) should fail", p)
		}
	}
	got, err := s.Update(m.ID, Patch{Name: ptr("Novo"), MainFile: ptr("other.tex"), Compiler: ptr("xelatex")})
	if err != nil {
		t.Fatal(err)
	}
	if got.Name != "Novo" || got.MainFile != "other.tex" || got.Compiler != "xelatex" {
		t.Errorf("unexpected meta %+v", got)
	}
}

func ptr[T any](v T) *T { return &v }

// Tools run inside src/, so a relative --data-dir must become absolute.
func TestOpenRelativeDataDir(t *testing.T) {
	wd, _ := os.Getwd()
	if err := os.Chdir(t.TempDir()); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.Chdir(wd) })
	s, err := Open("./data")
	if err != nil {
		t.Fatal(err)
	}
	m, err := s.CreateBlank("x")
	if err != nil {
		t.Fatal(err)
	}
	for _, p := range []string{s.SrcDir(m.ID), s.BuildDir(m.ID), s.TempDir()} {
		if !filepath.IsAbs(p) {
			t.Errorf("%s is relative", p)
		}
	}
}
