package api

import (
	"errors"
	"net/http"
	"strconv"

	"texdesk/internal/compiler"
	"texdesk/internal/project"
	"texdesk/internal/synctex"
	"texdesk/internal/texindex"
)

// pdfForSync returns the PDF of the requested build (or the newest one with
// a PDF); SyncTeX must use the same build the user is looking at.
func (s *Server) pdfForSync(r *http.Request, m *project.Meta) (string, error) {
	if !s.caps.Synctex.Available {
		return "", newErr(http.StatusServiceUnavailable, "tool_unavailable", "synctex não está instalado no servidor")
	}
	build := s.store.BuildDir(m.ID)
	id := r.URL.Query().Get("buildId")
	if id == "" {
		latest := compiler.Latest(build, true)
		if latest == nil {
			return "", newErr(http.StatusConflict, "no_pdf", "compile o projeto primeiro")
		}
		id = latest.BuildID
	}
	p, ok := compiler.OutputPath(build, id, "output.pdf")
	if !ok {
		return "", newErr(http.StatusNotFound, "no_pdf", "build não encontrada")
	}
	if _, ok := compiler.OutputPath(build, id, "output.synctex.gz"); !ok {
		return "", newErr(http.StatusConflict, "no_synctex", "esta build não tem dados de SyncTeX")
	}
	return p, nil
}

func queryInt(r *http.Request, k string) (int, error) {
	v, err := strconv.Atoi(r.URL.Query().Get(k))
	if err != nil {
		return 0, newErr(http.StatusBadRequest, "invalid_request", "parâmetro "+k+" inválido")
	}
	return v, nil
}

func queryFloat(r *http.Request, k string) (float64, error) {
	v, err := strconv.ParseFloat(r.URL.Query().Get(k), 64)
	if err != nil {
		return 0, newErr(http.StatusBadRequest, "invalid_request", "parâmetro "+k+" inválido")
	}
	return v, nil
}

// GET /api/projects/{id}/synctex/forward?file=&line=&col=[&buildId=]
func (s *Server) syncForward(w http.ResponseWriter, r *http.Request) error {
	m, err := s.store.Get(r.PathValue("id"))
	if err != nil {
		return err
	}
	file, err := project.CleanRel(r.URL.Query().Get("file"))
	if err != nil {
		return err
	}
	line, err := queryInt(r, "line")
	if err != nil {
		return err
	}
	col, _ := strconv.Atoi(r.URL.Query().Get("col"))
	pdf, err := s.pdfForSync(r, m)
	if err != nil {
		return err
	}
	box, err := s.sync.Forward(r.Context(), s.store.SrcDir(m.ID), pdf, file, line, col)
	if errors.Is(err, synctex.ErrNoMatch) {
		return newErr(http.StatusNotFound, "no_match", "posição não encontrada no PDF (o arquivo faz parte do documento compilado?)")
	}
	if err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, box)
	return nil
}

// GET /api/projects/{id}/synctex/inverse?page=&x=&y=[&buildId=]
func (s *Server) syncInverse(w http.ResponseWriter, r *http.Request) error {
	m, err := s.store.Get(r.PathValue("id"))
	if err != nil {
		return err
	}
	page, err := queryInt(r, "page")
	if err != nil {
		return err
	}
	x, err := queryFloat(r, "x")
	if err != nil {
		return err
	}
	y, err := queryFloat(r, "y")
	if err != nil {
		return err
	}
	pdf, err := s.pdfForSync(r, m)
	if err != nil {
		return err
	}
	loc, err := s.sync.Inverse(r.Context(), s.store.SrcDir(m.ID), pdf, page, x, y)
	if errors.Is(err, synctex.ErrNoMatch) {
		return newErr(http.StatusNotFound, "no_match", "nenhuma linha do código corresponde a esse ponto")
	}
	if err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, loc)
	return nil
}

// GET /api/projects/{id}/index — labels, bib keys, macros, environments.
func (s *Server) projectIndex(w http.ResponseWriter, r *http.Request) error {
	m, err := s.store.Get(r.PathValue("id"))
	if err != nil {
		return err
	}
	idx, err := texindex.Build(s.store.SrcDir(m.ID))
	if err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, idx)
	return nil
}

// GET /api/projects/{id}/wordcount
func (s *Server) wordCount(w http.ResponseWriter, r *http.Request) error {
	m, err := s.store.Get(r.PathValue("id"))
	if err != nil {
		return err
	}
	if !s.caps.Texcount.Available {
		return newErr(http.StatusServiceUnavailable, "tool_unavailable", "texcount não está instalado no servidor")
	}
	if m.MainFile == "" {
		return newErr(http.StatusBadRequest, "no_main_file", "o projeto não tem arquivo principal")
	}
	wc, err := texindex.CountWords(r.Context(), s.store.SrcDir(m.ID), m.MainFile)
	if err != nil {
		return newErr(http.StatusBadGateway, "texcount_failed", "texcount falhou: "+err.Error())
	}
	writeJSON(w, http.StatusOK, wc)
	return nil
}
