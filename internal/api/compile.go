package api

import (
	"errors"
	"io"
	"net/http"
	"os"

	"texdesk/internal/compiler"
	"texdesk/internal/project"
)

// POST /api/projects/{id}/compile  {compiler?, draft?, stopOnFirstError?}
func (s *Server) compile(w http.ResponseWriter, r *http.Request) error {
	id := r.PathValue("id")
	m, err := s.store.Get(id)
	if err != nil {
		return err
	}
	var opts compiler.Options
	if r.ContentLength != 0 {
		if err := decodeJSON(r, &opts); err != nil && !errors.Is(err, io.EOF) {
			return err
		}
	}
	res, err := s.runCompile(r, m, opts)
	if err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, res)
	return nil
}

func (s *Server) runCompile(r *http.Request, m *project.Meta, opts compiler.Options) (*compiler.Result, error) {
	if opts.Compiler == "" {
		opts.Compiler = m.Compiler
	}
	if _, ok := compiler.Engines[opts.Compiler]; !ok {
		return nil, newErr(http.StatusBadRequest, "invalid_request", "compiler must be pdflatex, latex, xelatex or lualatex")
	}
	if !s.caps.Latexmk.Available {
		return nil, newErr(http.StatusServiceUnavailable, "tool_unavailable", "latexmk não está instalado no servidor")
	}
	if t := s.caps.Engine(opts.Compiler); !t.Available {
		return nil, newErr(http.StatusServiceUnavailable, "tool_unavailable", opts.Compiler+" não está instalado no servidor")
	}
	if m.MainFile == "" {
		return nil, newErr(http.StatusBadRequest, "no_main_file", "defina o arquivo principal do projeto antes de compilar")
	}
	res, err := s.comp.Compile(r.Context(), compiler.Request{
		ProjectID: m.ID,
		SrcDir:    s.store.SrcDir(m.ID),
		BuildDir:  s.store.BuildDir(m.ID),
		MainFile:  m.MainFile,
		Options:   opts,
	})
	if errors.Is(err, compiler.ErrNoMainFile) {
		return nil, newErr(http.StatusBadRequest, "no_main_file", "defina o arquivo principal do projeto antes de compilar")
	}
	if err != nil {
		return nil, newErr(http.StatusBadRequest, "compile_failed", err.Error())
	}
	return res, nil
}

// GET /api/projects/{id}/compile/latest — last build result (without log).
func (s *Server) latestBuild(w http.ResponseWriter, r *http.Request) error {
	m, err := s.store.Get(r.PathValue("id"))
	if err != nil {
		return err
	}
	res := compiler.Latest(s.store.BuildDir(m.ID), false)
	if res == nil {
		return newErr(http.StatusNotFound, "no_build", "o projeto ainda não foi compilado")
	}
	writeJSON(w, http.StatusOK, res)
	return nil
}

// GET /api/projects/{id}/compile/{buildId}/pdf
func (s *Server) buildPDF(w http.ResponseWriter, r *http.Request) error {
	m, err := s.store.Get(r.PathValue("id"))
	if err != nil {
		return err
	}
	p, ok := compiler.OutputPath(s.store.BuildDir(m.ID), r.PathValue("buildId"), "output.pdf")
	if !ok {
		return newErr(http.StatusNotFound, "not_found", "PDF not available for this build")
	}
	// Build ids are unique, so the content never changes.
	w.Header().Set("Cache-Control", "private, max-age=31536000, immutable")
	if r.URL.Query().Get("download") == "1" {
		w.Header().Set("Content-Disposition", attachment(m.Name, ".pdf"))
	}
	return servePDF(w, r, p)
}

// GET /api/projects/{id}/compile/{buildId}/log
func (s *Server) buildLog(w http.ResponseWriter, r *http.Request) error {
	m, err := s.store.Get(r.PathValue("id"))
	if err != nil {
		return err
	}
	p, ok := compiler.OutputPath(s.store.BuildDir(m.ID), r.PathValue("buildId"), "output.log")
	if !ok {
		return newErr(http.StatusNotFound, "not_found", "log not available for this build")
	}
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.Header().Set("Cache-Control", "private, max-age=31536000, immutable")
	http.ServeFile(w, r, p)
	return nil
}

// GET /api/projects/{id}/export/pdf — newest PDF; compiles first if needed.
func (s *Server) exportPDF(w http.ResponseWriter, r *http.Request) error {
	m, err := s.store.Get(r.PathValue("id"))
	if err != nil {
		return err
	}
	build := s.store.BuildDir(m.ID)
	latest := compiler.Latest(build, true)
	if latest == nil || latest.StartedAt.Before(m.UpdatedAt) {
		// No PDF yet, or sources changed since: compile now.
		res, err := s.runCompile(r, m, compiler.Options{})
		if err != nil {
			if latest == nil {
				return err
			}
		} else if res.PDFAvailable {
			latest = res
		}
	}
	if latest == nil || !latest.PDFAvailable {
		return newErr(http.StatusConflict, "no_pdf", "a compilação não gerou um PDF; corrija os erros e tente de novo")
	}
	p, ok := compiler.OutputPath(build, latest.BuildID, "output.pdf")
	if !ok {
		return newErr(http.StatusNotFound, "no_pdf", "PDF não encontrado")
	}
	w.Header().Set("Content-Disposition", attachment(m.Name, ".pdf"))
	w.Header().Set("Cache-Control", "no-store")
	return servePDF(w, r, p)
}

func servePDF(w http.ResponseWriter, r *http.Request, p string) error {
	f, err := os.Open(p)
	if err != nil {
		return err
	}
	defer f.Close()
	fi, err := f.Stat()
	if err != nil {
		return err
	}
	w.Header().Set("Content-Type", "application/pdf")
	http.ServeContent(w, r, "output.pdf", fi.ModTime(), f)
	return nil
}
