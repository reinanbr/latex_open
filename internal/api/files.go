package api

import (
	"io"
	"mime"
	"net/http"
	"path"
	"strings"

	"texdesk/internal/archive"
	"texdesk/internal/project"
)

// Text formats served as UTF-8 text/plain regardless of system mime tables.
var textExts = map[string]bool{
	".tex": true, ".bib": true, ".sty": true, ".cls": true, ".bst": true, ".bbx": true,
	".cbx": true, ".lbx": true, ".dtx": true, ".ins": true, ".ltx": true, ".txt": true,
	".md": true, ".bbl": true, ".clo": true, ".def": true, ".cfg": true, ".fd": true,
	".rnw": true, ".tikz": true, ".pgf": true, ".lua": true, ".csv": true, ".dat": true,
	".tsv": true, ".latexmkrc": true, ".gitignore": true, ".ist": true, ".gst": true,
	".json": true, ".yaml": true, ".yml": true, ".xml": true, ".asy": true, ".mp": true,
}

// IsTextFile reports whether a path should open in the code editor.
func IsTextFile(p string) bool {
	ext := strings.ToLower(path.Ext(p))
	if ext == "" {
		base := strings.ToLower(path.Base(p))
		return base == "latexmkrc" || base == "makefile" || base == "readme" || base == "license"
	}
	return textExts[ext]
}

func (s *Server) getTree(w http.ResponseWriter, r *http.Request) error {
	t, err := s.store.Tree(r.PathValue("id"))
	if err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, t)
	return nil
}

func (s *Server) getFile(w http.ResponseWriter, r *http.Request) error {
	f, fi, err := s.store.OpenFile(r.PathValue("id"), r.PathValue("path"))
	if err != nil {
		return err
	}
	defer f.Close()
	name := fi.Name()
	h := w.Header()
	if IsTextFile(name) {
		h.Set("Content-Type", "text/plain; charset=utf-8")
	} else if ct := mime.TypeByExtension(strings.ToLower(path.Ext(name))); ct != "" {
		h.Set("Content-Type", ct)
	}
	// User files are untrusted: an uploaded .html/.svg must never run script
	// on our origin.
	h.Set("Content-Security-Policy", "sandbox; default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'")
	h.Set("Cache-Control", "no-cache")
	if r.URL.Query().Get("download") == "1" {
		h.Set("Content-Disposition", mime.FormatMediaType("attachment", map[string]string{"filename": name}))
	}
	http.ServeContent(w, r, name, fi.ModTime(), f)
	return nil
}

func (s *Server) putFile(w http.ResponseWriter, r *http.Request) error {
	id := r.PathValue("id")
	r.Body = http.MaxBytesReader(w, r.Body, s.cfg.MaxUploadBytes)
	rel, err := s.store.WriteFile(id, r.PathValue("path"), r.Body, s.cfg.MaxUploadBytes)
	if err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, map[string]string{"path": rel})
	return nil
}

func (s *Server) createFile(w http.ResponseWriter, r *http.Request) error {
	var body struct {
		Path string `json:"path"`
		Type string `json:"type"`
	}
	if err := decodeJSON(r, &body); err != nil {
		return err
	}
	rel, err := s.store.Create(r.PathValue("id"), body.Path, body.Type)
	if err != nil {
		return err
	}
	writeJSON(w, http.StatusCreated, map[string]string{"path": rel})
	return nil
}

func (s *Server) renameFile(w http.ResponseWriter, r *http.Request) error {
	var body struct {
		NewPath string `json:"newPath"`
	}
	if err := decodeJSON(r, &body); err != nil {
		return err
	}
	rel, err := s.store.Rename(r.PathValue("id"), r.PathValue("path"), body.NewPath)
	if err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, map[string]string{"path": rel})
	return nil
}

func (s *Server) deleteFile(w http.ResponseWriter, r *http.Request) error {
	if err := s.store.Remove(r.PathValue("id"), r.PathValue("path")); err != nil {
		return err
	}
	w.WriteHeader(http.StatusNoContent)
	return nil
}

// POST /api/projects/{id}/upload — multipart fields:
//
//	dir    destination folder (optional, "" = project root)
//	files  one or more files
//	paths  optional, one per file: a relative path (for folder uploads),
//	       since multipart filenames are reduced to their base name.
//
// Existing files are overwritten (uploading a new version of a figure is the
// common case); junk files are skipped.
func (s *Server) upload(w http.ResponseWriter, r *http.Request) error {
	id := r.PathValue("id")
	if _, err := s.store.Get(id); err != nil {
		return err
	}
	r.Body = http.MaxBytesReader(w, r.Body, s.cfg.MaxUploadBytes+1<<20)
	if err := r.ParseMultipartForm(32 << 20); err != nil {
		return mapBodyErr(err)
	}
	defer r.MultipartForm.RemoveAll()
	dir := strings.Trim(r.FormValue("dir"), "/")
	if dir != "" {
		if _, err := project.CleanRel(dir); err != nil {
			return err
		}
	}
	files := r.MultipartForm.File["files"]
	paths := r.MultipartForm.Value["paths"]
	if len(files) == 0 {
		return newErr(http.StatusBadRequest, "invalid_request", `no "files" in upload`)
	}
	type result struct {
		Uploaded []string `json:"uploaded"`
		Skipped  []string `json:"skipped"`
	}
	res := result{Uploaded: []string{}, Skipped: []string{}}
	for i, fh := range files {
		name := fh.Filename
		if i < len(paths) && paths[i] != "" {
			name = paths[i]
		}
		rel := path.Join(dir, name)
		clean, err := project.CleanRel(rel)
		if err != nil {
			return err
		}
		if archive.IsJunk(clean) {
			res.Skipped = append(res.Skipped, clean)
			continue
		}
		f, err := fh.Open()
		if err != nil {
			return err
		}
		_, err = s.store.WriteFile(id, clean, io.Reader(f), s.cfg.MaxUploadBytes)
		f.Close()
		if err != nil {
			return err
		}
		res.Uploaded = append(res.Uploaded, clean)
	}
	writeJSON(w, http.StatusOK, res)
	return nil
}
