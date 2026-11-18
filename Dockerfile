# syntax=docker/dockerfile:1
#
# texdesk — multi-stage build: frontend → Go binary (embeds the frontend) →
# Debian runtime with TeX Live, latexmk, biber and pandoc.
#
#   docker build -t texdesk .
#   docker run --rm -p 127.0.0.1:8080:8080 -v texdesk-data:/data texdesk
#
# Full TeX Live (≈ 5 GB, every package and language):
#   docker build --build-arg TEX_PACKAGES=texlive-full -t texdesk:full .

# ---------------------------------------------------------------- frontend
FROM node:22-trixie-slim AS web
WORKDIR /src/web
COPY web/package.json web/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY web/ ./
RUN npm run build

# ---------------------------------------------------------------- backend
FROM golang:1.26-trixie AS go
WORKDIR /src
COPY go.mod ./
COPY cmd ./cmd
COPY internal ./internal
COPY web/embed.go ./web/embed.go
COPY --from=web /src/web/dist ./web/dist
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/texdesk ./cmd/texdesk

# ---------------------------------------------------------------- runtime
FROM debian:trixie-slim

# TeX distribution. The default set covers pdfLaTeX/XeLaTeX/LuaLaTeX, BibTeX
# and biber, and Portuguese hyphenation; cm-super gives scalable T1 fonts.
# Swap for "texlive-full" with --build-arg (see above).
ARG TEX_PACKAGES="texlive-latex-extra texlive-xetex texlive-luatex texlive-bibtex-extra biber latexmk texlive-lang-portuguese texlive-fonts-recommended cm-super-minimal texlive-publishers"
# Optional tools: pandoc (Markdown export), poppler-utils + ghostscript (PDF/EPS
# figures → PNG), texlive-extra-utils (texcount word count), preview-latex-style
# (TikZ figures → PNG in the Markdown export). The synctex CLI
# comes with texlive-binaries.
ARG EXTRA_PACKAGES="pandoc poppler-utils ghostscript texlive-extra-utils preview-latex-style fonts-dejavu-core"

RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      ${TEX_PACKAGES} ${EXTRA_PACKAGES} tini ca-certificates \
 && rm -rf /var/lib/apt/lists/*

RUN useradd --create-home --uid 10001 --shell /usr/sbin/nologin texdesk \
 && mkdir -p /data && chown texdesk:texdesk /data

COPY --from=go /out/texdesk /usr/local/bin/texdesk

USER texdesk
# TEXDESK_ALLOWED_HOSTS: accept only these Host headers (DNS-rebinding
# protection). Add your host name / IP if you publish the port beyond
# localhost, e.g. -e TEXDESK_ALLOWED_HOSTS=localhost,127.0.0.1,meu-servidor.lan
ENV LANG=C.UTF-8 \
    TEXDESK_ADDR=0.0.0.0:8080 \
    TEXDESK_DATA_DIR=/data \
    TEXDESK_ALLOWED_HOSTS=localhost,127.0.0.1,::1

# Build LuaLaTeX's font name cache now so the first compile is not slow.
RUN luaotfload-tool --update --quiet || true

VOLUME ["/data"]
EXPOSE 8080
# tini reaps the processes that TeX tools leave behind (texdesk is PID 1).
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/texdesk"]
