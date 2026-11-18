import { Compartment, EditorSelection, Prec, RangeSetBuilder, StateEffect, StateField, type EditorState, type Extension, type Text } from "@codemirror/state";
import {
  Decoration,
  EditorView,
  ViewPlugin,
  crosshairCursor,
  drawSelection,
  dropCursor,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  rectangularSelection,
  type DecorationSet,
  type ViewUpdate,
  type KeyBinding,
} from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab, toggleComment } from "@codemirror/commands";
import {
  HighlightStyle,
  bracketMatching,
  foldGutter,
  foldKeymap,
  foldService,
  indentOnInput,
  indentUnit,
  syntaxHighlighting,
} from "@codemirror/language";
import { highlightSelectionMatches, openSearchPanel, search, searchKeymap } from "@codemirror/search";
import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap } from "@codemirror/autocomplete";
import { lintKeymap } from "@codemirror/lint";
import { diagnosticsExtension } from "./diagnostics";
import { tags as t } from "@lezer/highlight";
import { vim } from "@replit/codemirror-vim";
import { bibtexLanguage, latexLanguage } from "./languages";
import { latexCompletionSource } from "./completion";
import { matchEnvironments, parseSections, scanEnvTokens, sectionFoldRange, type EnvPair } from "../lib/latexStructure";
import type { Prefs } from "../store/prefs";
import { extname } from "../lib/format";

// ------------------------------------------------------------------ theme

const highlight = HighlightStyle.define([
  { tag: t.comment, color: "var(--hl-comment)", fontStyle: "italic" },
  { tag: t.keyword, color: "var(--hl-keyword)", fontWeight: "600" },
  { tag: t.tagName, color: "var(--hl-command)" },
  { tag: t.special(t.tagName), color: "var(--hl-math-cmd)" },
  { tag: t.typeName, color: "var(--hl-env)" },
  { tag: t.heading, color: "var(--hl-heading)", fontWeight: "700" },
  { tag: t.labelName, color: "var(--hl-label)" },
  { tag: t.processingInstruction, color: "var(--hl-math-delim)", fontWeight: "600" },
  { tag: t.special(t.string), color: "var(--hl-math)" },
  { tag: t.number, color: "var(--hl-number)" },
  { tag: t.escape, color: "var(--hl-escape)" },
  { tag: t.monospace, color: "var(--hl-verbatim)" },
  { tag: t.attributeValue, color: "var(--hl-optarg)" },
  { tag: [t.brace, t.squareBracket], color: "var(--hl-brace)" },
  { tag: t.operator, color: "var(--hl-operator)" },
  { tag: t.string, color: "var(--hl-string)" },
  { tag: t.propertyName, color: "var(--hl-command)" },
  { tag: t.variableName, color: "var(--hl-label)" },
]);

const baseTheme = EditorView.theme({
  "&": { height: "100%", backgroundColor: "var(--bg)", color: "var(--text)" },
  ".cm-scroller": { fontFamily: "var(--font-mono)", lineHeight: "1.55" },
  ".cm-content": { caretColor: "var(--text)", paddingBottom: "40vh" },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--text)", borderLeftWidth: "2px" },
  ".cm-gutters": { backgroundColor: "var(--bg-subtle)", color: "var(--text-faint)", borderRight: "1px solid var(--border)" },
  ".cm-activeLineGutter": { backgroundColor: "var(--bg-muted)", color: "var(--text-muted)" },
  ".cm-activeLine": { backgroundColor: "var(--editor-active-line)" },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection": { backgroundColor: "var(--editor-selection) !important" },
  ".cm-selectionMatch": { backgroundColor: "var(--editor-selection-match)" },
  "&.cm-focused .cm-matchingBracket": { backgroundColor: "var(--editor-bracket)", outline: "1px solid var(--border-strong)" },
  "&.cm-focused .cm-nonmatchingBracket": { backgroundColor: "var(--danger-bg)", color: "var(--danger)" },
  ".cm-envMatch": { backgroundColor: "var(--editor-bracket)", borderRadius: "2px", outline: "1px solid var(--border-strong)" },
  ".cm-envNoMatch": { backgroundColor: "var(--danger-bg)", textDecoration: "underline wavy var(--danger)" },
  ".cm-foldGutter .cm-gutterElement": { cursor: "pointer", padding: "0 4px", color: "var(--text-faint)" },
  ".cm-foldPlaceholder": { backgroundColor: "var(--bg-muted)", border: "1px solid var(--border)", color: "var(--text-muted)", padding: "0 6px", borderRadius: "4px" },
  ".cm-panels": { backgroundColor: "var(--bg-subtle)", color: "var(--text)" },
  ".cm-panels-top": { borderBottom: "1px solid var(--border)" },
  ".cm-panels-bottom": { borderTop: "1px solid var(--border)" },
  ".cm-search": { fontFamily: "var(--font-ui)", fontSize: "13px", padding: "6px 8px" },
  ".cm-search input, .cm-search button": { fontSize: "13px" },
  ".cm-textfield": { backgroundColor: "var(--bg)", border: "1px solid var(--border-strong)", borderRadius: "4px", color: "var(--text)", padding: "3px 6px" },
  ".cm-button": { backgroundImage: "none", backgroundColor: "var(--bg)", border: "1px solid var(--border-strong)", borderRadius: "4px", color: "var(--text)", padding: "2px 8px" },
  ".cm-searchMatch": { backgroundColor: "var(--editor-search)", outline: "1px solid var(--warning)" },
  ".cm-searchMatch-selected": { backgroundColor: "var(--editor-search-current)" },
  ".cm-tooltip": { backgroundColor: "var(--bg)", border: "1px solid var(--border)", borderRadius: "6px", boxShadow: "var(--shadow)", color: "var(--text)" },
  ".cm-tooltip-autocomplete > ul": { fontFamily: "var(--font-mono)", fontSize: "13px", maxHeight: "18em" },
  ".cm-tooltip-autocomplete > ul > li[aria-selected]": { backgroundColor: "var(--accent)", color: "#fff" },
  ".cm-completionDetail": { color: "var(--text-faint)", fontStyle: "normal", marginLeft: "1em" },
  ".cm-completionInfo": { fontFamily: "var(--font-ui)", maxWidth: "320px", padding: "6px 8px" },
  ".cm-diagnostic": { fontFamily: "var(--font-ui)", fontSize: "13px" },
  ".cm-lintRange-error": { backgroundImage: "none", textDecoration: "underline wavy var(--danger)", textUnderlineOffset: "3px" },
  ".cm-lintRange-warning": { backgroundImage: "none", textDecoration: "underline wavy var(--warning)", textUnderlineOffset: "3px" },
  ".cm-lintRange-info": { backgroundImage: "none", textDecoration: "underline dotted var(--typeset)", textUnderlineOffset: "3px" },
  ".cm-lint-marker": { width: "0.9em", height: "0.9em" },
  // Pop-up boxes for problems (hover on the underline or the gutter marker).
  ".cm-tooltip.cm-tooltip-lint": {
    backgroundColor: "transparent",
    border: "none",
    padding: "0",
    maxWidth: "min(460px, 90vw)",
  },
  ".cm-tooltip-lint ul": { display: "flex", flexDirection: "column", gap: "6px" },
  ".cm-tooltip-lint .cm-diagnostic": {
    padding: "0",
    margin: "0",
    borderLeft: "none",
    whiteSpace: "normal",
    backgroundColor: "var(--bg-elevated, var(--bg))",
    color: "var(--text)",
    border: "1px solid var(--border)",
    borderTop: "3px solid var(--info, var(--accent))",
    borderRadius: "8px",
    boxShadow: "var(--shadow-lg, 0 8px 24px rgba(0,0,0,.18))",
    overflow: "hidden",
    font: "13px/1.45 var(--font-ui, system-ui, sans-serif)",
  },
  ".cm-tooltip-lint .cm-diagnostic-error": { borderTopColor: "var(--danger)" },
  ".cm-tooltip-lint .cm-diagnostic-warning": { borderTopColor: "var(--warning)" },
  ".cm-tooltip-lint .cm-diagnostic-info": { borderTopColor: "var(--typeset)" },
  ".cm-diagnostic .diag-card": { padding: "8px 12px 6px" },
  ".cm-diagnostic .diag-head": { display: "flex", gap: "8px", alignItems: "baseline", fontSize: "11.5px", fontWeight: "700", textTransform: "uppercase", letterSpacing: ".03em", color: "var(--text-muted)", marginBottom: "3px" },
  ".cm-diagnostic-error .diag-head": { color: "var(--danger)" },
  ".cm-diagnostic-warning .diag-head": { color: "var(--warning)" },
  ".cm-diagnostic .diag-loc": { marginLeft: "auto", fontFamily: "var(--font-mono)", fontWeight: "400", textTransform: "none", letterSpacing: "0", color: "var(--text-faint)" },
  ".cm-diagnostic .diag-msg": { overflowWrap: "anywhere" },
  ".cm-diagnostic .diag-note": { marginTop: "6px", fontSize: "12px", fontStyle: "italic", color: "var(--text-faint)" },
  ".cm-tooltip-lint .diag-card.live-warning .diag-head": { color: "var(--warning)" },
  ".cm-staleCompile": { opacity: "0.55" },
  ".cm-lintRange-error.cm-staleCompile, .cm-lintRange-warning.cm-staleCompile": { textDecorationStyle: "dotted" },
  ".cm-diagnostic .diag-hint": { marginTop: "6px", padding: "6px 8px", borderRadius: "6px", backgroundColor: "var(--bg-subtle)", color: "var(--text-muted)", fontSize: "12.5px" },
  ".cm-diagnostic .cm-diagnosticAction": {
    margin: "0 12px 8px",
    padding: "2px 10px",
    borderRadius: "6px",
    border: "1px solid var(--border-strong, var(--border))",
    backgroundColor: "var(--bg)",
    color: "var(--text)",
    font: "inherit",
    fontSize: "12.5px",
    cursor: "pointer",
  },
  ".cm-diagnostic .cm-diagnosticAction:hover": { backgroundColor: "var(--bg-hover)" },
  ".cm-panel.cm-panel-lint ul [aria-selected]": { backgroundColor: "var(--editor-selection)" },
  ".cm-gutter-lint": { width: "1.1em" },
  ".cm-syncHighlight": { backgroundColor: "var(--sync-highlight)", transition: "background-color 1.2s" },
  ".cm-vim-panel": { fontFamily: "var(--font-mono)", padding: "2px 6px" },
});

// --------------------------------------------------------- structure cache

interface Structure {
  pairs: EnvPair[];
  pairsByBeginLine: Map<number, EnvPair>;
  sectionFolds: Map<number, number>; // start line -> end line
}

const structureCache = new WeakMap<Text, Structure>();

/** Environments and section ranges for a document (cached per immutable doc). */
export function structureOf(doc: Text): Structure {
  let s = structureCache.get(doc);
  if (s) return s;
  const text = doc.toString();
  const { pairs } = matchEnvironments(scanEnvTokens(text));
  const pairsByBeginLine = new Map<number, EnvPair>();
  for (const p of pairs) {
    if (p.end && p.end.line > p.begin.line && !pairsByBeginLine.has(p.begin.line)) pairsByBeginLine.set(p.begin.line, p);
  }
  const lines = text.split("\n");
  const sections = parseSections(text);
  const sectionFolds = new Map<number, number>();
  sections.forEach((_, i) => {
    const r = sectionFoldRange(sections, i, lines);
    if (r) sectionFolds.set(r.startLine, r.endLine);
  });
  s = { pairs, pairsByBeginLine, sectionFolds };
  structureCache.set(doc, s);
  return s;
}

const latexFolding = foldService.of((state: EditorState, lineStart: number) => {
  const line = state.doc.lineAt(lineStart);
  // Fast reject: only lines with a backslash can start a fold.
  if (!line.text.includes("\\")) return null;
  const st = structureOf(state.doc);
  const pair = st.pairsByBeginLine.get(line.number);
  if (pair?.end) {
    const endLine = state.doc.line(pair.end.line);
    // Fold from the end of the \begin line to just before \end on its line.
    return endLine.number > line.number ? { from: line.to, to: pair.end.from } : null;
  }
  const secEnd = st.sectionFolds.get(line.number);
  if (secEnd) {
    return { from: line.to, to: state.doc.line(secEnd).to };
  }
  return null;
});

// ------------------------------------------------ \begin / \end matching

const envMatchMark = Decoration.mark({ class: "cm-envMatch" });
const envNoMatchMark = Decoration.mark({ class: "cm-envNoMatch" });

const envMatcher = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet = Decoration.none;
    constructor(view: EditorView) {
      this.decorations = this.compute(view);
    }
    update(u: ViewUpdate) {
      if (u.docChanged || u.selectionSet || u.focusChanged) this.decorations = this.compute(u.view);
    }
    compute(view: EditorView): DecorationSet {
      const sel = view.state.selection.main;
      if (!sel.empty || !view.hasFocus) return Decoration.none;
      const pos = sel.head;
      const line = view.state.doc.lineAt(pos);
      if (!/\\(begin|end)/.test(line.text)) return Decoration.none;
      const st = structureOf(view.state.doc);
      for (const p of st.pairs) {
        const onBegin = pos >= p.begin.from && pos <= p.begin.to;
        const onEnd = p.end !== null && pos >= p.end.from && pos <= p.end.to;
        if (!onBegin && !onEnd) continue;
        const b = new RangeSetBuilder<Decoration>();
        if (!p.end) {
          b.add(p.begin.from, p.begin.to, envNoMatchMark);
        } else {
          b.add(p.begin.from, p.begin.to, envMatchMark);
          b.add(p.end.from, p.end.to, envMatchMark);
        }
        return b.finish();
      }
      return Decoration.none;
    }
  },
  { decorations: (v) => v.decorations },
);

// ----------------------------------------------------------- commands

/** Wrap the selection in \cmd{...}; unwrap if it is already wrapped. */
export function wrapWith(cmd: string) {
  return (view: EditorView): boolean => {
    const open = `\\${cmd}{`;
    const tr = view.state.changeByRange((range) => {
      const doc = view.state.doc;
      const before = doc.sliceString(Math.max(0, range.from - open.length), range.from);
      const after = doc.sliceString(range.to, range.to + 1);
      if (before === open && after === "}") {
        return {
          changes: [
            { from: range.from - open.length, to: range.from, insert: "" },
            { from: range.to, to: range.to + 1, insert: "" },
          ],
          range: EditorSelection.range(range.from - open.length, range.to - open.length),
        };
      }
      return {
        changes: [
          { from: range.from, insert: open },
          { from: range.to, insert: "}" },
        ],
        range: EditorSelection.range(range.from + open.length, range.to + open.length),
      };
    });
    view.dispatch(view.state.update(tr, { scrollIntoView: true, userEvent: "input" }));
    return true;
  };
}

// ------------------------------------------------------------ factory

export const prefsCompartment = new Compartment();
export const languageCompartment = new Compartment();

export function prefsExtension(p: Pick<Prefs, "fontSize" | "lineWrap" | "keymap">): Extension {
  return [
    p.keymap === "vim" ? vim() : [],
    p.lineWrap ? EditorView.lineWrapping : [],
    EditorView.theme({ ".cm-scroller": { fontSize: `${p.fontSize}px` } }),
  ];
}

export function languageFor(path: string): Extension {
  const ext = extname(path);
  if (ext === "bib") return bibtexLanguage;
  if (["tex", "sty", "cls", "ltx", "dtx", "bbl", "tikz", "def", "clo"].includes(ext)) {
    return [latexLanguage, latexLanguage.data.of({ autocomplete: latexCompletionSource }), latexFolding, envMatcher];
  }
  return [];
}

export interface EditorHooks {
  /** Extra keybindings supplied by the page (save, compile, sync…). */
  keys: KeyBinding[];
  /** Extra extensions (autocomplete sources, update listeners…). */
  extra: Extension[];
}

/** Build the full extension set for one document. */
export function buildExtensions(path: string, prefs: Pick<Prefs, "fontSize" | "lineWrap" | "keymap">, hooks: EditorHooks): Extension[] {
  return [
    // Page-level shortcuts win over everything (including vim).
    Prec.highest(keymap.of(hooks.keys)),
    prefsCompartment.of(prefsExtension(prefs)),
    languageCompartment.of(languageFor(path)),
    lineNumbers(),
    highlightActiveLineGutter(),
    highlightSpecialChars(),
    history(),
    foldGutter({ openText: "▾", closedText: "▸" }),
    drawSelection(),
    dropCursor(),
    indentOnInput(),
    indentUnit.of("  "),
    syntaxHighlighting(highlight),
    bracketMatching(),
    closeBrackets(),
    autocompletion({ activateOnTyping: true, icons: false, maxRenderedOptions: 80 }),
    rectangularSelection(),
    crosshairCursor(),
    highlightActiveLine(),
    highlightSelectionMatches(),
    search({ top: true }),
    diagnosticsExtension(path),
    flashField,
    baseTheme,
    Prec.high(
      keymap.of([
        { key: "Mod-b", run: wrapWith("textbf") },
        { key: "Mod-i", run: wrapWith("textit") },
        { key: "Mod-/", run: toggleComment },
        { key: "Mod-h", run: openSearchPanel, preventDefault: true },
      ]),
    ),
    keymap.of([
      ...closeBracketsKeymap,
      ...defaultKeymap,
      ...searchKeymap,
      ...historyKeymap,
      ...foldKeymap,
      ...completionKeymap,
      ...lintKeymap,
      indentWithTab,
    ]),
    ...hooks.extra,
  ];
}

// ------------------------------------------------- temporary line flash

export const flashLine = StateEffect.define<number | null>();

/** Highlights one line (by position) until cleared; used by SyncTeX/goto. */
export const flashField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    deco = deco.map(tr.changes);
    for (const e of tr.effects) {
      if (e.is(flashLine)) {
        if (e.value === null) return Decoration.none;
        const line = tr.state.doc.lineAt(Math.min(e.value, tr.state.doc.length));
        return Decoration.set([Decoration.line({ class: "cm-syncHighlight" }).range(line.from)]);
      }
    }
    return deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});
