// Package project manages projects on disk: metadata, the user's source tree
// (src/) and the isolated build directory (build/).
//
// Layout:
//
//	data-dir/projects/{id}/meta.json
//	data-dir/projects/{id}/src/     user files, exactly as imported
//	data-dir/projects/{id}/build/   latexmk -outdir, never mixed with src/
package project

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"texdesk/internal/archive"
	"texdesk/internal/ulid"
)

var (
	ErrNotFound    = errors.New("not found")
	ErrInvalidPath = errors.New("invalid path")
	ErrExists      = errors.New("already exists")
)

// ValidationError is returned for bad user input that is not a path problem.
type ValidationError struct{ Msg string }

func (e *ValidationError) Error() string { return e.Msg }

func invalid(format string, a ...any) error { return &ValidationError{Msg: fmt.Sprintf(format, a...)} }

// Compilers supported by the compile step.
var Compilers = []string{"pdflatex", "latex", "xelatex", "lualatex"}

func validCompiler(c string) bool {
	for _, x := range Compilers {
		if x == c {
			return true
		}
	}
	return false
}

// Meta is persisted as meta.json.
type Meta struct {
	ID         string    `json:"id"`
	Name       string    `json:"name"`
	MainFile   string    `json:"mainFile"`
	Compiler   string    `json:"compiler"`
	CreatedAt  time.Time `json:"createdAt"`
	UpdatedAt  time.Time `json:"updatedAt"`
	LastAccess time.Time `json:"lastAccess"`
}

// Patch holds optional metadata changes.
type Patch struct {
	Name     *string `json:"name,omitempty"`
	MainFile *string `json:"mainFile,omitempty"`
	Compiler *string `json:"compiler,omitempty"`
}

// Store is the on-disk project repository. It is safe for concurrent use.
type Store struct {
	root string // data-dir/projects
	tmp  string // data-dir/tmp (staging; same filesystem so rename is atomic)

	mu    sync.Mutex
	locks map[string]*sync.Mutex
}

// Open creates (if needed) and opens the store under dataDir.
func Open(dataDir string) (*Store, error) {
	// External tools run with the project's src/ as working directory, so
	// every path handed to them must be absolute (a relative --data-dir
	// would make latexmk look for "data/projects/…" inside src/).
	dataDir, err := filepath.Abs(dataDir)
	if err != nil {
		return nil, err
	}
	s := &Store{
		root:  filepath.Join(dataDir, "projects"),
		tmp:   filepath.Join(dataDir, "tmp"),
		locks: map[string]*sync.Mutex{},
	}
	for _, d := range []string{s.root, s.tmp} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			return nil, err
		}
	}
	// Leftovers from interrupted imports.
	entries, _ := os.ReadDir(s.tmp)
	for _, e := range entries {
		_ = os.RemoveAll(filepath.Join(s.tmp, e.Name()))
	}
	return s, nil
}

// TempDir returns the staging directory (on the same filesystem as projects).
func (s *Store) TempDir() string { return s.tmp }

func (s *Store) lock(id string) func() {
	s.mu.Lock()
	l, ok := s.locks[id]
	if !ok {
		l = &sync.Mutex{}
		s.locks[id] = l
	}
	s.mu.Unlock()
	l.Lock()
	return l.Unlock
}

// Dir returns the project's root directory. The id must be validated first.
func (s *Store) Dir(id string) string      { return filepath.Join(s.root, id) }
func (s *Store) SrcDir(id string) string   { return filepath.Join(s.root, id, "src") }
func (s *Store) BuildDir(id string) string { return filepath.Join(s.root, id, "build") }

func (s *Store) metaPath(id string) string { return filepath.Join(s.root, id, "meta.json") }

func (s *Store) exists(id string) bool {
	if !ulid.Valid(id) {
		return false
	}
	_, err := os.Stat(s.metaPath(id))
	return err == nil
}

func (s *Store) readMeta(id string) (*Meta, error) {
	if !ulid.Valid(id) {
		return nil, ErrNotFound
	}
	b, err := os.ReadFile(s.metaPath(id))
	if errors.Is(err, os.ErrNotExist) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	var m Meta
	if err := json.Unmarshal(b, &m); err != nil {
		return nil, fmt.Errorf("corrupt meta.json for %s: %w", id, err)
	}
	return &m, nil
}

func writeMetaAt(path string, m *Meta) error {
	b, err := json.MarshalIndent(m, "", "  ")
	if err != nil {
		return err
	}
	return atomicWrite(path, b, 0o644)
}

func atomicWrite(path string, data []byte, perm os.FileMode) error {
	f, err := os.CreateTemp(filepath.Dir(path), ".tmp-*")
	if err != nil {
		return err
	}
	tmp := f.Name()
	if _, err := f.Write(data); err != nil {
		f.Close()
		os.Remove(tmp)
		return err
	}
	if err := f.Close(); err != nil {
		os.Remove(tmp)
		return err
	}
	if err := os.Chmod(tmp, perm); err != nil {
		os.Remove(tmp)
		return err
	}
	return os.Rename(tmp, path)
}

func cleanName(name string) string {
	name = strings.TrimSpace(name)
	name = strings.Map(func(r rune) rune {
		if r < 0x20 || r == 0x7f {
			return -1
		}
		return r
	}, name)
	if len([]rune(name)) > 200 {
		name = string([]rune(name)[:200])
	}
	return name
}

// List returns all projects, most recently updated first.
func (s *Store) List() ([]Meta, error) {
	entries, err := os.ReadDir(s.root)
	if err != nil {
		return nil, err
	}
	out := []Meta{}
	for _, e := range entries {
		if !e.IsDir() || !ulid.Valid(e.Name()) {
			continue
		}
		m, err := s.readMeta(e.Name())
		if err != nil {
			continue
		}
		out = append(out, *m)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].UpdatedAt.After(out[j].UpdatedAt) })
	return out, nil
}

// Get returns a project's metadata.
func (s *Store) Get(id string) (*Meta, error) { return s.readMeta(id) }

// Touch records an access (opening the project in the editor).
func (s *Store) Touch(id string) (*Meta, error) {
	defer s.lock(id)()
	m, err := s.readMeta(id)
	if err != nil {
		return nil, err
	}
	m.LastAccess = time.Now().UTC()
	return m, writeMetaAt(s.metaPath(id), m)
}

// markModified bumps UpdatedAt; called after any source change.
func (s *Store) markModified(id string, mutate func(m *Meta)) error {
	defer s.lock(id)()
	m, err := s.readMeta(id)
	if err != nil {
		return err
	}
	m.UpdatedAt = time.Now().UTC()
	if mutate != nil {
		mutate(m)
	}
	return writeMetaAt(s.metaPath(id), m)
}

// Update applies a metadata patch.
func (s *Store) Update(id string, p Patch) (*Meta, error) {
	defer s.lock(id)()
	m, err := s.readMeta(id)
	if err != nil {
		return nil, err
	}
	if p.Name != nil {
		n := cleanName(*p.Name)
		if n == "" {
			return nil, invalid("name must not be empty")
		}
		m.Name = n
	}
	if p.Compiler != nil {
		if !validCompiler(*p.Compiler) {
			return nil, invalid("compiler must be one of %s", strings.Join(Compilers, ", "))
		}
		m.Compiler = *p.Compiler
	}
	if p.MainFile != nil {
		rel, err := CleanRel(*p.MainFile)
		if err != nil {
			return nil, err
		}
		if !strings.EqualFold(filepath.Ext(rel), ".tex") {
			return nil, invalid("main file must be a .tex file")
		}
		abs, err := resolveIn(s.SrcDir(id), rel)
		if err != nil {
			return nil, err
		}
		if fi, err := os.Stat(abs); err != nil || !fi.Mode().IsRegular() {
			return nil, invalid("main file %q does not exist", rel)
		}
		m.MainFile = rel
	}
	m.UpdatedAt = time.Now().UTC()
	return m, writeMetaAt(s.metaPath(id), m)
}

// Delete removes a project and everything under it.
func (s *Store) Delete(id string) error {
	if !s.exists(id) {
		return ErrNotFound
	}
	unlock := s.lock(id)
	defer unlock()
	// Move out of the way first so a concurrent List never sees half a project.
	trash := filepath.Join(s.tmp, "del-"+id)
	if err := os.Rename(s.Dir(id), trash); err != nil {
		return err
	}
	return os.RemoveAll(trash)
}

// newStaging creates a fresh project skeleton in the temp dir and returns its
// id and path. Call commit to move it into place.
func (s *Store) newStaging() (string, string, error) {
	id := ulid.New()
	dir := filepath.Join(s.tmp, "new-"+id)
	for _, d := range []string{"src", "build"} {
		if err := os.MkdirAll(filepath.Join(dir, d), 0o755); err != nil {
			return "", "", err
		}
	}
	return id, dir, nil
}

func (s *Store) commit(id, staging string, m *Meta) error {
	if err := writeMetaAt(filepath.Join(staging, "meta.json"), m); err != nil {
		os.RemoveAll(staging)
		return err
	}
	if err := os.Rename(staging, s.Dir(id)); err != nil {
		os.RemoveAll(staging)
		return err
	}
	return nil
}

func newMeta(id, name, main, compiler string) *Meta {
	now := time.Now().UTC()
	return &Meta{ID: id, Name: name, MainFile: main, Compiler: compiler, CreatedAt: now, UpdatedAt: now, LastAccess: now}
}

// CreateBlank creates a new project from the minimal template.
func (s *Store) CreateBlank(name string) (*Meta, error) {
	name = cleanName(name)
	if name == "" {
		name = "Projeto sem título"
	}
	id, staging, err := s.newStaging()
	if err != nil {
		return nil, err
	}
	src := filepath.Join(staging, "src")
	if err := os.WriteFile(filepath.Join(src, "main.tex"), []byte(blankTemplate(name)), 0o644); err != nil {
		os.RemoveAll(staging)
		return nil, err
	}
	m := newMeta(id, name, "main.tex", "pdflatex")
	return m, s.commit(id, staging, m)
}

// Import creates a project from a zip archive.
func (s *Store) Import(r io.ReaderAt, size int64, name string, lim archive.Limits) (*Meta, []string, error) {
	id, staging, err := s.newStaging()
	if err != nil {
		return nil, nil, err
	}
	src := filepath.Join(staging, "src")
	res, err := archive.Extract(r, size, src, lim)
	if err != nil {
		os.RemoveAll(staging)
		return nil, nil, err
	}
	main := archive.DetectMain(src, res.Files)
	compiler := "pdflatex"
	if main != "" {
		compiler = archive.DetectCompiler(filepath.Join(src, filepath.FromSlash(main)))
	}
	warnings := res.Warnings
	if main == "" {
		warnings = append(warnings, "nenhum .tex com \\documentclass encontrado; defina o arquivo principal manualmente")
	}
	name = cleanName(name)
	if name == "" {
		name = res.RootName
	}
	if name == "" {
		name = "Projeto importado"
	}
	m := newMeta(id, name, main, compiler)
	if err := s.commit(id, staging, m); err != nil {
		return nil, nil, err
	}
	return m, warnings, nil
}

func blankTemplate(title string) string {
	return `\documentclass[11pt,a4paper]{article}
\usepackage[utf8]{inputenc}
\usepackage[T1]{fontenc}
\usepackage{amsmath,amssymb}
\usepackage{graphicx}
\usepackage{hyperref}

\title{` + escapeTeX(title) + `}
\author{}
\date{\today}

\begin{document}
\maketitle

\section{Introdução}
Comece a escrever aqui.

\end{document}
`
}

var texEscaper = strings.NewReplacer(
	`\`, `\textbackslash{}`, `{`, `\{`, `}`, `\}`, `$`, `\$`, `&`, `\&`,
	`#`, `\#`, `%`, `\%`, `_`, `\_`, `^`, `\textasciicircum{}`, `~`, `\textasciitilde{}`,
)

func escapeTeX(s string) string { return texEscaper.Replace(s) }
