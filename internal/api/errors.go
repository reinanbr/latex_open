package api

import (
	"encoding/json"
	"errors"
	"net/http"

	"texdesk/internal/archive"
	"texdesk/internal/project"
)

// apiError is rendered as {"error": {"code": "...", "message": "..."}}.
type apiError struct {
	Status  int    `json:"-"`
	Code    string `json:"code"`
	Message string `json:"message"`
}

func (e *apiError) Error() string { return e.Message }

func newErr(status int, code, msg string) *apiError {
	return &apiError{Status: status, Code: code, Message: msg}
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

// writeError maps domain errors onto HTTP responses.
func (s *Server) writeError(w http.ResponseWriter, r *http.Request, err error) {
	var ae *apiError
	var ve *project.ValidationError
	var ze *archive.Error
	var mbe *http.MaxBytesError
	switch {
	case errors.As(err, &ae):
	case errors.Is(err, project.ErrNotFound):
		ae = newErr(http.StatusNotFound, "not_found", "resource not found")
	case errors.Is(err, project.ErrInvalidPath):
		ae = newErr(http.StatusBadRequest, "invalid_path", "invalid path")
	case errors.Is(err, project.ErrExists):
		ae = newErr(http.StatusConflict, "already_exists", "a file or folder with that name already exists")
	case errors.As(err, &ve):
		ae = newErr(http.StatusBadRequest, "invalid_request", ve.Msg)
	case errors.As(err, &ze):
		status := http.StatusBadRequest
		if ze.Code == "zip_too_large" || ze.Code == "zip_too_many_files" {
			status = http.StatusRequestEntityTooLarge
		}
		ae = newErr(status, ze.Code, ze.Msg)
	case errors.As(err, &mbe):
		ae = newErr(http.StatusRequestEntityTooLarge, "too_large", "request body too large")
	default:
		s.log.Error("internal error", "method", r.Method, "path", r.URL.Path, "err", err)
		ae = newErr(http.StatusInternalServerError, "internal", "internal server error")
	}
	writeJSON(w, ae.Status, map[string]any{"error": ae})
}

// handler adapts error-returning handlers.
type handler func(w http.ResponseWriter, r *http.Request) error

func (s *Server) h(fn handler) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if err := fn(w, r); err != nil {
			s.writeError(w, r, err)
		}
	}
}
