import { useRef, useState, type DragEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api/client";
import type { ProjectMeta } from "../api/types";
import { Icon } from "../components/Icon";
import { ThemeToggle } from "../components/ThemeToggle";
import { relativeTime } from "../lib/format";
import { navigate } from "../lib/router";
import { confirmDialog, errorMessage, promptDialog, toast } from "../store/ui";

export function ProjectList() {
  const qc = useQueryClient();
  const projects = useQuery({ queryKey: ["projects"], queryFn: api.listProjects });
  const [dragging, setDragging] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const dragDepth = useRef(0);

  const importZip = useMutation({
    mutationFn: (file: File) => api.importZip(file, setProgress),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ["projects"] });
      for (const w of res.warnings) toast("warning", w);
      navigate(`/project/${res.project.id}`);
    },
    onError: (err) => toast("error", `Falha ao importar: ${errorMessage(err)}`),
    onSettled: () => setProgress(null),
  });

  const handleFiles = (files: FileList | null) => {
    const file = files?.[0];
    if (!file) return;
    if (!/\.zip$/i.test(file.name)) {
      toast("error", "Envie um arquivo .zip com o projeto LaTeX.");
      return;
    }
    importZip.mutate(file);
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    dragDepth.current = 0;
    setDragging(false);
    handleFiles(e.dataTransfer.files);
  };

  const newBlank = async () => {
    const name = await promptDialog({
      title: "Novo projeto em branco",
      initial: "Projeto sem título",
      confirmLabel: "Criar",
    });
    if (!name) return;
    try {
      const res = await api.createBlank(name);
      qc.invalidateQueries({ queryKey: ["projects"] });
      navigate(`/project/${res.project.id}`);
    } catch (err) {
      toast("error", errorMessage(err));
    }
  };

  const uploading = progress !== null;

  return (
    <div className="home">
      <header className="topbar">
        <a className="brand" href="/" onClick={(e) => e.preventDefault()}>
          <span className="brand-mark">T</span> texdesk
        </a>
        <span className="spacer" />
        <ThemeToggle />
      </header>

      <main className="home-main">
        <div className="home-head">
          <h1>Projetos</h1>
          <button className="btn btn-primary" onClick={newBlank}>
            <Icon name="plus" /> Novo projeto em branco
          </button>
        </div>

        <div
          className={`dropzone ${dragging ? "dragging" : ""}`}
          role="button"
          tabIndex={0}
          aria-label="Importar projeto .zip"
          onClick={() => !uploading && fileInput.current?.click()}
          onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && fileInput.current?.click()}
          onDragEnter={(e) => {
            e.preventDefault();
            dragDepth.current++;
            setDragging(true);
          }}
          onDragOver={(e) => e.preventDefault()}
          onDragLeave={() => {
            if (--dragDepth.current <= 0) setDragging(false);
          }}
          onDrop={onDrop}
        >
          <Icon name="upload" className="dz-icon" />
          {uploading ? (
            <>
              <strong>{progress < 1 ? "Enviando…" : "Descompactando e analisando…"}</strong>
              <div className="progress" aria-hidden="true">
                <div style={{ width: `${Math.round(progress * 100)}%` }} />
              </div>
            </>
          ) : (
            <>
              <strong>Arraste um .zip com seu projeto LaTeX</strong>
              <span>ou clique para escolher o arquivo. O arquivo principal é detectado automaticamente.</span>
            </>
          )}
          <input
            ref={fileInput}
            type="file"
            accept=".zip,application/zip"
            hidden
            onChange={(e) => {
              handleFiles(e.target.files);
              e.target.value = "";
            }}
          />
        </div>

        {projects.isLoading && <div className="empty-state">Carregando…</div>}
        {projects.isError && <div className="empty-state">Erro ao carregar projetos: {errorMessage(projects.error)}</div>}
        {projects.data && projects.data.length === 0 && (
          <div className="empty-state">Nenhum projeto ainda. Importe um .zip ou crie um projeto em branco.</div>
        )}
        {projects.data && projects.data.length > 0 && <ProjectTable projects={projects.data} />}
      </main>
    </div>
  );
}

function ProjectTable({ projects }: { projects: ProjectMeta[] }) {
  const qc = useQueryClient();
  const refresh = () => qc.invalidateQueries({ queryKey: ["projects"] });

  const rename = async (p: ProjectMeta) => {
    const name = await promptDialog({ title: "Renomear projeto", initial: p.name, confirmLabel: "Renomear" });
    if (!name || name === p.name) return;
    try {
      await api.updateProject(p.id, { name });
      refresh();
    } catch (err) {
      toast("error", errorMessage(err));
    }
  };

  const remove = async (p: ProjectMeta) => {
    const ok = await confirmDialog({
      title: "Excluir projeto?",
      message: `“${p.name}” e todos os seus arquivos serão apagados permanentemente.`,
      confirmLabel: "Excluir",
      danger: true,
    });
    if (!ok) return;
    try {
      await api.deleteProject(p.id);
      refresh();
      toast("success", "Projeto excluído.");
    } catch (err) {
      toast("error", errorMessage(err));
    }
  };

  return (
    <table className="project-table">
      <thead>
        <tr>
          <th>Nome</th>
          <th className="col-date">Modificado</th>
          <th className="col-actions">
            <span className="sr-only">Ações</span>
          </th>
        </tr>
      </thead>
      <tbody>
        {projects.map((p) => (
          <tr key={p.id}>
            <td className="name-cell">
              <a
                href={`/project/${p.id}`}
                onClick={(e) => {
                  if (e.ctrlKey || e.metaKey || e.button !== 0) return;
                  e.preventDefault();
                  navigate(`/project/${p.id}`);
                }}
              >
                {p.name}
              </a>
              <span className="sub">
                {p.mainFile || "sem arquivo principal"} · {p.compiler}
              </span>
            </td>
            <td className="col-date" title={new Date(p.updatedAt).toLocaleString("pt-BR")}>
              {relativeTime(p.updatedAt)}
            </td>
            <td className="col-actions">
              <div className="actions">
                <button className="icon-btn" title="Abrir" aria-label="Abrir" onClick={() => navigate(`/project/${p.id}`)}>
                  <Icon name="chevronRight" />
                </button>
                <button className="icon-btn" title="Renomear" aria-label="Renomear" onClick={() => rename(p)}>
                  <Icon name="edit" />
                </button>
                <a className="icon-btn" title="Baixar .zip" aria-label="Baixar .zip" href={api.exportUrl(p.id, "zip")} download>
                  <Icon name="download" />
                </a>
                <button className="icon-btn" title="Excluir" aria-label="Excluir" onClick={() => remove(p)}>
                  <Icon name="trash" />
                </button>
              </div>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
