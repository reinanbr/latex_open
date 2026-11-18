package api

import (
	"encoding/json"
	"errors"
	"io"
	"mime"
	"net/http"
	"os"
	"strings"

	"texdesk/internal/archive"
	"texdesk/internal/project"
)

func decodeJSON(r *http.Request, v any) error {
	dec := json.NewDecoder(io.LimitReader(r.Body, 1<<20))
	dec.DisallowUnknownFields()
	if err := dec.Decode(v); err != nil {
		return newErr(http.StatusBadRequest, "invalid_json", "invalid JSON body: "+err.Error())
	}
	return nil
}

type createResponse struct {
	Project  *project.Meta `json:"project"`
	Warnings []string      `json:"warnings"`
}

// POST /api/projects — multipart with a "file" (zip) and optional "name",
// or JSON {name, template:"blank"}.
func (s *Server) createProject(w http.ResponseWriter, r *http.Request) error {
	ct, _, _ := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if ct == "multipart/form-data" {
		return s.importZip(w, r)
	}
	var body struct {
		Name     string `json:"name"`
		Template string `json:"template"`
	}
	if err := decodeJSON(r, &body); err != nil {
		return err
	}
	if body.Template != "" && body.Template != "blank" {
		return newErr(http.StatusBadRequest, "invalid_request", `template must be "blank"`)
	}
	m, err := s.store.CreateBlank(body.Name)
	if err != nil {
		return err
	}
	s.log.Info("project created", "id", m.ID, "template", "blank")
	writeJSON(w, http.StatusCreated, createResponse{Project: m, Warnings: []string{}})
	return nil
}

func (s *Server) importZip(w http.ResponseWriter, r *http.Request) error {
	r.Body = http.MaxBytesReader(w, r.Body, s.cfg.MaxUploadBytes+1<<20)
	mr, err := r.MultipartReader()
	if err != nil {
		return newErr(http.StatusBadRequest, "invalid_request", "invalid multipart body")
	}
	var name string
	var tmp *os.File
	var size int64
	defer func() {
		if tmp != nil {
			tmp.Close()
			os.Remove(tmp.Name())
		}
	}()
	for {
		part, err := mr.NextPart()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return mapBodyErr(err)
		}
		switch part.FormName() {
		case "name":
			b, _ := io.ReadAll(io.LimitReader(part, 1024))
			name = string(b)
		case "file":
			if tmp != nil {
				return newErr(http.StatusBadRequest, "invalid_request", "only one zip file per request")
			}
			tmp, err = os.CreateTemp(s.store.TempDir(), "upload-*.zip")
			if err != nil {
				return err
			}
			size, err = io.Copy(tmp, io.LimitReader(part, s.cfg.MaxUploadBytes+1))
			if err != nil {
				return mapBodyErr(err)
			}
			if size > s.cfg.MaxUploadBytes {
				return newErr(http.StatusRequestEntityTooLarge, "too_large",
					"zip exceeds the maximum upload size")
			}
			if name == "" {
				name = strings.TrimSuffix(part.FileName(), ".zip")
			}
		}
		part.Close()
	}
	if tmp == nil {
		return newErr(http.StatusBadRequest, "invalid_request", `missing "file" part`)
	}
	m, warnings, err := s.store.Import(tmp, size, name, s.cfg.Limits)
	if err != nil {
		return err
	}
	if warnings == nil {
		warnings = []string{}
	}
	s.log.Info("project imported", "id", m.ID, "main", m.MainFile, "compiler", m.Compiler, "bytes", size)
	writeJSON(w, http.StatusCreated, createResponse{Project: m, Warnings: warnings})
	return nil
}

func mapBodyErr(err error) error {
	var mbe *http.MaxBytesError
	if errors.As(err, &mbe) {
		return err
	}
	return newErr(http.StatusBadRequest, "invalid_request", "could not read request body")
}

func (s *Server) listProjects(w http.ResponseWriter, r *http.Request) error {
	list, err := s.store.List()
	if err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, list)
	return nil
}

func (s *Server) getProject(w http.ResponseWriter, r *http.Request) error {
	m, err := s.store.Touch(r.PathValue("id"))
	if err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, m)
	return nil
}

func (s *Server) patchProject(w http.ResponseWriter, r *http.Request) error {
	var p project.Patch
	if err := decodeJSON(r, &p); err != nil {
		return err
	}
	m, err := s.store.Update(r.PathValue("id"), p)
	if err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, m)
	return nil
}

func (s *Server) deleteProject(w http.ResponseWriter, r *http.Request) error {
	id := r.PathValue("id")
	if s.onDelete != nil {
		s.onDelete(id)
	}
	if err := s.store.Delete(id); err != nil {
		return err
	}
	w.WriteHeader(http.StatusNoContent)
	return nil
}

func (s *Server) exportZip(w http.ResponseWriter, r *http.Request) error {
	m, err := s.store.Get(r.PathValue("id"))
	if err != nil {
		return err
	}
	w.Header().Set("Content-Type", "application/zip")
	w.Header().Set("Content-Disposition", attachment(m.Name, ".zip"))
	w.Header().Set("Cache-Control", "no-store")
	// Headers are sent on first write; an error mid-stream can only be logged.
	if err := archive.WriteZip(w, s.store.SrcDir(m.ID)); err != nil {
		s.log.Error("zip export failed", "id", m.ID, "err", err)
	}
	return nil
}

// attachment builds a Content-Disposition header with a safe filename
// (RFC 6266/5987 encoding for non-ASCII names).
func attachment(name, ext string) string {
	return mime.FormatMediaType("attachment", map[string]string{"filename": fileBase(name) + ext})
}
