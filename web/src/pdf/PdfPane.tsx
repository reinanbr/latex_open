import { useCallback, useRef, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api/client";
import { COMPILER_LABEL, type CompileResult, type ProjectMeta } from "../api/types";
import { Icon } from "../components/Icon";
import { MenuButton } from "../components/Overlays";
import { CompileSettingsDialog } from "../components/CompileSettings";
import { compileProject, countProblems, showProblemInLogs, useCompile } from "../store/compile";
import { usePrefs } from "../store/prefs";
import { useEditor } from "../store/editor";
import { relint } from "../editor/diagnostics";
import { hintFor } from "../lib/errorHints";
import { countLive, useLive } from "../store/live";
import { PdfDocument, type PdfController, type Zoom } from "./PdfDocument";
import { LogsPanel } from "./LogsPanel";
import { isMac } from "../lib/platform";

const ZOOM_STEPS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4];

export function PdfPane({
  meta,
  onInverseSync,
  onForwardSync,
}: {
  meta: ProjectMeta;
  /** Double click on the PDF (SyncTeX inverse). */
  onInverseSync?: (page: number, x: number, y: number) => void;
  /** Show the editor cursor in the PDF (SyncTeX forward). */
  onForwardSync?: () => void;
}) {
  const caps = useQuery({ queryKey: ["capabilities"], queryFn: api.capabilities, staleTime: Infinity });
  const compiling = useCompile((s) => s.compiling);
  const result = useCompile((s) => s.result);
  const error = useCompile((s) => s.error);
  const pdfBuildId = useCompile((s) => s.pdfBuildId);
  const logsOpen = useCompile((s) => s.logsOpen);
  const zoom = useCompile((s) => s.zoom);
  const scale = useCompile((s) => s.scale);
  const page = useCompile((s) => s.page);
  const numPages = useCompile((s) => s.numPages);
  const highlight = useCompile((s) => s.highlight);
  const set = useCompile((s) => s.set);
  const controller = useRef<PdfController | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);

  const latexmk = caps.data?.latexmk;
  const synctex = caps.data?.synctex;
  const canCompile = !caps.data || (latexmk?.available ?? false);
  const counts = countProblems(result?.problems);
  const live = countLive(useLive((s) => s.issues));
  const autoCompile = usePrefs((s) => s.autoCompile);
  const badgeErrors = counts.errors + live.errors;
  const badgeWarnings = counts.warnings + live.warnings;
  const pdfUrl = pdfBuildId ? api.pdfUrl(meta.id, pdfBuildId) : null;

  const setZoom = (z: Zoom) => set({ zoom: z });
  const stepZoom = (dir: 1 | -1) => {
    const cur = scale;
    const next = dir > 0 ? ZOOM_STEPS.find((z) => z > cur + 0.001) : [...ZOOM_STEPS].reverse().find((z) => z < cur - 0.001);
    setZoom(next ?? cur);
  };
  const onZoomRequest = useCallback(
    (factor: number) => {
      const s = useCompile.getState().scale;
      useCompile.getState().set({ zoom: Math.max(0.25, Math.min(4, s * factor)) });
    },
    [],
  );
  const onScale = useCallback((s: number) => useCompile.getState().set({ scale: s }), []);

  const recompile = () => void compileProject(meta.id);
  const mod = isMac ? "⌘" : "Ctrl";

  return (
    <div className="pane pdf-pane">
      <div className="pdf-toolbar">
        <div className="split-btn">
          <button
            className="btn btn-primary recompile"
            onClick={recompile}
            disabled={!canCompile}
            title={canCompile ? `Recompilar com ${COMPILER_LABEL[meta.compiler] ?? meta.compiler} (${mod}+Enter)` : latexmk?.reason}
          >
            {compiling ? <span className="spinner" /> : <Icon name="refresh" />}
            {compiling ? "Compilando…" : "Recompilar"}
          </button>
          <CompileMenu meta={meta} onSettings={() => setSettingsOpen(true)} />
        </div>

        <button
          className={`icon-btn logs-btn ${logsOpen ? "active" : ""}`}
          title="Logs e problemas"
          aria-label="Logs e problemas"
          aria-pressed={logsOpen}
          onClick={() => set({ logsOpen: !logsOpen })}
        >
          <Icon name="logs" />
          {badgeErrors > 0 ? (
            <span className="badge error">{badgeErrors}</span>
          ) : badgeWarnings > 0 ? (
            <span className="badge warning">{badgeWarnings}</span>
          ) : null}
        </button>

        {autoCompile && live.errors > 0 && (
          <span className="auto-paused" title="A compilação automática volta assim que os erros de sintaxe do arquivo aberto forem corrigidos.">
            <Icon name="alert" /> Automática em pausa
          </span>
        )}

        {onForwardSync && (
          <button
            className="icon-btn"
            title={
              synctex?.available === false
                ? `SyncTeX indisponível: ${synctex.reason ?? "synctex não instalado"}`
                : `Mostrar a posição do cursor no PDF (${mod}+Shift+.). Dê um duplo clique no PDF para ir ao código.`
            }
            aria-label="Mostrar a posição do cursor no PDF"
            disabled={!pdfBuildId || synctex?.available === false}
            onClick={onForwardSync}
          >
            <Icon name="sync" />
          </button>
        )}

        <span className="spacer" />

        {!logsOpen && numPages > 0 && (
          <>
            <div className="pager">
              <button className="icon-btn" aria-label="Página anterior" disabled={page <= 1} onClick={() => controller.current?.scrollToPage(page - 1)}>
                <Icon name="chevronUp" />
              </button>
              <input
                className="page-input"
                aria-label="Página"
                value={page}
                onChange={(e) => {
                  const n = Number(e.target.value);
                  if (n >= 1 && n <= numPages) controller.current?.scrollToPage(n);
                }}
              />
              <span className="of">/ {numPages}</span>
              <button className="icon-btn" aria-label="Próxima página" disabled={page >= numPages} onClick={() => controller.current?.scrollToPage(page + 1)}>
                <Icon name="chevronDown" />
              </button>
            </div>
            <span className="toolbar-sep" />
            <button className="icon-btn" title="Diminuir zoom" aria-label="Diminuir zoom" onClick={() => stepZoom(-1)}>
              <Icon name="zoomOut" />
            </button>
            <MenuButton label="Zoom" className="btn btn-ghost btn-sm zoom-label" button={<>{Math.round(scale * 100)}%</>} align="right">
              {(close) => (
                <>
                  <button className="menu-item" onClick={() => (setZoom("fit-width"), close())}>
                    <Icon name="fitWidth" /> Ajustar à largura {zoom === "fit-width" && <Icon name="check" className="icon hint" />}
                  </button>
                  <button className="menu-item" onClick={() => (setZoom("fit-page"), close())}>
                    <Icon name="fitPage" /> Ajustar à página {zoom === "fit-page" && <Icon name="check" className="icon hint" />}
                  </button>
                  <div className="menu-sep" />
                  {[0.5, 0.75, 1, 1.25, 1.5, 2, 3].map((z) => (
                    <button key={z} className="menu-item" onClick={() => (setZoom(z), close())}>
                      {Math.round(z * 100)}%
                    </button>
                  ))}
                </>
              )}
            </MenuButton>
            <button className="icon-btn" title="Aumentar zoom" aria-label="Aumentar zoom" onClick={() => stepZoom(1)}>
              <Icon name="zoomIn" />
            </button>
          </>
        )}
        <a
          className={`icon-btn ${pdfBuildId ? "" : "disabled"}`}
          title="Baixar PDF"
          aria-label="Baixar PDF"
          aria-disabled={!pdfBuildId}
          href={pdfBuildId ? `${api.pdfUrl(meta.id, pdfBuildId)}?download=1` : undefined}
          download
        >
          <Icon name="download" />
        </a>
      </div>

      <div className="pdf-body">
        {pdfUrl ? (
          <PdfDocument
            url={pdfUrl}
            zoom={zoom}
            onScale={onScale}
            onLoaded={(n) => set({ numPages: n })}
            onPageChange={(p) => set({ page: p })}
            onDoubleClick={synctex?.available === false ? undefined : onInverseSync}
            onZoomRequest={onZoomRequest}
            highlight={highlight ? { ...highlight } : null}
            controllerRef={controller}
          />
        ) : (
          <div className="pdf-empty">
            {!canCompile ? (
              <p>
                <Icon name="alert" /> Compilação indisponível: {latexmk?.reason}
              </p>
            ) : compiling ? (
              <p>
                <span className="spinner" /> Compilando…
              </p>
            ) : error ? (
              <p>{error}</p>
            ) : (
              <p>
                Clique em <strong>Recompilar</strong> para gerar o PDF.
              </p>
            )}
          </div>
        )}
        {!logsOpen && result && <CompileAlert result={result} />}
        {logsOpen && <LogsPanel projectId={meta.id} onClose={() => set({ logsOpen: false })} />}
        {compiling && pdfUrl && <div className="compiling-bar" aria-hidden="true" />}
      </div>
      {settingsOpen && <CompileSettingsDialog meta={meta} onClose={() => setSettingsOpen(false)} />}
    </div>
  );
}

function CompileMenu({ meta, onSettings }: { meta: ProjectMeta; onSettings: () => void }) {
  const prefs = usePrefs();
  const Radio = ({ on }: { on: boolean }) => (on ? <Icon name="check" /> : <span className="icon" />);
  const Item = ({ on, onClick, children }: { on: boolean; onClick: () => void; children: ReactNode }) => (
    <button className="menu-item" role="menuitemradio" aria-checked={on} onClick={onClick}>
      <Radio on={on} /> {children}
    </button>
  );
  return (
    <MenuButton label="Opções de compilação" className="btn btn-primary split-caret" button={<Icon name="chevronDown" />}>
      {(close) => (
        <div className="compile-menu">
          <div className="menu-label">Compilação automática</div>
          <Item on={prefs.autoCompile} onClick={() => prefs.set({ autoCompile: true })}>
            Ligada
          </Item>
          <Item on={!prefs.autoCompile} onClick={() => prefs.set({ autoCompile: false })}>
            Desligada
          </Item>
          <div className="menu-sep" />
          <div className="menu-label">Velocidade</div>
          <Item on={!prefs.draft} onClick={() => prefs.set({ draft: false })}>
            Normal
          </Item>
          <Item on={prefs.draft} onClick={() => prefs.set({ draft: true })}>
            Pular imagens (modo rascunho)
          </Item>
          <div className="menu-sep" />
          <div className="menu-label">Verificação de sintaxe</div>
          <Item on={prefs.syntaxCheck} onClick={() => (prefs.set({ syntaxCheck: true }), relint())}>
            Ligada
          </Item>
          <Item on={!prefs.syntaxCheck} onClick={() => (prefs.set({ syntaxCheck: false }), relint())}>
            Desligada
          </Item>
          <div className="menu-sep" />
          <div className="menu-label">Em caso de erro</div>
          <Item on={prefs.stopOnFirstError} onClick={() => prefs.set({ stopOnFirstError: true })}>
            Parar no primeiro erro
          </Item>
          <Item on={!prefs.stopOnFirstError} onClick={() => prefs.set({ stopOnFirstError: false })}>
            Tentar compilar mesmo com erros
          </Item>
          <div className="menu-sep" />
          <button
            className="menu-item"
            title="Apaga os arquivos auxiliares (.aux, .bbl, .toc…) e compila tudo de novo"
            onClick={() => {
              close();
              void compileProject(meta.id, { clean: true });
            }}
          >
            <Icon name="refresh" /> Recompilar do zero
          </button>
          <button
            className="menu-item"
            onClick={() => {
              close();
              onSettings();
            }}
          >
            <Icon name="settings" /> Configurações…
          </button>
        </div>
      )}
    </MenuButton>
  );
}

/** Pop-up over the PDF when the last compilation had errors. */
function CompileAlert({ result }: { result: CompileResult }) {
  const alert = useCompile((s) => s.alert);
  const set = useCompile((s) => s.set);
  const openFile = useEditor((s) => s.open);
  const errors = result.problems.filter((p) => p.level === "error");
  if (errors.length === 0 || alert !== result.buildId) return null;
  const first = errors[0]!;
  const hint = hintFor(first.message);
  const counts = countProblems(result.problems);
  return (
    <div className="compile-alert" role="alert">
      <div className="compile-alert-head">
        <Icon name="alertCircle" />
        <strong>
          {result.status === "timeout"
            ? "A compilação excedeu o tempo limite"
            : `${counts.errors} ${counts.errors === 1 ? "erro" : "erros"} na compilação`}
        </strong>
        {counts.warnings > 0 && (
          <span className="muted">
            · {counts.warnings} {counts.warnings === 1 ? "aviso" : "avisos"}
          </span>
        )}
        <span className="spacer" />
        <button className="icon-btn" aria-label="Fechar aviso" title="Fechar" onClick={() => set({ alert: null })}>
          <Icon name="x" />
        </button>
      </div>
      <div className="compile-alert-msg">
        {first.file && (
          <span className="compile-alert-loc">
            {first.file}
            {first.line ? `:${first.line}` : ""}
          </span>
        )}
        {first.message}
      </div>
      {hint && <div className="compile-alert-hint">{hint}</div>}
      <div className="compile-alert-actions">
        {!result.pdfAvailable && <span className="muted">Nenhum PDF foi gerado.</span>}
        <span className="spacer" />
        {first.file && (
          <button className="btn btn-sm" onClick={() => openFile(first.file!, { line: first.line ?? 1 })}>
            Ir para o erro
          </button>
        )}
        <button className="btn btn-sm btn-primary" onClick={() => showProblemInLogs(first)}>
          Ver logs
        </button>
      </div>
    </div>
  );
}
