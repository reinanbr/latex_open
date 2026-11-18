// Package synctex wraps the `synctex` command-line tool for forward
// (source → PDF) and inverse (PDF → source) search.
package synctex

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// Box is a region on a PDF page, in PDF points from the page's top-left.
type Box struct {
	Page int     `json:"page"`
	X    float64 `json:"x"`
	Y    float64 `json:"y"`
	W    float64 `json:"w"`
	H    float64 `json:"h"`
}

// Location is a position in a project source file.
type Location struct {
	File string `json:"file"` // project-relative
	Line int    `json:"line"`
	Col  int    `json:"col"`
}

// ErrNoMatch means SyncTeX found nothing for the query.
var ErrNoMatch = errors.New("no synctex match")

// Runner executes synctex; replaceable in tests.
type Runner func(ctx context.Context, dir string, args ...string) ([]byte, error)

// ExecRunner runs the real binary.
func ExecRunner(ctx context.Context, dir string, args ...string) ([]byte, error) {
	cmd := exec.CommandContext(ctx, "synctex", args...)
	cmd.Dir = dir
	return cmd.CombinedOutput()
}

// Tool runs queries against a PDF that has a sibling .synctex.gz file.
type Tool struct {
	Run     Runner
	Timeout time.Duration
}

// New returns a Tool using the real synctex binary.
func New() *Tool { return &Tool{Run: ExecRunner, Timeout: 10 * time.Second} }

// Forward maps file:line(:col) to a box in the PDF. file is project-relative.
func (t *Tool) Forward(ctx context.Context, srcDir, pdf, file string, line, col int) (*Box, error) {
	if col < 0 {
		col = 0
	}
	ctx, cancel := context.WithTimeout(ctx, t.Timeout)
	defer cancel()
	out, err := t.Run(ctx, srcDir, "view", "-i", fmt.Sprintf("%d:%d:%s", line, col, file), "-o", pdf)
	if err != nil && len(out) == 0 {
		return nil, err
	}
	return ParseForward(string(out))
}

// Inverse maps a point on a page (PDF points from the top-left) to a source
// location.
func (t *Tool) Inverse(ctx context.Context, srcDir, pdf string, page int, x, y float64) (*Location, error) {
	ctx, cancel := context.WithTimeout(ctx, t.Timeout)
	defer cancel()
	out, err := t.Run(ctx, srcDir, "edit", "-o", fmt.Sprintf("%d:%.2f:%.2f:%s", page, x, y, pdf))
	if err != nil && len(out) == 0 {
		return nil, err
	}
	return ParseInverse(string(out), srcDir)
}

type record map[string]string

func records(out string, startKey string) []record {
	var recs []record
	var cur record
	sc := bufio.NewScanner(strings.NewReader(out))
	sc.Buffer(make([]byte, 64*1024), 1<<20)
	for sc.Scan() {
		k, v, ok := strings.Cut(sc.Text(), ":")
		if !ok {
			continue
		}
		if k == startKey {
			cur = record{}
			recs = append(recs, cur)
		}
		if cur != nil {
			cur[k] = v
		}
	}
	return recs
}

func num(r record, k string) float64 {
	f, _ := strconv.ParseFloat(r[k], 64)
	return f
}

// ParseForward reads `synctex view` output. All boxes on the first matched
// page that share the first box's line are merged; that is the region shown
// to the user.
func ParseForward(out string) (*Box, error) {
	recs := records(out, "Output")
	if len(recs) == 0 {
		return nil, ErrNoMatch
	}
	var box *Box
	for _, r := range recs {
		page, _ := strconv.Atoi(r["Page"])
		if page < 1 {
			continue
		}
		// h,v: left edge and baseline; W,H: width and height.
		b := Box{Page: page, X: num(r, "h"), Y: num(r, "v") - num(r, "H"), W: num(r, "W"), H: num(r, "H")}
		if box == nil {
			box = &b
			continue
		}
		if b.Page != box.Page || b.Y > box.Y+box.H || b.Y+b.H < box.Y {
			continue
		}
		x1 := min(box.X, b.X)
		y1 := min(box.Y, b.Y)
		x2 := max(box.X+box.W, b.X+b.W)
		y2 := max(box.Y+box.H, b.Y+b.H)
		box.X, box.Y, box.W, box.H = x1, y1, x2-x1, y2-y1
	}
	if box == nil {
		return nil, ErrNoMatch
	}
	return box, nil
}

// ParseInverse reads `synctex edit` output and maps the input path to a
// project-relative path.
func ParseInverse(out, srcDir string) (*Location, error) {
	for _, r := range records(out, "Output") {
		in := r["Input"]
		line, _ := strconv.Atoi(r["Line"])
		if in == "" || line < 1 {
			continue
		}
		rel := RelPath(in, srcDir)
		if rel == "" {
			continue // a class/package file, not a project source
		}
		col, _ := strconv.Atoi(r["Column"])
		if col < 0 {
			col = 0
		}
		return &Location{File: rel, Line: line, Col: col}, nil
	}
	return nil, ErrNoMatch
}

// RelPath maps a path recorded by SyncTeX (absolute, possibly with "/./")
// to a project-relative path. It tolerates a moved data directory by also
// matching ".../src/" segments.
func RelPath(p, srcDir string) string {
	p = filepath.Clean(p)
	if srcDir != "" {
		if r, err := filepath.Rel(filepath.Clean(srcDir), p); err == nil && !strings.HasPrefix(r, "..") && r != "." {
			return filepath.ToSlash(r)
		}
	}
	if !filepath.IsAbs(p) {
		r := filepath.ToSlash(p)
		if strings.HasPrefix(r, "../") {
			return ""
		}
		return r
	}
	// /<anything>/projects/<id>/src/<rel>
	slash := filepath.ToSlash(p)
	if i := strings.LastIndex(slash, "/src/"); i >= 0 && strings.Contains(slash[:i], "/projects/") {
		return slash[i+len("/src/"):]
	}
	return ""
}
