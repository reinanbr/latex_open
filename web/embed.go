// Package web embeds the built frontend (web/dist). Run `make build` (or
// `npm run build` in web/) before building the Go binary; a placeholder
// index.html keeps `go build`/`go test` working on a fresh checkout.
package web

import (
	"embed"
	"io/fs"
)

//go:embed all:dist
var dist embed.FS

// Dist returns the built frontend rooted at dist/.
func Dist() fs.FS {
	sub, err := fs.Sub(dist, "dist")
	if err != nil {
		panic(err)
	}
	return sub
}
