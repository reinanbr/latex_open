import { useId, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api/client";
import { COMPILERS, COMPILER_LABEL, type Compiler, type ProjectMeta, type TreeNode } from "../api/types";
import { compileProject } from "../store/compile";
import { usePrefs } from "../store/prefs";
import { errorMessage, toast } from "../store/ui";
import { relint } from "../editor/diagnostics";
import { Modal } from "./Overlays";

function texFiles(node: TreeNode | undefined, out: string[] = []): string[] {
  for (const c of node?.children ?? []) {
    if (c.type === "folder") texFiles(c, out);
    else if (/\.(tex|ltx)$/i.test(c.path)) out.push(c.path);
  }
  return out;
}

/** "TeX Live 2025" from a version line such as "pdfTeX 3.14… (TeX Live 2025/Debian)". */
export function texLiveVersion(version: string | undefined): string | null {
  const m = /TeX Live (\d{4})/.exec(version ?? "");
  return m ? m[1]! : null;
}

function Row({ title, desc, children, htmlFor }: { title: string; desc: string; children: ReactNode; htmlFor?: string }) {
  return (
    <div className="setting-row">
      <div className="setting-text">
        <label className="setting-title" htmlFor={htmlFor}>
          {title}
        </label>
        <p className="setting-desc">{desc}</p>
      </div>
      <div className="setting-control">{children}</div>
    </div>
  );
}

function Switch({ checked, onChange, label, id }: { checked: boolean; onChange: (v: boolean) => void; label: string; id?: string }) {
  return (
    <button id={id} role="switch" aria-checked={checked} aria-label={label} className={`switch ${checked ? "on" : ""}`} onClick={() => onChange(!checked)}>
      <span className="switch-knob" />
    </button>
  );
}

/** Project and compile settings: main file, compiler, speed, error handling. */
export function CompileSettingsDialog({ meta, onClose }: { meta: ProjectMeta; onClose: () => void }) {
  const qc = useQueryClient();
  const caps = useQuery({ queryKey: ["capabilities"], queryFn: api.capabilities, staleTime: Infinity });
  const tree = useQuery({ queryKey: ["tree", meta.id], queryFn: () => api.tree(meta.id) });
  const prefs = usePrefs();
  const [saving, setSaving] = useState(false);
  const ids = useId();

  const files = texFiles(tree.data);
  if (meta.mainFile && !files.includes(meta.mainFile)) files.unshift(meta.mainFile);
  const available = (c: Compiler) => caps.data?.[c]?.available ?? true;
  const texlive = texLiveVersion(caps.data?.pdflatex.version) ?? texLiveVersion(caps.data?.xelatex.version) ?? texLiveVersion(caps.data?.lualatex.version);

  const save = async (patch: Partial<Pick<ProjectMeta, "mainFile" | "compiler">>) => {
    setSaving(true);
    try {
      const updated = await api.updateProject(meta.id, patch);
      qc.setQueryData(["project", meta.id], updated);
      toast("success", patch.compiler ? `Compilador: ${COMPILER_LABEL[patch.compiler]}` : `Arquivo principal: ${patch.mainFile}`);
      void compileProject(meta.id);
    } catch (err) {
      toast("error", errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal onClose={onClose} labelledBy={`${ids}-title`}>
      <div className="compile-settings">
        <h2 id={`${ids}-title`}>Configurações de compilação</h2>

        <Row
          title="Arquivo principal"
          htmlFor={`${ids}-main`}
          desc="O arquivo a partir do qual o projeto é compilado. Também dá para escolhê-lo clicando com o botão direito num arquivo da árvore."
        >
          <select id={`${ids}-main`} className="input" value={meta.mainFile} disabled={saving} onChange={(e) => void save({ mainFile: e.target.value })}>
            {!meta.mainFile && <option value="">(nenhum)</option>}
            {files.map((f) => (
              <option key={f} value={f}>
                {f}
              </option>
            ))}
          </select>
        </Row>

        <Row title="Compilador" htmlFor={`${ids}-compiler`} desc="O programa LaTeX usado para compilar o projeto.">
          <select
            id={`${ids}-compiler`}
            className="input"
            value={meta.compiler}
            disabled={saving}
            onChange={(e) => void save({ compiler: e.target.value as Compiler })}
          >
            {COMPILERS.map((c) => (
              <option key={c} value={c} disabled={!available(c)}>
                {COMPILER_LABEL[c]}
                {available(c) ? "" : " — não instalado"}
              </option>
            ))}
          </select>
        </Row>

        <Row title="Versão do TeX Live" desc="A distribuição TeX instalada no servidor (para trocar, atualize o TeX do servidor).">
          <span className="setting-readonly">{texlive ?? "desconhecida"}</span>
        </Row>

        <Row
          title="Pular imagens (modo rascunho)"
          htmlFor={`${ids}-draft`}
          desc="Deixa as imagens de fora do PDF para compilar mais rápido. Elas aparecem como caixas no lugar."
        >
          <Switch id={`${ids}-draft`} label="Pular imagens (modo rascunho)" checked={prefs.draft} onChange={(v) => prefs.set({ draft: v })} />
        </Row>

        <Row
          title="Parar no primeiro erro"
          htmlFor={`${ids}-stop`}
          desc="Interrompe a compilação no primeiro erro, para você corrigir um problema de cada vez."
        >
          <Switch id={`${ids}-stop`} label="Parar no primeiro erro" checked={prefs.stopOnFirstError} onChange={(v) => prefs.set({ stopOnFirstError: v })} />
        </Row>

        <Row title="Compilação automática" htmlFor={`${ids}-auto`} desc="Recompila sozinho alguns segundos depois de cada alteração.">
          <Switch id={`${ids}-auto`} label="Compilação automática" checked={prefs.autoCompile} onChange={(v) => prefs.set({ autoCompile: v })} />
        </Row>

        <Row
          title="Verificação de sintaxe"
          htmlFor={`${ids}-syntax`}
          desc="Enquanto você digita, aponta no editor chaves, ambientes e fórmulas que ficaram sem fechamento."
        >
          <Switch
            id={`${ids}-syntax`}
            label="Verificação de sintaxe"
            checked={prefs.syntaxCheck}
            onChange={(v) => {
              prefs.set({ syntaxCheck: v });
              relint();
            }}
          />
        </Row>

        <div className="dialog-actions">
          <button className="btn btn-primary" onClick={onClose} autoFocus>
            Fechar
          </button>
        </div>
      </div>
    </Modal>
  );
}
