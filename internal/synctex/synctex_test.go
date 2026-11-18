package synctex

import (
	"context"
	"strings"
	"testing"
)

const viewOut = `This is SyncTeX command line utility, version 1.5
SyncTeX result begin
Output:/data/projects/P/build/.texdesk-out/B//output.pdf
Page:1
x:372.970551
y:365.017639
h:117.828133
v:367.744293
W:358.655029
H:10.906579
before:
offset:-1
Output:/data/projects/P/build/.texdesk-out/B//output.pdf
Page:1
x:160.678680
y:366.0
h:100.0
v:366.0
W:100.0
H:10.0
Output:/data/projects/P/build/.texdesk-out/B//output.pdf
Page:2
h:50
v:100
W:10
H:10
SyncTeX result end
`

func TestParseForward(t *testing.T) {
	b, err := ParseForward(viewOut)
	if err != nil {
		t.Fatal(err)
	}
	// Top = v - H of the first box; the second box (same line, starting
	// further left) extends it; the page-2 record is ignored.
	if b.Page != 1 || b.X != 100 || b.Y < 356.0 || b.Y > 356.9 || b.X+b.W < 476.4 || b.Y+b.H < 367.7 {
		t.Errorf("merged box = %+v", b)
	}
	if _, err := ParseForward("SyncTeX result begin\nSyncTeX result end\n"); err != ErrNoMatch {
		t.Errorf("empty: %v", err)
	}
}

const editOut = `SyncTeX result begin
Output:/data/projects/P/build/.texdesk-out/B/output.pdf
Input:/usr/share/texlive/texmf-dist/tex/latex/base/article.cls
Line:12
Column:-1
Output:/data/projects/P/build/.texdesk-out/B/output.pdf
Input:/data/projects/P/src/./chapters/intro.tex
Line:5
Column:-1
Offset:0
Context:
SyncTeX result end
`

func TestParseInverse(t *testing.T) {
	loc, err := ParseInverse(editOut, "/data/projects/P/src")
	if err != nil {
		t.Fatal(err)
	}
	if loc.File != "chapters/intro.tex" || loc.Line != 5 || loc.Col != 0 {
		t.Errorf("loc = %+v", loc)
	}
	// Data dir moved since the build: still mapped.
	loc, err = ParseInverse(editOut, "/new/place/projects/P/src")
	if err != nil || loc.File != "chapters/intro.tex" {
		t.Errorf("moved: %+v %v", loc, err)
	}
	if _, err := ParseInverse("SyncTeX result begin\nSyncTeX result end\n", "/x"); err != ErrNoMatch {
		t.Errorf("empty: %v", err)
	}
}

func TestRelPath(t *testing.T) {
	for in, want := range map[string]string{
		"/data/projects/P/src/./main.tex":         "main.tex",
		"/data/projects/P/src/a/../b.tex":         "b.tex",
		"/usr/share/texlive/x.sty":                "",
		"./chapters/x.tex":                        "chapters/x.tex",
		"/elsewhere/projects/Q/src/sub/dir/f.tex": "sub/dir/f.tex",
		"/home/user/src/not-a-project.tex":        "",
	} {
		if got := RelPath(in, "/data/projects/P/src"); got != want {
			t.Errorf("RelPath(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestArgs(t *testing.T) {
	var got []string
	tool := &Tool{Timeout: 1e9, Run: func(_ context.Context, dir string, args ...string) ([]byte, error) {
		got = append([]string{dir}, args...)
		return []byte(viewOut), nil
	}}
	if _, err := tool.Forward(context.Background(), "/src", "/b/output.pdf", "chapters/a b.tex", 10, 2); err != nil {
		t.Fatal(err)
	}
	if strings.Join(got, "|") != "/src|view|-i|10:2:chapters/a b.tex|-o|/b/output.pdf" {
		t.Errorf("args = %v", got)
	}
	tool.Run = func(_ context.Context, dir string, args ...string) ([]byte, error) {
		got = append([]string{dir}, args...)
		return []byte(editOut), nil
	}
	if _, err := tool.Inverse(context.Background(), "/data/projects/P/src", "/b/output.pdf", 2, 10.5, 20); err != nil {
		t.Fatal(err)
	}
	if strings.Join(got, "|") != "/data/projects/P/src|edit|-o|2:10.50:20.00:/b/output.pdf" {
		t.Errorf("args = %v", got)
	}
}
