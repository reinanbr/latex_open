import { useEffect, useRef, useState } from "react";
import { EditorSelection } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { useEditor } from "../store/editor";
import { usePrefs } from "../store/prefs";
import { flashLine, prefsCompartment, prefsExtension } from "../editor/extensions";
import { errorMessage } from "../store/ui";
import { activeEditor, applyToView } from "../editor/diagnostics";
import { updateOutline } from "../editor/outline";
import { useLive } from "../store/live";

/** The single CodeMirror view; swaps EditorStates when the active tab changes. */
export function CodeEditor({ path, onView }: { path: string; onView?: (v: EditorView | null) => void }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const pathRef = useRef<string | null>(null);
  const lastGoto = useRef(0);
  const docs = useEditor((s) => s.docs);
  const goto = useEditor((s) => s.goto);
  const reloadNonce = useEditor((s) => s.reloaded[path] ?? 0);
  const setCursor = useEditor((s) => s.setCursor);
  const fontSize = usePrefs((s) => s.fontSize);
  const lineWrap = usePrefs((s) => s.lineWrap);
  const keymapPref = usePrefs((s) => s.keymap);
  const [loadedPath, setLoadedPath] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Create the view once per DocManager.
  useEffect(() => {
    if (!hostRef.current || !docs) return;
    const view = new EditorView({
      parent: hostRef.current,
      dispatchTransactions: (trs, v) => {
        v.update(trs);
        const p = pathRef.current;
        if (!p) return;
        const changed = trs.some((tr) => tr.docChanged);
        docs.update(p, v.state, changed);
        if (changed) updateOutline(p, v.state.doc, 400);
        if (changed || trs.some((tr) => tr.selection)) {
          const head = v.state.selection.main.head;
          const line = v.state.doc.lineAt(head);
          setCursor({ line: line.number, col: head - line.from + 1 });
        }
      },
    });
    const onScroll = () => pathRef.current && docs.setScroll(pathRef.current, view.scrollDOM.scrollTop);
    view.scrollDOM.addEventListener("scroll", onScroll, { passive: true });
    viewRef.current = view;
    onView?.(view);
    return () => {
      view.scrollDOM.removeEventListener("scroll", onScroll);
      view.destroy();
      activeEditor.view = null;
      activeEditor.path = null;
      useLive.getState().clear();
      viewRef.current = null;
      pathRef.current = null;
      onView?.(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docs]);

  // Load / switch the document shown in the view.
  useEffect(() => {
    if (!docs) return;
    let cancelled = false;
    setError(null);
    docs
      .load(path)
      .then((state) => {
        const view = viewRef.current;
        if (cancelled || !view) return;
        pathRef.current = path;
        // States of hidden docs may hold stale prefs; refresh before showing.
        view.setState(state);
        activeEditor.view = view;
        activeEditor.path = path;
        applyToView(view, path);
        updateOutline(path, state.doc);
        view.dispatch({ effects: prefsCompartment.reconfigure(prefsExtension(usePrefs.getState())) });
        const top = docs.getScroll(path);
        requestAnimationFrame(() => {
          view.scrollDOM.scrollTop = top;
        });
        const head = view.state.selection.main.head;
        const line = view.state.doc.lineAt(head);
        setCursor({ line: line.number, col: head - line.from + 1 });
        setLoadedPath(path);
        view.focus();
      })
      .catch((err) => !cancelled && setError(errorMessage(err)));
    return () => {
      cancelled = true;
    };
  }, [docs, path, setCursor, reloadNonce]);

  // Preference changes reconfigure the visible view (others refresh on show).
  useEffect(() => {
    const view = viewRef.current;
    if (!view || !loadedPath) return;
    view.dispatch({ effects: prefsCompartment.reconfigure(prefsExtension({ fontSize, lineWrap, keymap: keymapPref })) });
  }, [fontSize, lineWrap, keymapPref, loadedPath]);

  // Jump requests (outline, problems, SyncTeX).
  useEffect(() => {
    const view = viewRef.current;
    if (!view || !goto || goto.path !== loadedPath || goto.nonce === lastGoto.current) return;
    lastGoto.current = goto.nonce;
    const doc = view.state.doc;
    const line = doc.line(Math.max(1, Math.min(goto.line, doc.lines)));
    const pos = Math.min(line.from + Math.max(0, (goto.col ?? 1) - 1), line.to);
    view.dispatch({
      selection: EditorSelection.cursor(pos),
      effects: [EditorView.scrollIntoView(pos, { y: "center" }), ...(goto.flash ? [flashLine.of(pos)] : [])],
    });
    view.focus();
    if (goto.flash) {
      window.setTimeout(() => viewRef.current?.dispatch({ effects: flashLine.of(null) }), 1500);
    }
    // One-shot: a remounted editor (layout switch) must not replay it.
    useEditor.setState({ goto: null });
  }, [goto, loadedPath]);

  return (
    <div className="editor-host">
      <div ref={hostRef} style={{ height: "100%" }} />
      {error && (
        <div className="editor-placeholder" style={{ position: "absolute", inset: 0, background: "var(--bg)" }}>
          Não foi possível abrir {path}: {error}
        </div>
      )}
    </div>
  );
}
