package api

import (
	"archive/zip"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"

	"texdesk/internal/compiler"
	"texdesk/internal/export"
)

// GET /api/projects/{id}/export/md — Markdown via pandoc. A single .md when
// there are no images, otherwise a .zip with the .md and a media/ folder.
// Conversion warnings travel in X-Texdesk-Warnings (URL-encoded JSON array).
func (s *Server) exportMarkdown(w http.ResponseWriter, r *http.Request) error {
	m, err := s.store.Get(r.PathValue("id"))
	if err != nil {
		return err
	}
	if !s.caps.Pandoc.Available {
		return newErr(http.StatusServiceUnavailable, "tool_unavailable", "pandoc não está instalado no servidor")
	}
	if m.MainFile == "" {
		return newErr(http.StatusBadRequest, "no_main_file", "o projeto não tem arquivo principal")
	}
	work, err := os.MkdirTemp(s.store.TempDir(), "md-*")
	if err != nil {
		return err
	}
	defer os.RemoveAll(work)

	tools := export.Tools{Pandoc: s.caps.Pandoc.Path}
	if s.caps.Pdftoppm.Available {
		tools.Pdftoppm = s.caps.Pdftoppm.Path
	}
	if s.caps.Ghostscript.Available {
		tools.Gs = s.caps.Ghostscript.Path
	}
	// TikZ figures are rendered with the project's engine, when installed.
	engine := m.Compiler
	if engine == "latex" {
		engine = "pdflatex" // the figures must come out as PDF
	}
	if t := s.caps.Engine(engine); !t.Available {
		engine = ""
	}
	res, err := export.Markdown(r.Context(), export.Options{
		SrcDir: s.store.SrcDir(m.ID), MainFile: m.MainFile, WorkDir: work,
		Tools: tools, Timeout: s.cfg.CompileTimeout, Now: time.Now(),
		Engine: engine, EngineEnv: compiler.PolicyEnv(engine),
	})
	if err != nil {
		if errors.Is(err, export.ErrPandocMissing) {
			return newErr(http.StatusServiceUnavailable, "tool_unavailable", err.Error())
		}
		return newErr(http.StatusUnprocessableEntity, "export_failed", err.Error())
	}

	warn, _ := json.Marshal(res.Warnings)
	h := w.Header()
	h.Set("X-Texdesk-Warnings", url.QueryEscape(string(warn)))
	h.Set("X-Texdesk-Media", strconv.Itoa(len(res.Media)))
	h.Set("Cache-Control", "no-store")
	base := fileBase(m.Name)
	if len(res.Media) == 0 {
		h.Set("Content-Type", "text/markdown; charset=utf-8")
		h.Set("Content-Disposition", attachment(m.Name, ".md"))
		_, _ = w.Write(res.Markdown)
		return nil
	}
	h.Set("Content-Type", "application/zip")
	h.Set("Content-Disposition", attachment(m.Name, "-markdown.zip"))
	zw := zip.NewWriter(w)
	fw, err := zw.Create(base + ".md")
	if err == nil {
		_, err = fw.Write(res.Markdown)
	}
	for _, k := range res.SortedMedia() {
		if err != nil {
			break
		}
		if fw, err = zw.Create(k); err == nil {
			err = export.CopyFile(fw, res.Media[k])
		}
	}
	if err == nil {
		err = zw.Close()
	}
	if err != nil {
		// Headers are already sent; the truncated zip will fail to open.
		s.log.Error("markdown export failed", "id", m.ID, "err", err)
	}
	return nil
}

// fileBase is a file-system-safe version of a project name.
func fileBase(name string) string {
	base := strings.Map(func(r rune) rune {
		switch {
		case r < 0x20, r == 0x7f, strings.ContainsRune(`/\:*?"<>|`, r):
			return '_'
		}
		return r
	}, strings.TrimSpace(name))
	if base == "" || base == "." || base == ".." {
		base = "project"
	}
	return base
}
