# texdesk — single binary (Go API + embedded React frontend)

GO        ?= go
NPM       ?= npm
BIN       ?= bin/texdesk
ADDR      ?= 127.0.0.1:8080
DATA_DIR  ?= ./data
IMAGE     ?= texdesk:latest
export CGO_ENABLED = 0

.PHONY: all build web go dev dev-go dev-web test test-go test-web test-integration lint latexkb docker clean ensure-dist

all: build

## build: frontend (web/dist) first, then the Go binary that embeds it
build: web go

web: web/node_modules
	cd web && $(NPM) run build

web/node_modules: web/package.json
	cd web && $(NPM) install --no-audit --no-fund
	@touch $@

# go:embed needs web/dist to exist; keep a placeholder when the UI is not built.
ensure-dist:
	@mkdir -p web/dist
	@[ -f web/dist/index.html ] || echo '<!doctype html><title>texdesk</title><p>Frontend not built. Run <code>make build</code>.</p>' > web/dist/index.html

go: ensure-dist
	$(GO) build -trimpath -ldflags="-s -w" -o $(BIN) ./cmd/texdesk

## dev: Vite (with proxy to Go) + Go server with hot reload (uses `air` if installed)
dev: ensure-dist web/node_modules
	@echo "UI:  http://localhost:5173   (API proxied to http://$(ADDR))"
	@trap 'kill 0' INT TERM EXIT; \
	  $(MAKE) --no-print-directory dev-go & \
	  (cd web && $(NPM) run dev) & \
	  wait

dev-go:
	@if command -v air >/dev/null 2>&1; then \
	  air --build.cmd "$(GO) build -o ./tmp/texdesk ./cmd/texdesk" --build.bin "./tmp/texdesk --addr $(ADDR) --data-dir $(DATA_DIR)" \
	      --build.include_ext "go" --build.exclude_dir "web,data,tmp,testdata"; \
	else \
	  echo "(air not found: no Go hot reload — install with: go install github.com/air-verse/air@latest)"; \
	  $(GO) run ./cmd/texdesk --addr $(ADDR) --data-dir $(DATA_DIR); \
	fi

## test: Go unit + integration tests and frontend unit tests
test: test-go test-web

test-go: ensure-dist
	$(GO) vet ./...
	$(GO) test -race=false -count=1 ./...

test-integration: ensure-dist
	$(GO) test -count=1 -run Integration -v ./internal/...

test-web: web/node_modules
	cd web && $(NPM) run typecheck && $(NPM) test

## latexkb: regenerate the LaTeX knowledge base from the installed TeX (needs lualatex; ~10 min)
latexkb: web/node_modules
	cd web && node scripts/latexkb/gen.mjs

## docker: build the container image
docker:
	docker build -t $(IMAGE) .

clean:
	rm -rf bin tmp web/dist
