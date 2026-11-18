import { useEffect, useRef, useState } from "react";
import { api } from "../api/client";
import type { ProjectMeta } from "../api/types";
import { saveBlob } from "../lib/download";
import { useEditor } from "../store/editor";
import { errorMessage, toast } from "../store/ui";
import { Icon } from "./Icon";
import { Modal } from "./Overlays";

type State =
  | { step: "confirm" }
  | { step: "running" }
  | { step: "done"; filename: string; warnings: string[]; media: number }
  | { step: "error"; message: string };

/** Explains that the conversion is approximate, exports, then lists warnings. */
export function MarkdownExportDialog({ meta, onClose }: { meta: ProjectMeta; onClose: () => void }) {
  const [state, setState] = useState<State>({ step: "confirm" });
  const ctl = useRef<AbortController | null>(null);
  useEffect(() => () => ctl.current?.abort(), []);

  const run = async () => {
    setState({ step: "running" });
    ctl.current = new AbortController();
    try {
      await useEditor.getState().docs?.flushAll();
      const res = await api.exportMarkdown(meta.id, ctl.current.signal);
      saveBlob(res.blob, res.filename);
      if (res.warnings.length === 0) {
        toast("success", `Markdown exportado: ${res.filename}`);
        onClose();
      } else {
        setState({ step: "done", filename: res.filename, warnings: res.warnings, media: res.media });
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      setState({ step: "error", message: errorMessage(err) });
    }
  };

  return (
    <Modal onClose={onClose} labelledBy="md-title">
      <div className="md-export">
        <h2 id="md-title">Exportar para Markdown</h2>
        {(state.step === "confirm" || state.step === "running") && (
          <>
            <p>
              A conversão (via pandoc) é <strong>aproximada</strong>: macros próprias, TikZ, ambientes personalizados e a
              formatação da página podem se perder. Figuras em PDF/EPS são convertidas para PNG.
            </p>
            <p>Se houver imagens, o download é um <code>.zip</code> com o <code>.md</code> e a pasta <code>media/</code>.</p>
          </>
        )}
        {state.step === "done" && (
          <>
            <p>
              <Icon name="check" className="icon ok" /> Baixado <strong>{state.filename}</strong>
              {state.media > 0 && ` (${state.media} ${state.media === 1 ? "imagem" : "imagens"})`}, com{" "}
              {state.warnings.length} {state.warnings.length === 1 ? "aviso" : "avisos"}:
            </p>
            <ul className="md-warnings">
              {state.warnings.map((w, i) => (
                <li key={i}>
                  <Icon name="alert" /> <span>{w}</span>
                </li>
              ))}
            </ul>
          </>
        )}
        {state.step === "error" && (
          <p className="md-error">
            <Icon name="alertCircle" /> Não foi possível exportar: {state.message}
          </p>
        )}
        <div className="dialog-actions">
          {state.step === "done" ? (
            <button key="close" className="btn btn-primary" onClick={onClose} autoFocus>
              Fechar
            </button>
          ) : (
            <>
              <button className="btn" onClick={onClose}>
                Cancelar
              </button>
              <button className="btn btn-primary" onClick={() => void run()} disabled={state.step === "running"} autoFocus>
                {state.step === "running" ? (
                  <>
                    <span className="spinner" /> Convertendo…
                  </>
                ) : state.step === "error" ? (
                  "Tentar de novo"
                ) : (
                  "Exportar"
                )}
              </button>
            </>
          )}
        </div>
      </div>
    </Modal>
  );
}
