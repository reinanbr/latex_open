package project

import (
	"errors"
	"io"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

// Node is one entry of the file tree.
type Node struct {
	Name     string    `json:"name"`
	Path     string    `json:"path"` // project-relative, forward slashes
	Type     string    `json:"type"` // "file" | "folder"
	Size     int64     `json:"size,omitempty"`
	ModTime  time.Time `json:"modTime"`
	Children []*Node   `json:"children,omitempty"`
}

// Resolve validates a user-supplied project-relative path and returns the
// cleaned relative path and its absolute location inside src/.
func (s *Store) Resolve(id, p string) (rel, abs string, err error) {
	if !s.exists(id) {
		return "", "", ErrNotFound
	}
	rel, err = CleanRel(p)
	if err != nil {
		return "", "", err
	}
	abs, err = resolveIn(s.SrcDir(id), rel)
	return rel, abs, err
}

// Tree returns the source tree; folders first, then files, both by name.
func (s *Store) Tree(id string) (*Node, error) {
	if !s.exists(id) {
		return nil, ErrNotFound
	}
	root := &Node{Name: "", Path: "", Type: "folder", Children: []*Node{}}
	var walk func(dir string, n *Node) error
	walk = func(dir string, n *Node) error {
		entries, err := os.ReadDir(dir)
		if err != nil {
			return err
		}
		for _, e := range entries {
			if e.Type()&fs.ModeSymlink != 0 {
				continue // never expose symlinks
			}
			info, err := e.Info()
			if err != nil {
				continue
			}
			child := &Node{Name: e.Name(), Path: path.Join(n.Path, e.Name()), ModTime: info.ModTime().UTC()}
			if e.IsDir() {
				child.Type = "folder"
				child.Children = []*Node{}
				if err := walk(filepath.Join(dir, e.Name()), child); err != nil {
					return err
				}
			} else if info.Mode().IsRegular() {
				child.Type = "file"
				child.Size = info.Size()
			} else {
				continue
			}
			n.Children = append(n.Children, child)
		}
		sort.Slice(n.Children, func(i, j int) bool {
			a, b := n.Children[i], n.Children[j]
			if a.Type != b.Type {
				return a.Type == "folder"
			}
			return strings.ToLower(a.Name) < strings.ToLower(b.Name)
		})
		return nil
	}
	return root, walk(s.SrcDir(id), root)
}

// ListFiles returns every regular file in src/ as project-relative paths.
func (s *Store) ListFiles(id string) ([]string, error) {
	if !s.exists(id) {
		return nil, ErrNotFound
	}
	src := s.SrcDir(id)
	var out []string
	err := filepath.WalkDir(src, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.Type().IsRegular() {
			rel, _ := filepath.Rel(src, p)
			out = append(out, filepath.ToSlash(rel))
		}
		return nil
	})
	return out, err
}

// OpenFile opens a regular file for reading.
func (s *Store) OpenFile(id, p string) (*os.File, fs.FileInfo, error) {
	_, abs, err := s.Resolve(id, p)
	if err != nil {
		return nil, nil, err
	}
	fi, err := os.Lstat(abs)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil, ErrNotFound
	}
	if err != nil {
		return nil, nil, err
	}
	if !fi.Mode().IsRegular() {
		return nil, nil, invalid("%q is not a file", p)
	}
	f, err := os.Open(abs)
	return f, fi, err
}

// WriteFile replaces (or creates) a file's content atomically. Parent folders
// are created as needed. At most maxBytes are accepted.
func (s *Store) WriteFile(id, p string, r io.Reader, maxBytes int64) (string, error) {
	rel, abs, err := s.Resolve(id, p)
	if err != nil {
		return "", err
	}
	if fi, err := os.Lstat(abs); err == nil && !fi.Mode().IsRegular() {
		return "", invalid("%q is not a file", rel)
	}
	if err := os.MkdirAll(filepath.Dir(abs), 0o755); err != nil {
		return "", err
	}
	data, err := io.ReadAll(io.LimitReader(r, maxBytes+1))
	if err != nil {
		return "", err
	}
	if int64(len(data)) > maxBytes {
		return "", invalid("file too large")
	}
	if err := atomicWrite(abs, data, 0o644); err != nil {
		return "", err
	}
	return rel, s.markModified(id, nil)
}

// Create makes an empty file or folder; it fails if the path already exists.
func (s *Store) Create(id, p, typ string) (string, error) {
	rel, abs, err := s.Resolve(id, p)
	if err != nil {
		return "", err
	}
	if _, err := os.Lstat(abs); err == nil {
		return "", ErrExists
	}
	switch typ {
	case "folder":
		if err := os.MkdirAll(abs, 0o755); err != nil {
			return "", err
		}
	case "file", "":
		if err := os.MkdirAll(filepath.Dir(abs), 0o755); err != nil {
			return "", err
		}
		f, err := os.OpenFile(abs, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o644)
		if errors.Is(err, os.ErrExist) {
			return "", ErrExists
		}
		if err != nil {
			return "", err
		}
		f.Close()
	default:
		return "", invalid(`type must be "file" or "folder"`)
	}
	return rel, s.markModified(id, nil)
}

// Rename moves a file or folder. It keeps meta.mainFile pointing to the same
// file when the main file (or a folder containing it) is moved.
func (s *Store) Rename(id, from, to string) (string, error) {
	fromRel, fromAbs, err := s.Resolve(id, from)
	if err != nil {
		return "", err
	}
	toRel, toAbs, err := s.Resolve(id, to)
	if err != nil {
		return "", err
	}
	if fromRel == toRel {
		return toRel, nil
	}
	if strings.HasPrefix(toRel+"/", fromRel+"/") {
		return "", invalid("cannot move a folder into itself")
	}
	if _, err := os.Lstat(fromAbs); errors.Is(err, os.ErrNotExist) {
		return "", ErrNotFound
	}
	if _, err := os.Lstat(toAbs); err == nil {
		return "", ErrExists
	}
	if err := os.MkdirAll(filepath.Dir(toAbs), 0o755); err != nil {
		return "", err
	}
	if err := os.Rename(fromAbs, toAbs); err != nil {
		return "", err
	}
	return toRel, s.markModified(id, func(m *Meta) {
		if m.MainFile == fromRel {
			m.MainFile = toRel
		} else if strings.HasPrefix(m.MainFile, fromRel+"/") {
			m.MainFile = toRel + strings.TrimPrefix(m.MainFile, fromRel)
		}
	})
}

// Remove deletes a file or folder (recursively). If the main file is removed
// the project is left without one until the user picks another.
func (s *Store) Remove(id, p string) error {
	rel, abs, err := s.Resolve(id, p)
	if err != nil {
		return err
	}
	if _, err := os.Lstat(abs); errors.Is(err, os.ErrNotExist) {
		return ErrNotFound
	}
	if err := os.RemoveAll(abs); err != nil {
		return err
	}
	return s.markModified(id, func(m *Meta) {
		if m.MainFile == rel || strings.HasPrefix(m.MainFile, rel+"/") {
			m.MainFile = ""
		}
	})
}
