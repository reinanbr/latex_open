// Command texdesk is a self-hosted, single-user web LaTeX editor.
//
// Every flag can also be set by an environment variable (flags win):
//
//	--addr             TEXDESK_ADDR             default 127.0.0.1:8080
//	--data-dir         TEXDESK_DATA_DIR         default ./data
//	--compile-timeout  TEXDESK_COMPILE_TIMEOUT  default 60s
//	--max-upload-mb    TEXDESK_MAX_UPLOAD_MB    default 100
//	--allowed-hosts    TEXDESK_ALLOWED_HOSTS    comma-separated Host names
//	--no-sandbox       TEXDESK_SANDBOX=off      do not confine TeX & co. with Landlock
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"

	"texdesk/internal/api"
	"texdesk/internal/archive"
	"texdesk/internal/project"
	"texdesk/internal/sandbox"
	"texdesk/internal/tools"
	"texdesk/web"
)

func env(key, def string) string {
	if v, ok := os.LookupEnv(key); ok && v != "" {
		return v
	}
	return def
}

func main() {
	// texdesk re-executes itself to confine external tools (see package sandbox).
	if sandbox.IsHelper(os.Args) {
		sandbox.HelperMain(os.Args)
	}
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "texdesk:", err)
		os.Exit(1)
	}
}

func run() error {
	defTimeout, err := time.ParseDuration(env("TEXDESK_COMPILE_TIMEOUT", "60s"))
	if err != nil {
		return fmt.Errorf("TEXDESK_COMPILE_TIMEOUT: %w", err)
	}
	defUpload, err := strconv.Atoi(env("TEXDESK_MAX_UPLOAD_MB", "100"))
	if err != nil {
		return fmt.Errorf("TEXDESK_MAX_UPLOAD_MB: %w", err)
	}

	addr := flag.String("addr", env("TEXDESK_ADDR", "127.0.0.1:8080"), "listen address")
	dataDir := flag.String("data-dir", env("TEXDESK_DATA_DIR", "./data"), "directory for projects")
	timeout := flag.Duration("compile-timeout", defTimeout, "maximum duration of one compilation")
	maxUpload := flag.Int("max-upload-mb", defUpload, "maximum upload size in MB")
	allowed := flag.String("allowed-hosts", env("TEXDESK_ALLOWED_HOSTS", ""),
		"comma-separated Host header values to accept (default: loopback names when listening on loopback; '*' = any)")
	noSandbox := flag.Bool("no-sandbox", env("TEXDESK_SANDBOX", "") == "off",
		"run TeX, pandoc, Ghostscript… without the Landlock filesystem sandbox (not recommended)")
	logJSON := flag.Bool("log-json", env("TEXDESK_LOG_JSON", "") == "1", "log as JSON")
	flag.Parse()

	var handler slog.Handler = slog.NewTextHandler(os.Stderr, nil)
	if *logJSON {
		handler = slog.NewJSONHandler(os.Stderr, nil)
	}
	log := slog.New(handler)

	store, err := project.Open(*dataDir)
	if err != nil {
		return fmt.Errorf("opening data dir: %w", err)
	}
	caps := tools.Detect()
	for name, t := range map[string]tools.Tool{
		"latexmk": caps.Latexmk, "pdflatex": caps.Pdflatex, "latex": caps.Latex, "xelatex": caps.Xelatex,
		"lualatex": caps.Lualatex, "synctex": caps.Synctex, "pandoc": caps.Pandoc,
		"texcount": caps.Texcount, "pdftoppm": caps.Pdftoppm, "gs": caps.Ghostscript,
	} {
		if t.Available {
			log.Debug("tool found", "tool", name, "version", t.Version)
		} else {
			log.Warn("tool missing; related features are disabled", "tool", name)
		}
	}

	if *noSandbox {
		log.Warn("sandbox disabled by --no-sandbox: a malicious project compiled with LuaLaTeX can read any file this user can read")
	} else {
		var toolDirs []string
		for _, t := range []tools.Tool{caps.Latexmk, caps.Pdflatex, caps.Xelatex, caps.Lualatex, caps.Pandoc,
			caps.Texcount, caps.Pdftoppm, caps.Ghostscript} {
			if t.Available && t.Path != "" {
				toolDirs = append(toolDirs, filepath.Dir(t.Path))
			}
		}
		if ok, status := sandbox.Init(toolDirs); ok {
			log.Info(status)
		} else {
			log.Warn(status)
		}
	}

	var hosts []string
	for _, h := range strings.Split(*allowed, ",") {
		if h = strings.TrimSpace(h); h != "" {
			hosts = append(hosts, h)
		}
	}
	lim := archive.DefaultLimits
	srv := api.New(api.Config{
		Addr:           *addr,
		MaxUploadBytes: int64(*maxUpload) << 20,
		CompileTimeout: *timeout,
		AllowedHosts:   hosts,
		Limits:         lim,
		Static:         web.Dist(),
	}, store, caps, log)

	httpSrv := &http.Server{
		Addr:              *addr,
		Handler:           srv,
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       2 * time.Minute,
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	errc := make(chan error, 1)
	go func() { errc <- httpSrv.ListenAndServe() }()
	log.Info("texdesk listening", "url", "http://"+*addr, "data_dir", filepath.Dir(store.TempDir()))
	if !strings.HasPrefix(*addr, "127.") && !strings.HasPrefix(*addr, "localhost") && !strings.HasPrefix(*addr, "[::1]") {
		log.Warn("listening on a non-loopback address: texdesk has NO authentication; anyone who can reach this port can read and change your projects")
	}

	select {
	case err := <-errc:
		if !errors.Is(err, http.ErrServerClosed) {
			return err
		}
	case <-ctx.Done():
		log.Info("shutting down")
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		srv.Close()
		return httpSrv.Shutdown(shutdownCtx)
	}
	return nil
}
