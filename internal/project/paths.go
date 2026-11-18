package project

import (
	"errors"
	"os"
	"path"
	"path/filepath"
	"strings"
)

// CleanRel normalizes a user-supplied project-relative path (always with
// forward slashes) and rejects anything that could escape the project root:
// absolute paths, Windows drive/UNC prefixes, NUL bytes and any ".." segment.
// The result never starts with "/" and is never "." or "".
func CleanRel(p string) (string, error) {
	if p == "" || strings.ContainsRune(p, 0) {
		return "", ErrInvalidPath
	}
	p = strings.ReplaceAll(p, "\\", "/")
	if strings.HasPrefix(p, "/") || hasDrivePrefix(p) {
		return "", ErrInvalidPath
	}
	for _, seg := range strings.Split(p, "/") {
		if seg == ".." {
			return "", ErrInvalidPath
		}
	}
	c := path.Clean(p)
	if c == "." || c == "" || strings.HasPrefix(c, "../") || c == ".." {
		return "", ErrInvalidPath
	}
	return c, nil
}

func hasDrivePrefix(p string) bool {
	return len(p) >= 2 && p[1] == ':' && ((p[0] >= 'a' && p[0] <= 'z') || (p[0] >= 'A' && p[0] <= 'Z'))
}

// resolveIn joins rel (already cleaned) onto root and verifies that the result,
// after resolving any symlinks in the existing part of the path, is still
// inside root. It returns the absolute (non-symlink-resolved) path.
func resolveIn(root, rel string) (string, error) {
	abs := filepath.Join(root, filepath.FromSlash(rel))
	realRoot, err := filepath.EvalSymlinks(root)
	if err != nil {
		return "", err
	}
	// Find the deepest existing ancestor and resolve it.
	probe := abs
	var tail []string
	for {
		if _, err := os.Lstat(probe); err == nil {
			break
		} else if !errors.Is(err, os.ErrNotExist) {
			return "", err
		}
		parent := filepath.Dir(probe)
		if parent == probe {
			return "", ErrInvalidPath
		}
		tail = append([]string{filepath.Base(probe)}, tail...)
		probe = parent
	}
	realProbe, err := filepath.EvalSymlinks(probe)
	if err != nil {
		return "", err
	}
	full := filepath.Join(append([]string{realProbe}, tail...)...)
	if !within(realRoot, full) {
		return "", ErrInvalidPath
	}
	return abs, nil
}

func within(root, p string) bool {
	if p == root {
		return true
	}
	return strings.HasPrefix(p, root+string(filepath.Separator))
}

// ResolveIn cleans rel and joins it onto root, refusing anything that would
// escape root (absolute paths, "..", symlinks pointing outside).
func ResolveIn(root, rel string) (string, error) {
	clean, err := CleanRel(rel)
	if err != nil {
		return "", err
	}
	return resolveIn(root, clean)
}
