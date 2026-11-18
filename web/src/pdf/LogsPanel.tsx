import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api/client";
import type { Problem } from "../api/types";
import { Icon } from "../components/Icon";
import { countProblems, useCompile } from "../store/compile";
import { useEditor } from "../store/editor";
import { hintFor } from "../lib/errorHints";
import { useLive } from "../store/live";
import { usePrefs } from "../store/prefs";

const STATUS_TEXT: Record<string, string> = {
  success: "Compilado com sucesso",
  error: "Compilado com erros",
  timeout: "Tempo limite excedido",
  canceled: "Cancelado",
};

export function LogsPanel({ projectId, onClose }: { projectId: string; onClose: () => void }) {
  const result = useCompile((s) => s.result);
  const error = useCompile((s) => s.error);
  const tab = useCompile((s) => s.logsTab);
  const compiling = useCompile((s) => s.compiling);
  const set = useCompile((s) => s.set);
  const [filter, setFilter] = useState<"all" | "error" | "warning" | "typesetting">("all");
  const focus = useCompile((s) => s.focus);
  // "Ver no log" from the editor: show every problem so the target is listed.
  useEffect(() => {
    if (focus) setFilter("all");
  }, [focus]);
  const counts = countProblems(result?.problems);
  const problems = (result?.problems ?? []).filter((p) => filter === "all" || p.level === filter);

  return (
    <div className="logs-panel" role="region" aria-label="Logs e problemas">
      <div className="logs-head">
        <div className="logs-tabs" role="tablist">
          <button role="tab" aria-selected={tab === "problems"} onClick={() => set({ logsTab: "problems" })}>
            Problemas <span className="count">{result?.problems.length ?? 0}</span>
          </button>
          <button role="tab" aria-selected={tab === "raw"} onClick={() => set({ logsTab: "raw" })}>
            Log bruto
          </button>
        </div>
        <span className="spacer" />
        {compiling && (
          <span className="logs-updating">
            <span className="spinner" style={{ width: 10, height: 10 }} /> Atualizando…
          </span>
        )}
        {result && (
          <span className={`logs-status ${result.status}`}>
            {STATUS_TEXT[result.status] ?? result.status} · {(result.durationMs / 1000).toFixed(1)} s · {result.compiler}
            {result.draft ? " · rascunho" : ""}
          </span>
        )}
        <button className="icon-btn" aria-label="Fechar logs" title="Voltar ao PDF" onClick={onClose}>
          <Icon name="x" />
        </button>
      </div>

      {error && (
        <div className="problem error">
          <div className="problem-head">
            <Icon name="alertCircle" />
            <span className="problem-msg">{error}</span>
          </div>
        </div>
      )}

      {tab === "problems" ? (
        <div className="logs-body">
          <LiveSection />
          {result && <div className="logs-section-title">Última compilação</div>}
          {result && result.problems.length > 0 && (
            <div className="problem-filters">
              <FilterChip label="Todos" n={result.problems.length} active={filter === "all"} onClick={() => setFilter("all")} />
              <FilterChip label="Erros" n={counts.errors} kind="error" active={filter === "error"} onClick={() => setFilter("error")} />
              <FilterChip label="Avisos" n={counts.warnings} kind="warning" active={filter === "warning"} onClick={() => setFilter("warning")} />
              <FilterChip label="Tipografia" n={counts.typesetting} kind="typesetting" active={filter === "typesetting"} onClick={() => setFilter("typesetting")} />
            </div>
          )}
          {result && result.problems.length === 0 && (
            <div className="logs-empty">
              <Icon name="check" /> Nenhum problema encontrado.
            </div>
          )}
          {!result && !error && <div className="logs-empty">Ainda não há compilação.</div>}
          {problems.map((p, i) => (
            <ProblemItem key={i} p={p} focused={focus?.problem === p ? focus.nonce : 0} />
          ))}
        </div>
      ) : (
        <RawLog projectId={projectId} />
      )}
    </div>
  );
}

/** What the live check finds in the open file, updated while typing. */
function LiveSection() {
  const path = useLive((s) => s.path);
  const issues = useLive((s) => s.issues);
  const commandNote = useLive((s) => s.commandNote);
  const syntaxOn = usePrefs((s) => s.syntaxCheck);
  const openFile = useEditor((s) => s.open);
  if (!path) return null;
  return (
    <div className="live-section" aria-live="polite">
      <div className="logs-section-title">
        <span className="live-dot" aria-hidden="true" /> Ao vivo · {path}
        <span className="muted">
          {!syntaxOn ? "verificação desligada" : issues.length === 0 ? "nenhum problema" : `${issues.length} ${issues.length === 1 ? "problema" : "problemas"}`}
        </span>
      </div>
      {syntaxOn && commandNote && (
        <div className="live-note muted" title="Comandos e ambientes desconhecidos só são apontados quando tudo o que o projeto carrega é conhecido">
          Verificação de comandos em pausa: {commandNote}.
        </div>
      )}
      {issues.map((i, n) => {
        const hint = hintFor(i.message);
        return (
          <div key={n} className={`problem ${i.severity} live`}>
            <button className="problem-head" onClick={() => openFile(path, { line: i.line, col: i.col })} title="Ir para a linha">
              <Icon name={i.severity === "error" ? "alertCircle" : "alert"} />
              <span className="problem-msg">{i.message}</span>
              <span className="problem-loc link">
                {path}:{i.line}
              </span>
            </button>
            {hint && <div className="problem-hint">{hint}</div>}
          </div>
        );
      })}
    </div>
  );
}

function FilterChip({ label, n, kind, active, onClick }: { label: string; n: number; kind?: string; active: boolean; onClick: () => void }) {
  return (
    <button className={`chip ${kind ?? ""} ${active ? "active" : ""}`} aria-pressed={active} onClick={onClick} disabled={n === 0 && !active}>
      {label} <span>{n}</span>
    </button>
  );
}

function ProblemItem({ p, focused }: { p: Problem; focused: number }) {
  const [open, setOpen] = useState(false);
  const [flash, setFlash] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!focused) return;
    ref.current?.scrollIntoView({ block: "center", behavior: "smooth" });
    setOpen(true);
    setFlash(true);
    const t = window.setTimeout(() => setFlash(false), 1600);
    return () => window.clearTimeout(t);
  }, [focused]);
  const hint = hintFor(p.message);
  const openFile = useEditor((s) => s.open);
  const where = p.file ? `${p.file}${p.line ? `:${p.line}` : ""}` : p.source ? `${p.source}${p.line ? `:${p.line}` : ""}` : "";
  const navigable = Boolean(p.file);
  return (
    <div ref={ref} className={`problem ${p.level} ${flash ? "flash" : ""}`}>
      <button
        className="problem-head"
        onClick={() => (navigable ? openFile(p.file!, { line: p.line ?? 1 }) : setOpen((o) => !o))}
        title={navigable ? "Ir para a linha" : undefined}
      >
        <Icon name={p.level === "error" ? "alertCircle" : p.level === "warning" ? "alert" : "info"} />
        <span className="problem-msg">{p.message}</span>
        {where && <span className={`problem-loc ${navigable ? "link" : ""}`}>{where}</span>}
      </button>
      {hint && <div className="problem-hint">{hint}</div>}
      {p.raw && p.raw !== p.message && (
        <>
          <button className="raw-toggle" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
            <Icon name={open ? "chevronDown" : "chevronRight"} /> {open ? "Ocultar detalhes" : "Detalhes do log"}
          </button>
          {open && <pre className="problem-raw">{p.raw}</pre>}
        </>
      )}
    </div>
  );
}

function RawLog({ projectId }: { projectId: string }) {
  const result = useCompile((s) => s.result);
  const buildId = result?.buildId;
  // The compile response already carries the log; fetch only as a fallback.
  const log = useQuery({
    queryKey: ["log", projectId, buildId],
    queryFn: async () => (await fetch(`/api/projects/${projectId}/compile/${buildId}/log`)).text(),
    enabled: Boolean(buildId) && !result?.log,
    staleTime: Infinity,
  });
  const text = result?.log || log.data || "";
  return (
    <div className="logs-body raw">
      {buildId && (
        <div className="raw-actions">
          <a className="btn btn-sm" href={`${api.pdfUrl(projectId, buildId).replace(/pdf$/, "log")}`} target="_blank" rel="noreferrer">
            Abrir em nova aba
          </a>
        </div>
      )}
      <pre className="raw-log">{text || "Sem log."}</pre>
      {result?.output && (
        <details className="latexmk-output">
          <summary>Saída do latexmk</summary>
          <pre className="raw-log">{result.output}</pre>
        </details>
      )}
    </div>
  );
}
