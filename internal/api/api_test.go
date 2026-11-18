package api

import (
	"archive/zip"
	"bytes"
	"compress/gzip"
	"encoding/json"
	"io"
	"log/slog"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"testing/fstest"

	"texdesk/internal/project"
	"texdesk/internal/tools"
)

type testEnv struct {
	t     *testing.T
	srv   *Server
	store *project.Store
}

func newEnv(t *testing.T) *testEnv {
	t.Helper()
	store, err := project.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	static := fstest.MapFS{
		"index.html":     {Data: []byte("<html>app</html>")},
		"assets/app.js":  {Data: []byte("console.log(1)")},
		"assets/kb.json": {Data: []byte(`{"cmds":"` + strings.Repeat("textbf section ", 400) + `"}`)},
	}
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	srv := New(Config{Addr: "127.0.0.1:8080", MaxUploadBytes: 1 << 20, Static: static}, store, &tools.Capabilities{}, log)
	return &testEnv{t: t, srv: srv, store: store}
}

func (e *testEnv) do(method, url string, body io.Reader, hdr map[string]string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, url, body)
	req.Host = "127.0.0.1:8080"
	if method != http.MethodGet {
		req.Header.Set("X-Texdesk", "1")
	}
	for k, v := range hdr {
		req.Header.Set(k, v)
	}
	rec := httptest.NewRecorder()
	e.srv.ServeHTTP(rec, req)
	return rec
}

func (e *testEnv) json(method, url string, v any) *httptest.ResponseRecorder {
	var body io.Reader
	if v != nil {
		b, _ := json.Marshal(v)
		body = bytes.NewReader(b)
	}
	return e.do(method, url, body, map[string]string{"Content-Type": "application/json"})
}

func expect(t *testing.T, rec *httptest.ResponseRecorder, status int) {
	t.Helper()
	if rec.Code != status {
		t.Fatalf("status = %d, want %d; body: %s", rec.Code, status, rec.Body.String())
	}
}

func errorCode(t *testing.T, rec *httptest.ResponseRecorder) string {
	t.Helper()
	var body struct {
		Error struct {
			Code    string `json:"code"`
			Message string `json:"message"`
		} `json:"error"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil || body.Error.Code == "" {
		t.Fatalf("not a JSON error body: %s", rec.Body.String())
	}
	return body.Error.Code
}

func zipUpload(t *testing.T, files map[string]string) (io.Reader, string) {
	t.Helper()
	var zbuf bytes.Buffer
	zw := zip.NewWriter(&zbuf)
	for name, body := range files {
		w, _ := zw.Create(name)
		w.Write([]byte(body))
	}
	zw.Close()
	var body bytes.Buffer
	mw := multipart.NewWriter(&body)
	fw, _ := mw.CreateFormFile("file", "my-paper.zip")
	fw.Write(zbuf.Bytes())
	mw.Close()
	return &body, mw.FormDataContentType()
}

func TestProjectLifecycle(t *testing.T) {
	e := newEnv(t)
	body, ct := zipUpload(t, map[string]string{
		"paper/main.tex":           "\\documentclass{article}\n\\begin{document}\n\\input{chapters/intro}\n\\end{document}\n",
		"paper/chapters/intro.tex": "Hello",
		"paper/main.aux":           "junk",
	})
	rec := e.do("POST", "/api/projects", body, map[string]string{"Content-Type": ct})
	expect(t, rec, http.StatusCreated)
	var created createResponse
	json.Unmarshal(rec.Body.Bytes(), &created)
	id := created.Project.ID
	if created.Project.Name != "my-paper" || created.Project.MainFile != "main.tex" {
		t.Fatalf("unexpected project %+v", created.Project)
	}

	rec = e.do("GET", "/api/projects", nil, nil)
	expect(t, rec, http.StatusOK)
	if !strings.Contains(rec.Body.String(), id) {
		t.Error("project not listed")
	}

	rec = e.do("GET", "/api/projects/"+id+"/tree", nil, nil)
	expect(t, rec, http.StatusOK)
	if strings.Contains(rec.Body.String(), "main.aux") || !strings.Contains(rec.Body.String(), "chapters/intro.tex") {
		t.Errorf("unexpected tree: %s", rec.Body.String())
	}

	rec = e.do("GET", "/api/projects/"+id+"/files/chapters/intro.tex", nil, nil)
	expect(t, rec, http.StatusOK)
	if rec.Body.String() != "Hello" || !strings.HasPrefix(rec.Header().Get("Content-Type"), "text/plain") {
		t.Errorf("file: %q %s", rec.Body.String(), rec.Header().Get("Content-Type"))
	}
	if !strings.Contains(rec.Header().Get("Content-Security-Policy"), "sandbox") {
		t.Error("file responses must be sandboxed")
	}

	rec = e.do("PUT", "/api/projects/"+id+"/files/chapters/intro.tex", strings.NewReader("Olá mundo"), nil)
	expect(t, rec, http.StatusOK)
	rec = e.do("GET", "/api/projects/"+id+"/files/chapters/intro.tex", nil, nil)
	if rec.Body.String() != "Olá mundo" {
		t.Errorf("after PUT: %q", rec.Body.String())
	}

	// Paths with spaces / escapes.
	rec = e.json("POST", "/api/projects/"+id+"/files", map[string]string{"path": "figuras/minha figura.txt", "type": "file"})
	expect(t, rec, http.StatusCreated)
	rec = e.do("GET", "/api/projects/"+id+"/files/figuras/minha%20figura.txt", nil, nil)
	expect(t, rec, http.StatusOK)

	rec = e.json("PATCH", "/api/projects/"+id+"/files/chapters/intro.tex", map[string]string{"newPath": "chapters/introducao.tex"})
	expect(t, rec, http.StatusOK)
	rec = e.json("PATCH", "/api/projects/"+id, map[string]string{"name": "Artigo", "compiler": "lualatex"})
	expect(t, rec, http.StatusOK)

	rec = e.json("PATCH", "/api/projects/"+id, map[string]string{"compiler": "tectonic"})
	expect(t, rec, http.StatusBadRequest)
	if errorCode(t, rec) != "invalid_request" {
		t.Error("wrong error code")
	}

	rec = e.do("GET", "/api/projects/"+id+"/export/zip", nil, nil)
	expect(t, rec, http.StatusOK)
	if cd := rec.Header().Get("Content-Disposition"); !strings.Contains(cd, "Artigo.zip") {
		t.Errorf("Content-Disposition = %q", cd)
	}
	zr, err := zip.NewReader(bytes.NewReader(rec.Body.Bytes()), int64(rec.Body.Len()))
	if err != nil {
		t.Fatal(err)
	}
	for _, f := range zr.File {
		if strings.HasPrefix(f.Name, "build") || strings.HasSuffix(f.Name, "meta.json") {
			t.Errorf("export contains %s", f.Name)
		}
	}

	rec = e.do("DELETE", "/api/projects/"+id+"/files/figuras", nil, nil)
	expect(t, rec, http.StatusNoContent)
	rec = e.do("DELETE", "/api/projects/"+id, nil, nil)
	expect(t, rec, http.StatusNoContent)
	rec = e.do("GET", "/api/projects/"+id, nil, nil)
	expect(t, rec, http.StatusNotFound)
	if errorCode(t, rec) != "not_found" {
		t.Error("wrong code")
	}
}

func TestBlankProject(t *testing.T) {
	e := newEnv(t)
	rec := e.json("POST", "/api/projects", map[string]string{"name": "Novo", "template": "blank"})
	expect(t, rec, http.StatusCreated)
	rec = e.json("POST", "/api/projects", map[string]string{"template": "thesis"})
	expect(t, rec, http.StatusBadRequest)
}

func TestTraversalRejected(t *testing.T) {
	e := newEnv(t)
	m, _ := e.store.CreateBlank("x")
	for _, p := range []string{
		"/api/projects/" + m.ID + "/files/..%2fmeta.json",
		"/api/projects/" + m.ID + "/files/a/..%2f..%2fmeta.json",
		"/api/projects/" + m.ID + "/files/%2fetc%2fpasswd",
	} {
		rec := e.do("GET", p, nil, nil)
		if rec.Code == http.StatusOK {
			t.Errorf("GET %s succeeded: %s", p, rec.Body.String())
		}
	}
	rec := e.json("POST", "/api/projects/"+m.ID+"/files", map[string]string{"path": "../evil.tex", "type": "file"})
	expect(t, rec, http.StatusBadRequest)
	if errorCode(t, rec) != "invalid_path" {
		t.Error("wrong code")
	}
	rec = e.json("PATCH", "/api/projects/"+m.ID+"/files/main.tex", map[string]string{"newPath": "../../escaped.tex"})
	expect(t, rec, http.StatusBadRequest)
	rec = e.do("GET", "/api/projects/..%2f..%2fetc/tree", nil, nil)
	if rec.Code == http.StatusOK {
		t.Error("bad project id accepted")
	}
}

func TestUpload(t *testing.T) {
	e := newEnv(t)
	m, _ := e.store.CreateBlank("x")
	var body bytes.Buffer
	mw := multipart.NewWriter(&body)
	mw.WriteField("dir", "figures")
	for _, n := range []string{"a.png", "b.bib", ".DS_Store"} {
		fw, _ := mw.CreateFormFile("files", n)
		fw.Write([]byte("data-" + n))
	}
	mw.Close()
	rec := e.do("POST", "/api/projects/"+m.ID+"/upload", &body, map[string]string{"Content-Type": mw.FormDataContentType()})
	expect(t, rec, http.StatusOK)
	var res struct{ Uploaded, Skipped []string }
	json.Unmarshal(rec.Body.Bytes(), &res)
	if strings.Join(res.Uploaded, ",") != "figures/a.png,figures/b.bib" || len(res.Skipped) != 1 {
		t.Errorf("upload result %+v", res)
	}
	rec = e.do("GET", "/api/projects/"+m.ID+"/files/figures/a.png", nil, nil)
	expect(t, rec, http.StatusOK)
	if rec.Header().Get("Content-Type") != "image/png" {
		t.Errorf("content-type = %s", rec.Header().Get("Content-Type"))
	}
}

func TestZipErrors(t *testing.T) {
	e := newEnv(t)
	var body bytes.Buffer
	mw := multipart.NewWriter(&body)
	fw, _ := mw.CreateFormFile("file", "x.zip")
	fw.Write([]byte("not a zip"))
	mw.Close()
	rec := e.do("POST", "/api/projects", &body, map[string]string{"Content-Type": mw.FormDataContentType()})
	expect(t, rec, http.StatusBadRequest)
	if errorCode(t, rec) != "zip_invalid" {
		t.Error("wrong code")
	}

	b, ct := zipUpload(t, map[string]string{"main.tex": "x", "../evil.tex": "x"})
	rec = e.do("POST", "/api/projects", b, map[string]string{"Content-Type": ct})
	expect(t, rec, http.StatusBadRequest)
	if errorCode(t, rec) != "zip_unsafe_path" {
		t.Error("wrong code")
	}

	// Over the upload limit (1 MB in tests).
	b, ct = zipUpload(t, map[string]string{"main.tex": randomish(2 << 20)})
	rec = e.do("POST", "/api/projects", b, map[string]string{"Content-Type": ct})
	expect(t, rec, http.StatusRequestEntityTooLarge)
}

func randomish(n int) string {
	var sb strings.Builder
	x := uint32(2463534242)
	for sb.Len() < n {
		x ^= x << 13
		x ^= x >> 17
		x ^= x << 5
		sb.WriteByte(byte('!' + x%90))
	}
	return sb.String()
}

func TestSecurityMiddleware(t *testing.T) {
	e := newEnv(t)
	// Missing CSRF header.
	req := httptest.NewRequest("POST", "/api/projects", strings.NewReader(`{}`))
	req.Host = "127.0.0.1:8080"
	rec := httptest.NewRecorder()
	e.srv.ServeHTTP(rec, req)
	expect(t, rec, http.StatusForbidden)

	// Cross-origin.
	rec = e.do("POST", "/api/projects", strings.NewReader(`{}`), map[string]string{"Origin": "http://evil.example"})
	expect(t, rec, http.StatusForbidden)

	// DNS rebinding: foreign Host header.
	req = httptest.NewRequest("GET", "/api/projects", nil)
	req.Host = "evil.example:8080"
	rec = httptest.NewRecorder()
	e.srv.ServeHTTP(rec, req)
	expect(t, rec, http.StatusForbidden)

	// localhost alias is fine.
	req = httptest.NewRequest("GET", "/api/projects", nil)
	req.Host = "localhost:8080"
	rec = httptest.NewRecorder()
	e.srv.ServeHTTP(rec, req)
	expect(t, rec, http.StatusOK)
}

func TestSecurityHeaders(t *testing.T) {
	e := newEnv(t)
	rec := e.do("GET", "/", nil, nil)
	h := rec.Header()
	if h.Get("X-Frame-Options") != "DENY" || !strings.Contains(h.Get("Content-Security-Policy"), "frame-ancestors 'none'") ||
		!strings.Contains(h.Get("Content-Security-Policy"), "script-src 'self'") || h.Get("Cross-Origin-Resource-Policy") != "same-origin" {
		t.Errorf("headers = %v", h)
	}
	// Project files keep their own sandboxing CSP.
	m, _ := e.store.CreateBlank("x")
	rec = e.do("GET", "/api/projects/"+m.ID+"/files/main.tex", nil, nil)
	if csp := rec.Header().Get("Content-Security-Policy"); !strings.HasPrefix(csp, "sandbox") {
		t.Errorf("file CSP = %q", csp)
	}
}

func TestStaticSPA(t *testing.T) {
	e := newEnv(t)
	rec := e.do("GET", "/", nil, nil)
	expect(t, rec, http.StatusOK)
	if !strings.Contains(rec.Body.String(), "app") {
		t.Error("index not served")
	}
	rec = e.do("GET", "/project/01ABC", nil, nil)
	expect(t, rec, http.StatusOK)
	if !strings.Contains(rec.Body.String(), "app") {
		t.Error("SPA fallback failed")
	}
	rec = e.do("GET", "/assets/app.js", nil, nil)
	expect(t, rec, http.StatusOK)
	if !strings.Contains(rec.Header().Get("Cache-Control"), "immutable") {
		t.Error("assets should be immutable-cached")
	}
	rec = e.do("GET", "/api/nope", nil, nil)
	expect(t, rec, http.StatusNotFound)
	errorCode(t, rec)
}

func TestStaticGzip(t *testing.T) {
	e := newEnv(t)
	rec := e.do("GET", "/assets/kb.json", nil, map[string]string{"Accept-Encoding": "gzip, deflate, br"})
	expect(t, rec, http.StatusOK)
	if rec.Header().Get("Content-Encoding") != "gzip" || !strings.HasPrefix(rec.Header().Get("Content-Type"), "application/json") {
		t.Fatalf("headers = %v", rec.Header())
	}
	zr, err := gzip.NewReader(rec.Body)
	if err != nil {
		t.Fatal(err)
	}
	raw, _ := io.ReadAll(zr)
	if !strings.Contains(string(raw), "textbf section") || rec.Body.Len() > len(raw)/5 {
		t.Errorf("gzip body: %d bytes for %d", rec.Body.Len(), len(raw))
	}
	// Not accepted, too small, or a range request: served as is.
	for _, h := range []map[string]string{{}, {"Accept-Encoding": "gzip;q=0"}, {"Accept-Encoding": "gzip", "Range": "bytes=0-10"}} {
		if rec := e.do("GET", "/assets/kb.json", nil, h); rec.Header().Get("Content-Encoding") != "" {
			t.Errorf("%v: compressed", h)
		}
	}
	rec = e.do("GET", "/assets/app.js", nil, map[string]string{"Accept-Encoding": "gzip"})
	if rec.Header().Get("Content-Encoding") != "" || rec.Body.String() != "console.log(1)" {
		t.Error("small file should not be compressed")
	}
}

func TestToolsUnavailable(t *testing.T) {
	e := newEnv(t)
	m, _ := e.store.CreateBlank("x")
	for _, u := range []string{"export/md", "wordcount", "synctex/forward?file=main.tex&line=1", "synctex/inverse?page=1&x=1&y=1"} {
		rec := e.do("GET", "/api/projects/"+m.ID+"/"+u, nil, nil)
		expect(t, rec, http.StatusServiceUnavailable)
		if !strings.Contains(rec.Body.String(), `"code":"tool_unavailable"`) {
			t.Errorf("%s: %s", u, rec.Body.String())
		}
	}
}
