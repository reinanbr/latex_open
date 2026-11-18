import { useMemo } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "../api/client";
import type { ProjectMeta } from "../api/types";
import { useEditor } from "../store/editor";
import { confirmDialog, errorMessage, promptDialog, toast } from "../store/ui";
import { basename, dirname, fileKind, joinPath } from "../lib/format";

/** Tree operations shared by the file tree, its context menu and drag & drop. */
export function useFileOps(projectId: string) {
  const qc = useQueryClient();

  return useMemo(() => {
    const refreshTree = () => qc.invalidateQueries({ queryKey: ["tree", projectId] });
    const refreshProject = () => qc.invalidateQueries({ queryKey: ["project", projectId] });
    const fail = (err: unknown) => toast("error", errorMessage(err));

    const validName = (name: string) => {
      if (name.includes("/") || name === "." || name === "..") {
        toast("error", "Nome inválido.");
        return false;
      }
      return true;
    };

    const create = async (dir: string, type: "file" | "folder") => {
      const name = await promptDialog({
        title: type === "file" ? "Novo arquivo" : "Nova pasta",
        message: dir ? `Em ${dir}/` : "Na raiz do projeto",
        initial: type === "file" ? "novo.tex" : "",
        placeholder: type === "file" ? "capitulo.tex" : "figuras",
        select: type === "file" ? [0, 4] : undefined,
        confirmLabel: "Criar",
      });
      if (!name || !validName(name)) return;
      try {
        const { path } = await api.createEntry(projectId, joinPath(dir, name), type);
        await refreshTree();
        if (type === "file") useEditor.getState().open(path);
        return path;
      } catch (err) {
        fail(err);
      }
    };

    const move = async (from: string, to: string) => {
      if (from === to) return;
      const { docs } = useEditor.getState();
      try {
        await docs?.flushUnder(from);
        const { path } = await api.rename(projectId, from, to);
        docs?.rekey(from, path);
        useEditor.getState().renamePath(from, path);
        await Promise.all([refreshTree(), refreshProject()]);
      } catch (err) {
        fail(err);
      }
    };

    const rename = async (path: string, newName: string) => {
      newName = newName.trim();
      if (!newName || newName === basename(path) || !validName(newName)) return;
      await move(path, joinPath(dirname(path), newName));
    };

    const moveInto = async (path: string, targetDir: string) => {
      if (dirname(path) === targetDir) return;
      if (targetDir === path || targetDir.startsWith(path + "/")) {
        toast("error", "Não é possível mover uma pasta para dentro dela mesma.");
        return;
      }
      await move(path, joinPath(targetDir, basename(path)));
    };

    const remove = async (path: string, type: "file" | "folder") => {
      const ok = await confirmDialog({
        title: type === "folder" ? "Excluir pasta?" : "Excluir arquivo?",
        message:
          type === "folder"
            ? `A pasta “${path}” e tudo dentro dela serão apagados permanentemente.`
            : `“${path}” será apagado permanentemente.`,
        confirmLabel: "Excluir",
        danger: true,
      });
      if (!ok) return;
      try {
        await api.remove(projectId, path);
        useEditor.getState().removePath(path);
        await Promise.all([refreshTree(), refreshProject()]);
      } catch (err) {
        fail(err);
      }
    };

    const setMain = async (path: string) => {
      try {
        const meta = await api.updateProject(projectId, { mainFile: path });
        qc.setQueryData<ProjectMeta>(["project", projectId], meta);
        toast("success", `${path} agora é o arquivo principal.`);
      } catch (err) {
        fail(err);
      }
    };

    const upload = async (dir: string, files: File[]) => {
      if (files.length === 0) return;
      try {
        const res = await api.upload(projectId, dir, files);
        await refreshTree();
        const n = res.uploaded.length;
        toast("success", n === 1 ? `Enviado: ${res.uploaded[0]}` : `${n} arquivos enviados.`);
        if (res.skipped.length) toast("info", `Ignorados: ${res.skipped.join(", ")}`);
        // Open documents replaced by the upload are reloaded when unmodified.
        const { docs, markReloaded } = useEditor.getState();
        for (const p of res.uploaded) {
          if (docs?.has(p) && fileKind(p) === "text" && (await docs.reloadIfClean(p))) markReloaded(p);
        }
      } catch (err) {
        fail(err);
      }
    };

    return { create, rename, moveInto, remove, setMain, upload, refreshTree };
  }, [projectId, qc]);
}
