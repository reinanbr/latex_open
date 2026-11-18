// Package tools detects external programs at startup so features can degrade
// gracefully (the UI disables a feature and shows the reason).
package tools

import (
	"context"
	"os/exec"
	"strings"
	"time"
)

// Tool describes one external dependency.
type Tool struct {
	Available bool   `json:"available"`
	Path      string `json:"path,omitempty"`
	Version   string `json:"version,omitempty"`
	Reason    string `json:"reason,omitempty"` // why it is unavailable
}

// Capabilities is served at GET /api/capabilities.
type Capabilities struct {
	Latexmk  Tool `json:"latexmk"`
	Pdflatex Tool `json:"pdflatex"`
	// Latex is latex (DVI mode) plus dvipdf to produce the PDF.
	Latex    Tool `json:"latex"`
	Xelatex  Tool `json:"xelatex"`
	Lualatex Tool `json:"lualatex"`
	Synctex  Tool `json:"synctex"`
	Pandoc   Tool `json:"pandoc"`
	Texcount Tool `json:"texcount"`
	// Pdftoppm converts PDF figures to PNG for the Markdown export.
	Pdftoppm Tool `json:"pdftoppm"`
	// Ghostscript converts EPS figures to PNG for the Markdown export.
	Ghostscript Tool `json:"gs"`
}

// Engine returns the tool entry for a compiler name.
func (c *Capabilities) Engine(name string) Tool {
	switch name {
	case "pdflatex":
		return c.Pdflatex
	case "latex":
		return c.Latex
	case "xelatex":
		return c.Xelatex
	case "lualatex":
		return c.Lualatex
	}
	return Tool{Reason: "unknown compiler"}
}

// Detect probes PATH for every tool.
func Detect() *Capabilities {
	return &Capabilities{
		Latexmk:     probe("latexmk", "-v"),
		Pdflatex:    probe("pdflatex", "--version"),
		Latex:       probeLatex(),
		Xelatex:     probe("xelatex", "--version"),
		Lualatex:    probe("lualatex", "--version"),
		Synctex:     probe("synctex", "help"),
		Pandoc:      probe("pandoc", "--version"),
		Texcount:    probe("texcount", "-v"),
		Pdftoppm:    probe("pdftoppm", "-v"),
		Ghostscript: probe("gs", "--version"),
	}
}

func probe(name string, versionArg string) Tool {
	p, err := exec.LookPath(name)
	if err != nil {
		return Tool{Reason: name + " não encontrado no PATH"}
	}
	t := Tool{Available: true, Path: p}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	out, _ := exec.CommandContext(ctx, p, versionArg).CombinedOutput()
	for _, line := range strings.Split(string(out), "\n") {
		if l := strings.TrimSpace(line); l != "" {
			t.Version = l
			break
		}
	}
	return t
}

// probeLatex: the "latex" compiler also needs dvips and ps2pdf (Ghostscript).
func probeLatex() Tool {
	t := probe("latex", "--version")
	if !t.Available {
		return t
	}
	for _, dep := range []string{"dvips", "ps2pdf", "gs"} {
		if _, err := exec.LookPath(dep); err != nil {
			return Tool{Reason: dep + " não encontrado no PATH (necessário para LaTeX → DVI → PDF)"}
		}
	}
	return t
}
