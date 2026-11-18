import { useEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent, type MouseEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api/client";
import type { TreeNode } from "../api/types";
import { useEditor } from "../store/editor";
import { loadJSON, writeLS } from "../store/ui";
import { useFileOps } from "../editor/useFileOps";
import { dirname, extname } from "../lib/format";
import { Icon, fileIconName } from "./Icon";
import { MenuButton } from "./Overlays";

const DRAG_TYPE = "application/x-texdesk-path";

interface Props {
  projectId: string;
  mainFile: string;
  /** Files with problems from the last compile (for tree markers). */
  problemFiles?: Map<string, "error" | "warning">;
}

interface CtxMenu {
  x: number;
  y: number;
  node: TreeNode | null; // null = root
}

/** Visible rows in order (for keyboard navigation). */
function flatten(nodes: TreeNode[] | undefined, collapsed: Set<string>, out: TreeNode[] = []): TreeNode[] {
  for (const n of nodes ?? []) {
    out.push(n);
    if (n.type === "folder" && !collapsed.has(n.path)) flatten(n.children, collapsed, out);
  }
  return out;
}

export function FileTree({ projectId, mainFile, problemFiles }: Props) {
  const tree = useQuery({ queryKey: ["tree", projectId], queryFn: () => api.tree(projectId) });
  const active = useEditor((s) => s.active);
  const open = useEditor((s) => s.open);
  const ops = useFileOps(projectId);
  const lsKey = `texdesk.collapsed.${projectId}`;
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set(loadJSON<{ v: string[] }>(lsKey, { v: [] }).v));
  const [selected, setSelected] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null); // "" = root
  const [ctx, setCtx] = useState<CtxMenu | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);
  const uploadDir = useRef("");
  const treeRef = useRef<HTMLDivElement>(null);

  useEffect(() => writeLS(lsKey, JSON.stringify({ v: [...collapsed] })), [collapsed, lsKey]);
  // Follow the active editor tab, revealing it inside collapsed folders.
  useEffect(() => {
    if (!active) return;
    setSelected(active);
    reveal(active);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  const byPath = useMemo(() => {
    const m = new Map<string, TreeNode>();
    const walk = (ns?: TreeNode[]) => ns?.forEach((n) => (m.set(n.path, n), walk(n.children)));
    walk(tree.data?.children);
    return m;
  }, [tree.data]);

  const rows = useMemo(() => flatten(tree.data?.children, collapsed), [tree.data, collapsed]);

  // Folder that "new file"/"upload" target: the selected folder, or the selected file's folder.
  const targetDir = () => {
    if (!selected) return "";
    const n = byPath.get(selected);
    return n?.type === "folder" ? n.path : dirname(selected);
  };

  /** Expand every ancestor folder of a path. */
  function reveal(path: string) {
    const parts = path.split("/").slice(0, -1);
    const ancestors = parts.map((_, i) => parts.slice(0, i + 1).join("/"));
    setCollapsed((prev) => {
      if (!ancestors.some((a) => prev.has(a))) return prev;
      const next = new Set(prev);
      ancestors.forEach((a) => next.delete(a));
      return next;
    });
  }

  const create = async (dir: string, type: "file" | "folder") => {
    const p = await ops.create(dir, type);
    if (p) {
      reveal(p);
      setSelected(p);
    }
  };

  const toggle = (p: string, force?: boolean) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      const isCollapsed = next.has(p);
      if (force === undefined ? isCollapsed : force) next.delete(p);
      else next.add(p);
      return next;
    });

  const activate = (n: TreeNode) => {
    setSelected(n.path);
    if (n.type === "folder") toggle(n.path);
    else open(n.path);
  };

  const startUpload = (dir: string, folder = false) => {
    uploadDir.current = dir;
    (folder ? folderInput : fileInput).current?.click();
  };

  // ---------------------------------------------------------- keyboard
  const onKeyDown = (e: KeyboardEvent) => {
    if (renaming) return;
    const idx = rows.findIndex((r) => r.path === selected);
    const cur = rows[idx];
    switch (e.key) {
      case "ArrowDown":
      case "ArrowUp": {
        e.preventDefault();
        const next = rows[Math.max(0, Math.min(rows.length - 1, idx + (e.key === "ArrowDown" ? 1 : -1)))];
        if (next) setSelected(next.path);
        break;
      }
      case "ArrowRight":
        if (cur?.type === "folder") toggle(cur.path, true);
        break;
      case "ArrowLeft":
        if (cur?.type === "folder" && !collapsed.has(cur.path)) toggle(cur.path, false);
        else if (cur) setSelected(dirname(cur.path) || cur.path);
        break;
      case "Enter":
        if (cur) activate(cur);
        break;
      case "F2":
        e.preventDefault();
        if (cur) setRenaming(cur.path);
        break;
      case "Delete":
        if (cur) void ops.remove(cur.path, cur.type);
        break;
    }
  };

  // ------------------------------------------------------- drag & drop
  const onDragStart = (e: DragEvent, n: TreeNode) => {
    e.dataTransfer.setData(DRAG_TYPE, n.path);
    e.dataTransfer.effectAllowed = "move";
  };

  const dropDirFor = (n: TreeNode | null) => (n ? (n.type === "folder" ? n.path : dirname(n.path)) : "");

  const onDragOver = (e: DragEvent, n: TreeNode | null) => {
    const internal = e.dataTransfer.types.includes(DRAG_TYPE);
    const external = e.dataTransfer.types.includes("Files");
    if (!internal && !external) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = internal ? "move" : "copy";
    setDropTarget(dropDirFor(n));
  };

  const onDrop = (e: DragEvent, n: TreeNode | null) => {
    e.preventDefault();
    e.stopPropagation();
    setDropTarget(null);
    const dir = dropDirFor(n);
    const moved = e.dataTransfer.getData(DRAG_TYPE);
    if (moved) {
      void ops.moveInto(moved, dir);
      return;
    }
    const files = [...e.dataTransfer.files];
    if (files.length) {
      if (dir) toggle(dir, true);
      void ops.upload(dir, files);
    }
  };

  // ------------------------------------------------------------ render
  const renderNode = (n: TreeNode, depth: number) => {
    const isFolder = n.type === "folder";
    const isOpen = isFolder && !collapsed.has(n.path);
    const problem = problemFiles?.get(n.path);
    return (
      <div key={n.path} role="treeitem" aria-expanded={isFolder ? isOpen : undefined} aria-selected={selected === n.path}>
        <div
          className={[
            "tree-row",
            isFolder ? "folder" : "",
            selected === n.path ? "selected" : "",
            isFolder && dropTarget === n.path ? "drop-target" : "",
          ].join(" ")}
          style={{ paddingLeft: 6 + depth * 14 }}
          title={n.path}
          draggable={renaming !== n.path}
          onDragStart={(e) => onDragStart(e, n)}
          onDragOver={(e) => onDragOver(e, n)}
          onDragLeave={() => setDropTarget(null)}
          onDrop={(e) => onDrop(e, n)}
          onClick={() => activate(n)}
          onDoubleClick={(e) => {
            e.preventDefault();
            setRenaming(n.path);
          }}
          onContextMenu={(e: MouseEvent) => {
            e.preventDefault();
            e.stopPropagation();
            setSelected(n.path);
            setCtx({ x: e.clientX, y: e.clientY, node: n });
          }}
        >
          {isFolder ? <Icon name={isOpen ? "chevronDown" : "chevronRight"} className="twisty" /> : <span className="twisty" />}
          <Icon name={isFolder ? (isOpen ? "folderOpen" : "folder") : fileIconName(n.name)} className="ficon" />
          {renaming === n.path ? (
            <RenameInput
              initial={n.name}
              onDone={(name) => {
                setRenaming(null);
                treeRef.current?.focus();
                if (name !== null) void ops.rename(n.path, name);
              }}
            />
          ) : (
            <span className="name">{n.name}</span>
          )}
          {problem && <span className={`problem-dot ${problem}`} title={problem === "error" ? "Erros" : "Avisos"} />}
          {n.path === mainFile && <Icon name="star" className="main-badge" aria-label="Arquivo principal" />}
        </div>
        {isOpen && n.children?.map((c) => renderNode(c, depth + 1))}
      </div>
    );
  };

  return (
    <>
      <div className="pane-header">
        <span className="title">Arquivos</span>
        <button className="icon-btn" title="Novo arquivo" aria-label="Novo arquivo" onClick={() => void create(targetDir(), "file")}>
          <Icon name="filePlus" />
        </button>
        <button className="icon-btn" title="Nova pasta" aria-label="Nova pasta" onClick={() => void create(targetDir(), "folder")}>
          <Icon name="folderPlus" />
        </button>
        <MenuButton label="Upload" className="icon-btn" button={<Icon name="upload" />} align="right">
          {(close) => (
            <>
              <button className="menu-item" onClick={() => (close(), startUpload(targetDir()))}>
                <Icon name="file" /> Enviar arquivos…
              </button>
              <button className="menu-item" onClick={() => (close(), startUpload(targetDir(), true))}>
                <Icon name="folder" /> Enviar pasta…
              </button>
              <div className="menu-note">Destino: {targetDir() || "raiz do projeto"}. Você também pode arrastar arquivos para a árvore.</div>
            </>
          )}
        </MenuButton>
      </div>
      <div
        ref={treeRef}
        className={`tree ${dropTarget === "" ? "drop-root" : ""}`}
        role="tree"
        aria-label="Arquivos do projeto"
        tabIndex={0}
        onKeyDown={onKeyDown}
        onDragOver={(e) => onDragOver(e, null)}
        onDragLeave={(e) => {
          if (e.currentTarget === e.target) setDropTarget(null);
        }}
        onDrop={(e) => onDrop(e, null)}
        onContextMenu={(e) => {
          e.preventDefault();
          setSelected(null);
          setCtx({ x: e.clientX, y: e.clientY, node: null });
        }}
        onClick={(e) => e.target === e.currentTarget && setSelected(null)}
      >
        {tree.isLoading && <div className="outline-empty">Carregando…</div>}
        {tree.data?.children?.map((c) => renderNode(c, 0))}
        {tree.data && tree.data.children?.length === 0 && <div className="outline-empty">Projeto vazio.</div>}
      </div>

      {ctx && (
        <ContextMenu
          menu={ctx}
          isMain={ctx.node?.path === mainFile}
          onClose={() => setCtx(null)}
          onOpen={(n) => activate(n)}
          onRename={(n) => setRenaming(n.path)}
          onDelete={(n) => void ops.remove(n.path, n.type)}
          onSetMain={(n) => void ops.setMain(n.path)}
          onNew={(dir, type) => void create(dir, type)}
          onUpload={(dir) => startUpload(dir)}
          downloadUrl={(n) => `${api.fileUrl(projectId, n.path)}?download=1`}
        />
      )}

      <input
        ref={fileInput}
        type="file"
        multiple
        hidden
        onChange={(e) => {
          void ops.upload(uploadDir.current, [...(e.target.files ?? [])]);
          e.target.value = "";
        }}
      />
      <input
        ref={(el) => {
          folderInput.current = el;
          el?.setAttribute("webkitdirectory", "");
        }}
        type="file"
        hidden
        onChange={(e) => {
          void ops.upload(uploadDir.current, [...(e.target.files ?? [])]);
          e.target.value = "";
        }}
      />
    </>
  );
}

function RenameInput({ initial, onDone }: { initial: string; onDone: (name: string | null) => void }) {
  const [value, setValue] = useState(initial);
  const ref = useRef<HTMLInputElement>(null);
  const done = useRef(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    const dot = initial.lastIndexOf(".");
    el.setSelectionRange(0, dot > 0 ? dot : initial.length);
  }, [initial]);
  const finish = (v: string | null) => {
    if (done.current) return;
    done.current = true;
    onDone(v);
  };
  return (
    <input
      ref={ref}
      className="input tree-rename"
      value={value}
      aria-label="Novo nome"
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onChange={(e) => setValue(e.target.value)}
      onBlur={() => finish(value)}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") finish(value);
        if (e.key === "Escape") finish(null);
      }}
    />
  );
}

function ContextMenu({
  menu,
  isMain,
  onClose,
  onOpen,
  onRename,
  onDelete,
  onSetMain,
  onNew,
  onUpload,
  downloadUrl,
}: {
  menu: CtxMenu;
  isMain: boolean;
  onClose: () => void;
  onOpen: (n: TreeNode) => void;
  onRename: (n: TreeNode) => void;
  onDelete: (n: TreeNode) => void;
  onSetMain: (n: TreeNode) => void;
  onNew: (dir: string, type: "file" | "folder") => void;
  onUpload: (dir: string) => void;
  downloadUrl: (n: TreeNode) => string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x: menu.x, y: menu.y });
  useEffect(() => {
    const el = ref.current;
    if (el) {
      // Keep the menu inside the viewport.
      const r = el.getBoundingClientRect();
      setPos({
        x: Math.min(menu.x, window.innerWidth - r.width - 8),
        y: Math.min(menu.y, window.innerHeight - r.height - 8),
      });
    }
    const close = (e: Event) => {
      if (e instanceof globalThis.MouseEvent && ref.current?.contains(e.target as Node)) return;
      onClose();
    };
    const onKey = (e: globalThis.KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", onKey);
    window.addEventListener("blur", onClose);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("blur", onClose);
    };
  }, [menu, onClose]);

  const n = menu.node;
  const dir = n ? (n.type === "folder" ? n.path : dirname(n.path)) : "";
  const act = (fn: () => void) => () => {
    onClose();
    fn();
  };
  return (
    <div ref={ref} className="menu context-menu" role="menu" style={{ left: pos.x, top: pos.y }}>
      {n && n.type === "file" && (
        <button className="menu-item" onClick={act(() => onOpen(n))}>
          <Icon name="edit" /> Abrir
        </button>
      )}
      {n && n.type === "file" && extname(n.path) === "tex" && (
        <button className="menu-item" aria-disabled={isMain} onClick={act(() => !isMain && onSetMain(n))}>
          <Icon name="star" /> {isMain ? "Arquivo principal" : "Definir como principal"}
        </button>
      )}
      {n && (
        <>
          <button className="menu-item" onClick={act(() => onRename(n))}>
            <Icon name="edit" /> Renomear <span className="hint">F2</span>
          </button>
          {n.type === "file" && (
            <a className="menu-item" href={downloadUrl(n)} download onClick={onClose}>
              <Icon name="download" /> Baixar
            </a>
          )}
          <button className="menu-item" onClick={act(() => onDelete(n))}>
            <Icon name="trash" /> Excluir <span className="hint">Del</span>
          </button>
          <div className="menu-sep" />
        </>
      )}
      <button className="menu-item" onClick={act(() => onNew(dir, "file"))}>
        <Icon name="filePlus" /> Novo arquivo{dir ? ` em ${dir}/` : ""}
      </button>
      <button className="menu-item" onClick={act(() => onNew(dir, "folder"))}>
        <Icon name="folderPlus" /> Nova pasta{dir ? ` em ${dir}/` : ""}
      </button>
      <button className="menu-item" onClick={act(() => onUpload(dir))}>
        <Icon name="upload" /> Enviar arquivos{dir ? ` para ${dir}/` : ""}
      </button>
    </div>
  );
}
