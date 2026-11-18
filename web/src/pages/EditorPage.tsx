import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Group, Panel, Separator } from "react-resizable-panels";
import type { EditorView, KeyBinding } from "@codemirror/view";
import { api, ApiError } from "../api/client";
import type { ProjectMeta, TreeNode } from "../api/types";
import { Icon } from "../components/Icon";
import { MenuButton } from "../components/Overlays";
import { ThemeToggle } from "../components/ThemeToggle";
import { FileTree } from "../components/FileTree";
import { CodeEditor } from "../components/CodeEditor";
import { Tabs } from "../components/Tabs";
import { FilePreview } from "../components/FilePreview";
import { Outline } from "../components/Outline";
import { PrefsMenu } from "../components/PrefsMenu";
import { MarkdownExportDialog } from "../components/MarkdownExport";
import { WordCount } from "../components/WordCount";
import { setCompletionData } from "../editor/completion";
import { relint } from "../editor/diagnostics";
import { resetKBProject } from "../editor/kb";
import { useLive } from "../store/live";
import { syncToCode, syncToPdf } from "../store/sync";
import { DocManager } from "../editor/docs";
import { buildExtensions } from "../editor/extensions";
import { navigate } from "../lib/router";
import { fileKind } from "../lib/format";
import { overallSaveStatus, useEditor } from "../store/editor";
import { usePrefs, type Layout } from "../store/prefs";
import { errorMessage, toast } from "../store/ui";
import { PdfPane } from "../pdf/PdfPane";
import { cancelAutoCompile, compileProject, problemFiles, scheduleAutoCompile, useCompile } from "../store/compile";

export function EditorPage({ projectId }: { projectId: string }) {
  const project = useQuery({ queryKey: ["project", projectId], queryFn: () => api.getProject(projectId) });
  const viewRef = useRef<EditorView | null>(null);

  // Page-level actions reachable from editor keybindings; kept in a ref so the
  // (long-lived) editor extensions always call the latest version.
  const actions = useRef({
    /** Ctrl+S: save and recompile (like the reference ergonomics). */
    save: async () => {
      await useEditor.getState().docs?.flushAll();
      void compileProject(projectId);
    },
    compile: () => void compileProject(projectId),
    refreshIndex: () => {},
  });

  const docs = useMemo(() => {
    const keys: KeyBinding[] = [
      {
        key: "Mod-s",
        preventDefault: true,
        run: () => {
          void actions.current.save();
          return true;
        },
      },
      {
        key: "Mod-Enter",
        preventDefault: true,
        run: () => {
          actions.current.compile();
          return true;
        },
      },
      {
        // Forward SyncTeX: show the cursor position in the PDF.
        key: "Mod-Shift-.",
        preventDefault: true,
        run: () => {
          void syncToPdf(projectId);
          return true;
        },
      },
    ];
    return new DocManager({
      projectId,
      makeExtensions: (path) => buildExtensions(path, usePrefs.getState(), { keys, extra: [] }),
      onStatus: (path, status, error) => useEditor.getState().setSaveStatus(path, status, error),
      onSaved: () => {
        scheduleAutoCompile(projectId);
        actions.current.refreshIndex();
      },
    });
  }, [projectId]);

  useEffect(() => {
    useEditor.getState().init(projectId, docs);
    useCompile.getState().reset();
    const onUnload = (e: BeforeUnloadEvent) => {
      if (!docs.isDirty()) return;
      docs.flushOnUnload();
      e.preventDefault();
    };
    window.addEventListener("beforeunload", onUnload);
    return () => {
      window.removeEventListener("beforeunload", onUnload);
      cancelAutoCompile();
      void docs.flushAll().finally(() => docs.dispose());
    };
  }, [projectId, docs]);

  // Shortcuts outside the editor (tree, PDF): Ctrl+S saves + compiles
  // instead of "save page as"; Ctrl+Enter compiles.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.defaultPrevented) return;
      if (e.key.toLowerCase() === "s") {
        e.preventDefault();
        void actions.current.save();
      } else if (e.key === "Enter") {
        e.preventDefault();
        actions.current.compile();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (project.data) document.title = `${project.data.name} — texdesk`;
    return () => {
      document.title = "texdesk";
    };
  }, [project.data]);

  // Open the main file and compile once on first load.
  const opened = useRef(false);
  const caps = useQuery({ queryKey: ["capabilities"], queryFn: api.capabilities, staleTime: Infinity });
  useEffect(() => {
    if (!opened.current && project.data && caps.data) {
      opened.current = true;
      if (project.data.mainFile) {
        useEditor.getState().open(project.data.mainFile);
        if (caps.data.latexmk.available) void compileProject(projectId);
      }
    }
  }, [project.data, caps.data, projectId]);
  // Autocomplete data: project index (labels, bib keys, macros) and file list.
  const qc = useQueryClient();
  const index = useQuery({ queryKey: ["index", projectId], queryFn: () => api.index(projectId), staleTime: 30_000 });
  const tree = useQuery({ queryKey: ["tree", projectId], queryFn: () => api.tree(projectId) });
  useEffect(() => {
    let timer: number | null = null;
    actions.current.refreshIndex = () => {
      if (timer !== null) window.clearTimeout(timer);
      timer = window.setTimeout(() => void qc.invalidateQueries({ queryKey: ["index", projectId] }), 1500);
    };
    return () => {
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [qc, projectId]);
  useEffect(() => {
    if (index.data) {
      setCompletionData({ index: index.data });
      relint(); // labels/keys changed: refresh the live warnings
    }
  }, [index.data]);
  useEffect(() => {
    if (tree.data) {
      setCompletionData({ files: flattenFiles(tree.data) });
      relint();
    }
  }, [tree.data]);
  const mainFile = project.data?.mainFile;
  useEffect(() => {
    setCompletionData({ mainFile: mainFile ?? "" });
  }, [mainFile]);
  useEffect(
    () => () => {
      setCompletionData({ index: { labels: [], citations: [], macros: [], environments: [] }, files: [], mainFile: "" }, false);
      resetKBProject();
    },
    [projectId],
  );

  const layout = usePrefs((s) => s.layout);
  const problems = useCompile((s) => s.result?.problems);
  const livePath = useLive((s) => s.path);
  const liveIssues = useLive((s) => s.issues);
  const markers = useMemo(() => {
    const m = problemFiles(problems);
    // The file being edited also shows what the live check finds.
    if (livePath && liveIssues.length) {
      if (liveIssues.some((i) => i.severity === "error")) m.set(livePath, "error");
      else if (!m.has(livePath)) m.set(livePath, "warning");
    }
    return m;
  }, [problems, livePath, liveIssues]);

  if (project.isError) {
    const notFound = project.error instanceof ApiError && project.error.status === 404;
    return (
      <div className="empty-state">
        <p>{notFound ? "Projeto não encontrado." : `Erro: ${errorMessage(project.error)}`}</p>
        <button className="btn" onClick={() => navigate("/")}>
          Voltar aos projetos
        </button>
      </div>
    );
  }
  if (!project.data) return <div className="empty-state">Carregando…</div>;
  const meta = project.data;

  return (
    <div className="editor-page">
      <header className="topbar">
        <button className="icon-btn" title="Voltar aos projetos" aria-label="Voltar aos projetos" onClick={() => navigate("/")}>
          <Icon name="back" />
        </button>
        <span className="topbar-sep" />
        <ProjectName meta={meta} />
        <span className="spacer" />
        <WordCount meta={meta} />
        <LayoutToggle layout={layout} />
        <DownloadMenu meta={meta} />
        <PrefsMenu />
        <ThemeToggle />
      </header>
      <div className="editor-body">
        <Group orientation="horizontal">
          <Panel id="tree" defaultSize="18%" minSize="160px" maxSize="45%">
            <div className="pane pane-left">
              <Group orientation="vertical">
                <Panel id="files" minSize="64px">
                  <div className="pane-section">
                    <FileTree projectId={projectId} mainFile={meta.mainFile} problemFiles={markers} />
                  </div>
                </Panel>
                <Separator className="resize-handle horizontal" />
                <Panel id="outline" defaultSize="35%" minSize="34px">
                  <Outline />
                </Panel>
              </Group>
            </div>
          </Panel>
          <Separator className="resize-handle" />
          {layout !== "pdf" && (
            <Panel id="editor" minSize="20%">
              <CenterPane projectId={projectId} onView={(v) => (viewRef.current = v)} />
            </Panel>
          )}
          {layout === "both" && <Separator className="resize-handle" />}
          {layout !== "editor" && (
            <Panel id="pdf" defaultSize={layout === "pdf" ? undefined : "40%"} minSize="15%">
              <PdfPane
                meta={meta}
                onInverseSync={(page, x, y) => void syncToCode(projectId, page, x, y)}
                onForwardSync={layout === "both" ? () => void syncToPdf(projectId) : undefined}
              />
            </Panel>
          )}
        </Group>
      </div>
    </div>
  );
}

function flattenFiles(node: TreeNode, out: string[] = []): string[] {
  for (const c of node.children ?? []) {
    if (c.type === "file") out.push(c.path);
    else flattenFiles(c, out);
  }
  return out;
}

const LAYOUTS: { value: Layout; icon: "layoutEditor" | "layoutBoth" | "layoutPdf"; label: string }[] = [
  { value: "editor", icon: "layoutEditor", label: "Só o editor" },
  { value: "both", icon: "layoutBoth", label: "Editor e PDF" },
  { value: "pdf", icon: "layoutPdf", label: "Só o PDF" },
];

function LayoutToggle({ layout }: { layout: Layout }) {
  const set = usePrefs((s) => s.set);
  return (
    <div className="seg" role="group" aria-label="Layout">
      {LAYOUTS.map((l) => (
        <button key={l.value} title={l.label} aria-label={l.label} aria-pressed={layout === l.value} onClick={() => set({ layout: l.value })}>
          <Icon name={l.icon} />
        </button>
      ))}
    </div>
  );
}

function CenterPane({ projectId, onView }: { projectId: string; onView: (v: EditorView | null) => void }) {
  const active = useEditor((s) => s.active);
  const kind = active ? fileKind(active) : null;
  useEffect(() => {
    if (kind !== "text") useEditor.getState().setOutline(null);
  }, [kind, active]);
  return (
    <div className="pane">
      <Tabs />
      {!active && <div className="editor-placeholder">Abra um arquivo na árvore à esquerda.</div>}
      {active && kind === "text" && <CodeEditor path={active} onView={onView} />}
      {active && kind !== "text" && <FilePreview projectId={projectId} path={active} />}
      <StatusBar />
    </div>
  );
}

function StatusBar() {
  const active = useEditor((s) => s.active);
  const cursor = useEditor((s) => s.cursor);
  const statusMap = useEditor((s) => s.saveStatus);
  const saveError = useEditor((s) => s.saveError);
  const status = overallSaveStatus(statusMap);
  const isText = active ? fileKind(active) === "text" : false;
  return (
    <div className="editor-status">
      <span className={`save-state ${status === "error" ? "error" : ""}`} title={saveError ?? undefined}>
        {status === "saving" && (
          <>
            <span className="spinner" style={{ width: 10, height: 10 }} /> Salvando…
          </>
        )}
        {status === "dirty" && "Alterações não salvas"}
        {status === "saved" && (
          <>
            <Icon name="check" style={{ width: 13, height: 13 }} /> Salvo
          </>
        )}
        {status === "error" && (
          <>
            <Icon name="alert" style={{ width: 13, height: 13 }} /> Erro ao salvar — tentando de novo
          </>
        )}
      </span>
      <span className="spacer" />
      {active && <span className="muted">{active}</span>}
      {isText && cursor && (
        <span>
          Ln {cursor.line}, Col {cursor.col}
        </span>
      )}
    </div>
  );
}

export function ProjectName({ meta }: { meta: ProjectMeta }) {
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(meta.name);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => setValue(meta.name), [meta.name]);
  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);

  const commit = async () => {
    setEditing(false);
    const name = value.trim();
    if (!name || name === meta.name) {
      setValue(meta.name);
      return;
    }
    try {
      const updated = await api.updateProject(meta.id, { name });
      qc.setQueryData(["project", meta.id], updated);
      void qc.invalidateQueries({ queryKey: ["projects"] });
    } catch (err) {
      setValue(meta.name);
      toast("error", errorMessage(err));
    }
  };

  if (editing) {
    return (
      <input
        ref={inputRef}
        className="input project-name-input"
        aria-label="Nome do projeto"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
          if (e.key === "Escape") {
            setValue(meta.name);
            setEditing(false);
          }
        }}
      />
    );
  }
  return (
    <button className="project-name" title="Clique para renomear" onClick={() => setEditing(true)}>
      {meta.name}
    </button>
  );
}

export function DownloadMenu({ meta }: { meta: ProjectMeta }) {
  const caps = useQuery({ queryKey: ["capabilities"], queryFn: api.capabilities, staleTime: Infinity });
  const [mdOpen, setMdOpen] = useState(false);
  const pandoc = caps.data?.pandoc;
  const mdReason = !meta.mainFile ? "Defina um arquivo principal" : pandoc && !pandoc.available ? `pandoc indisponível: ${pandoc.reason ?? "não instalado"}` : null;
  return (
    <>
      <MenuButton
        label="Download"
        align="right"
        button={
          <>
            <Icon name="download" /> Download <Icon name="chevronDown" />
          </>
        }
      >
        {(close) => (
          <>
            <a className="menu-item" href={api.exportUrl(meta.id, "pdf")} download onClick={close}>
              <Icon name="pdf" /> PDF
            </a>
            <a className="menu-item" href={api.exportUrl(meta.id, "zip")} download onClick={close}>
              <Icon name="zip" /> Código-fonte (.zip)
            </a>
            <button
              className="menu-item"
              aria-disabled={!!mdReason}
              title={mdReason ?? "Conversão aproximada via pandoc"}
              onClick={() => {
                if (mdReason) return;
                close();
                setMdOpen(true);
              }}
            >
              <Icon name="markdown" /> Markdown…
            </button>
            {mdReason && <div className="menu-note">{mdReason}.</div>}
          </>
        )}
      </MenuButton>
      {mdOpen && <MarkdownExportDialog meta={meta} onClose={() => setMdOpen(false)} />}
    </>
  );
}
