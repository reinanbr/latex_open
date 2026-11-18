package api

import (
	"bytes"
	"compress/gzip"
	"io/fs"
	"mime"
	"net/http"
	"path"
	"strconv"
	"strings"
	"sync"
)

// gzipCache compresses compressible static assets once (they are embedded
// and immutable) and serves them to clients that accept gzip.
type gzipCache struct {
	fsys fs.FS
	mu   sync.Mutex
	m    map[string][]byte // nil value = not worth compressing
}

var compressible = map[string]bool{".js": true, ".mjs": true, ".css": true, ".json": true, ".svg": true, ".html": true, ".map": true}

// serve writes the compressed file and reports true, or false to let the
// caller serve it as is.
func (g *gzipCache) serve(w http.ResponseWriter, r *http.Request, name string) bool {
	if r.Header.Get("Range") != "" || !acceptsGzip(r.Header.Get("Accept-Encoding")) || !compressible[path.Ext(name)] {
		return false
	}
	g.mu.Lock()
	body, done := g.m[name]
	if !done {
		body = g.compress(name)
		g.m[name] = body
	}
	g.mu.Unlock()
	if body == nil {
		return false
	}
	h := w.Header()
	if ct := mime.TypeByExtension(path.Ext(name)); ct != "" {
		h.Set("Content-Type", ct)
	}
	h.Set("Content-Encoding", "gzip")
	h.Add("Vary", "Accept-Encoding")
	h.Set("Content-Length", strconv.Itoa(len(body)))
	w.WriteHeader(http.StatusOK)
	if r.Method != http.MethodHead {
		_, _ = w.Write(body)
	}
	return true
}

func (g *gzipCache) compress(name string) []byte {
	raw, err := fs.ReadFile(g.fsys, name)
	if err != nil || len(raw) < 1024 {
		return nil
	}
	var b bytes.Buffer
	zw, _ := gzip.NewWriterLevel(&b, gzip.BestCompression)
	_, _ = zw.Write(raw)
	if zw.Close() != nil || b.Len() >= len(raw)*9/10 {
		return nil
	}
	return b.Bytes()
}

func acceptsGzip(h string) bool {
	for _, part := range strings.Split(h, ",") {
		enc, params, _ := strings.Cut(strings.TrimSpace(part), ";")
		if strings.EqualFold(strings.TrimSpace(enc), "gzip") || strings.TrimSpace(enc) == "*" {
			q := strings.TrimSpace(params)
			return !(strings.HasPrefix(q, "q=0") && strings.Trim(strings.TrimPrefix(q, "q="), "0.") == "")
		}
	}
	return false
}
