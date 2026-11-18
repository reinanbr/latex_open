// Package api exposes the HTTP API and serves the embedded frontend.
package api

import (
	"errors"
	"io/fs"
	"log/slog"
	"net"
	"net/http"
	"path"
	"strings"
	"time"

	"texdesk/internal/archive"
	"texdesk/internal/compiler"
	"texdesk/internal/project"
	"texdesk/internal/synctex"
	"texdesk/internal/tools"
)

// Config holds runtime settings.
type Config struct {
	Addr           string
	MaxUploadBytes int64
	CompileTimeout time.Duration
	// AllowedHosts restricts the Host header (DNS-rebinding protection).
	// Empty means: loopback names only when Addr is a loopback address,
	// anything otherwise.
	AllowedHosts []string
	Limits       archive.Limits
	Static       fs.FS // built frontend (web/dist); may be nil
}

// Compiler exposes the compile manager (e.g. to install hooks).
func (s *Server) Compiler() *compiler.Manager { return s.comp }

// Server is the HTTP API.
type Server struct {
	cfg   Config
	store *project.Store
	caps  *tools.Capabilities
	comp  *compiler.Manager
	sync  *synctex.Tool
	log   *slog.Logger
	mux   *http.ServeMux

	onDelete func(id string) // e.g. cancel a running compile
	onClose  func()
}

// New builds the server and registers routes.
func New(cfg Config, store *project.Store, caps *tools.Capabilities, log *slog.Logger) *Server {
	if cfg.Limits.MaxFiles == 0 {
		cfg.Limits = archive.DefaultLimits
	}
	if cfg.MaxUploadBytes == 0 {
		cfg.MaxUploadBytes = 100 << 20
	}
	if len(cfg.AllowedHosts) == 0 && isLoopbackAddr(cfg.Addr) {
		cfg.AllowedHosts = []string{"localhost", "127.0.0.1", "::1"}
	}
	s := &Server{cfg: cfg, store: store, caps: caps, log: log, mux: http.NewServeMux()}
	s.comp = compiler.NewManager(cfg.CompileTimeout, log)
	s.sync = synctex.New()
	s.onDelete = s.comp.Cancel
	s.onClose = s.comp.CancelAll
	s.routes()
	return s
}

func (s *Server) routes() {
	m := s.mux
	m.HandleFunc("GET /api/health", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
	})
	m.HandleFunc("GET /api/capabilities", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, s.caps)
	})

	m.HandleFunc("POST /api/projects", s.h(s.createProject))
	m.HandleFunc("GET /api/projects", s.h(s.listProjects))
	m.HandleFunc("GET /api/projects/{id}", s.h(s.getProject))
	m.HandleFunc("PATCH /api/projects/{id}", s.h(s.patchProject))
	m.HandleFunc("DELETE /api/projects/{id}", s.h(s.deleteProject))

	m.HandleFunc("GET /api/projects/{id}/tree", s.h(s.getTree))
	m.HandleFunc("GET /api/projects/{id}/files/{path...}", s.h(s.getFile))
	m.HandleFunc("PUT /api/projects/{id}/files/{path...}", s.h(s.putFile))
	m.HandleFunc("POST /api/projects/{id}/files", s.h(s.createFile))
	m.HandleFunc("POST /api/projects/{id}/upload", s.h(s.upload))
	m.HandleFunc("PATCH /api/projects/{id}/files/{path...}", s.h(s.renameFile))
	m.HandleFunc("DELETE /api/projects/{id}/files/{path...}", s.h(s.deleteFile))

	m.HandleFunc("POST /api/projects/{id}/compile", s.h(s.compile))
	m.HandleFunc("GET /api/projects/{id}/compile/latest", s.h(s.latestBuild))
	m.HandleFunc("GET /api/projects/{id}/compile/{buildId}/pdf", s.h(s.buildPDF))
	m.HandleFunc("GET /api/projects/{id}/compile/{buildId}/log", s.h(s.buildLog))

	m.HandleFunc("GET /api/projects/{id}/synctex/forward", s.h(s.syncForward))
	m.HandleFunc("GET /api/projects/{id}/synctex/inverse", s.h(s.syncInverse))
	m.HandleFunc("GET /api/projects/{id}/index", s.h(s.projectIndex))
	m.HandleFunc("GET /api/projects/{id}/wordcount", s.h(s.wordCount))

	m.HandleFunc("GET /api/projects/{id}/export/zip", s.h(s.exportZip))
	m.HandleFunc("GET /api/projects/{id}/export/md", s.h(s.exportMarkdown))
	m.HandleFunc("GET /api/projects/{id}/export/pdf", s.h(s.exportPDF))

	m.HandleFunc("/api/", func(w http.ResponseWriter, r *http.Request) {
		s.writeError(w, r, newErr(http.StatusNotFound, "not_found", "no such endpoint"))
	})
	m.Handle("/", s.static())
}

// ServeHTTP applies the middleware chain.
func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	start := time.Now()
	rec := &statusRecorder{ResponseWriter: w, status: http.StatusOK}
	defer func() {
		if strings.HasPrefix(r.URL.Path, "/api/") {
			s.log.Info("http", "method", r.Method, "path", r.URL.Path, "status", rec.status,
				"dur_ms", time.Since(start).Milliseconds())
		}
	}()
	if !s.hostAllowed(r.Host) {
		s.writeError(rec, r, newErr(http.StatusForbidden, "forbidden_host", "host not allowed"))
		return
	}
	if err := checkCSRF(r); err != nil {
		s.writeError(rec, r, err)
		return
	}
	h := rec.Header()
	h.Set("X-Content-Type-Options", "nosniff")
	h.Set("Referrer-Policy", "no-referrer")
	// No framing (clickjacking: the app has destructive one-click actions),
	// no cross-origin embedding of project files, and a strict CSP for the
	// app (project files override it with a sandboxing CSP).
	h.Set("X-Frame-Options", "DENY")
	h.Set("Cross-Origin-Resource-Policy", "same-origin")
	h.Set("Cross-Origin-Opener-Policy", "same-origin")
	h.Set("Content-Security-Policy", appCSP)
	s.mux.ServeHTTP(rec, r)
}

// checkCSRF: the API has no auth, so state-changing requests must carry a
// custom header (forcing a CORS preflight that we never approve) and, when the
// browser sends an Origin, it must match the Host.
func checkCSRF(r *http.Request) error {
	switch r.Method {
	case http.MethodGet, http.MethodHead, http.MethodOptions:
		return nil
	}
	if !strings.HasPrefix(r.URL.Path, "/api/") {
		return nil
	}
	if r.Header.Get("X-Texdesk") == "" {
		return newErr(http.StatusForbidden, "csrf", "missing X-Texdesk header")
	}
	if o := r.Header.Get("Origin"); o != "" && o != "null" {
		if host := strings.TrimPrefix(strings.TrimPrefix(o, "http://"), "https://"); host != r.Host {
			return newErr(http.StatusForbidden, "csrf", "cross-origin request rejected")
		}
	}
	return nil
}

// appCSP: everything from our own origin. Inline styles are needed by
// CodeMirror and React style attributes; blob: workers/images by pdf.js;
// wasm-unsafe-eval lets pdf.js use its WebAssembly image decoders.
const appCSP = "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; " +
	"img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; worker-src 'self' blob:; " +
	"object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'"

func (s *Server) hostAllowed(hostport string) bool {
	if len(s.cfg.AllowedHosts) == 0 {
		return true
	}
	host := hostport
	if h, _, err := net.SplitHostPort(hostport); err == nil {
		host = h
	}
	host = strings.Trim(host, "[]")
	for _, a := range s.cfg.AllowedHosts {
		if a == "*" || strings.EqualFold(a, host) {
			return true
		}
	}
	return false
}

func isLoopbackAddr(addr string) bool {
	host, _, err := net.SplitHostPort(addr)
	if err != nil {
		host = addr
	}
	if host == "localhost" {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

type statusRecorder struct {
	http.ResponseWriter
	status int
	wrote  bool
}

func (r *statusRecorder) WriteHeader(code int) {
	if !r.wrote {
		r.status, r.wrote = code, true
	}
	r.ResponseWriter.WriteHeader(code)
}

func (r *statusRecorder) Flush() {
	if f, ok := r.ResponseWriter.(http.Flusher); ok {
		f.Flush()
	}
}

func (r *statusRecorder) Unwrap() http.ResponseWriter { return r.ResponseWriter }

// static serves the SPA: real files as-is, every other non-API path falls back
// to index.html so client-side routes work on reload.
func (s *Server) static() http.Handler {
	if s.cfg.Static == nil {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			http.Error(w, "frontend not built (run `make build`)", http.StatusNotFound)
		})
	}
	files := http.FileServerFS(s.cfg.Static)
	gz := &gzipCache{fsys: s.cfg.Static, m: map[string][]byte{}}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		p := strings.TrimPrefix(path.Clean(r.URL.Path), "/")
		if p != "" {
			if fi, err := fs.Stat(s.cfg.Static, p); err == nil && !fi.IsDir() {
				if strings.HasPrefix(p, "assets/") {
					w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
				}
				if gz.serve(w, r, p) {
					return
				}
				files.ServeHTTP(w, r)
				return
			} else if err != nil && !errors.Is(err, fs.ErrNotExist) {
				http.Error(w, "internal error", http.StatusInternalServerError)
				return
			}
		}
		w.Header().Set("Cache-Control", "no-cache")
		http.ServeFileFS(w, r, s.cfg.Static, "index.html")
	})
}

// Close releases background resources (running compilations).
func (s *Server) Close() {
	if s.onClose != nil {
		s.onClose()
	}
}
