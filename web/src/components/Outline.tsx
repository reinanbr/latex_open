import { useMemo } from "react";
import { useEditor } from "../store/editor";

/** Section outline of the active file; highlights the section at the cursor. */
export function Outline() {
  const outline = useEditor((s) => s.outline);
  const active = useEditor((s) => s.active);
  const cursorLine = useEditor((s) => s.cursor?.line ?? 0);
  const sections = outline && outline.path === active ? outline.sections : null;

  const current = useMemo(() => {
    if (!sections) return -1;
    let idx = -1;
    sections.forEach((s, i) => {
      if (s.line <= cursorLine) idx = i;
    });
    return idx;
  }, [sections, cursorLine]);

  const minLevel = sections && sections.length ? Math.min(...sections.map((s) => s.level)) : 0;

  return (
    <div className="outline-pane">
      <div className="pane-header">
        <span className="title">Estrutura</span>
      </div>
      <div className="outline-list" role="tree" aria-label="Estrutura do documento">
        {!sections && <div className="outline-empty">Abra um arquivo .tex para ver as seções.</div>}
        {sections && sections.length === 0 && <div className="outline-empty">Nenhuma seção neste arquivo.</div>}
        {sections?.map((s, i) => (
          <button
            key={`${s.line}-${i}`}
            role="treeitem"
            aria-current={i === current ? "location" : undefined}
            className={`outline-item ${i === current ? "current" : ""}`}
            style={{ paddingLeft: 12 + (s.level - minLevel) * 14 }}
            title={`${s.command}${s.starred ? "*" : ""} — linha ${s.line}`}
            onClick={() => active && useEditor.getState().open(active, { line: s.line })}
          >
            {s.title || <em>(sem título)</em>}
          </button>
        ))}
      </div>
    </div>
  );
}
