import { StateEffect, type EditorState, type Extension } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { lintGutter, linter, type Action, type Diagnostic } from "@codemirror/lint";
import type { Problem } from "../api/types";
import { scanLatex } from "../lib/syntaxCheck";
import { checkReferences } from "../lib/liveWarnings";
import { checkCommands, type CommandWarning } from "../lib/commandCheck";
import { hintFor } from "../lib/errorHints";
import { usePrefs } from "../store/prefs";
import { useLive, type LiveIssue } from "../store/live";
import { compileMarks, compileStarted, setCompileProblems, type CompileMark } from "./compileMarks";
import { CITE, REF, COMMON_COMMANDS, completionKB, projectData } from "./completion";
import { addPackage, liveFacts, onKBLoaded, projectScope } from "./kb";

/** The view currently showing a document (set by CodeEditor). */
export const activeEditor: { view: EditorView | null; path: string | null } = { view: null, path: null };

/** Set by the compile store (avoids an import cycle). */
export const diagnosticHooks: { showInLogs: (p: Problem) => void } = { showInLogs: () => {} };

let current: { buildId: string; byFile: Map<string, Problem[]> } = { buildId: "", byFile: new Map() };
const applied = new Map<string, string>(); // path -> buildId applied

export function setProblems(buildId: string, problems: Problem[]) {
  const byFile = new Map<string, Problem[]>();
  for (const p of problems) {
    if (!p.file || !p.line) continue;
    const list = byFile.get(p.file) ?? [];
    list.push(p);
    byFile.set(p.file, list);
  }
  current = { buildId, byFile };
}

/** Effect to dispatch on every open doc right before saving for a compile. */
export const compileStartEffect = () => compileStarted.of(null);

/** Apply the current problems to the visible view if not yet applied. */
export function applyToView(view: EditorView, path: string) {
  if (applied.get(path) === current.buildId) return;
  applied.set(path, current.buildId);
  view.dispatch({ effects: setCompileProblems.of(current.byFile.get(path) ?? []) });
}

/** Apply the current problems to a stored (hidden) state. */
export function applyToState(state: EditorState, path: string): EditorState {
  applied.set(path, current.buildId);
  return state.update({ effects: setCompileProblems.of(current.byFile.get(path) ?? []) }).state;
}

export function resetApplied() {
  applied.clear();
}

/** Asks the linter to run again (new preferences or project data). */
const refreshLint = StateEffect.define<null>();

/** Re-run the checks of the visible editor. */
export function relint() {
  activeEditor.view?.dispatch({ effects: refreshLint.of(null) });
}

onKBLoaded(relint);

completionKB.get = () => {
  const { view, path } = activeEditor;
  if (!view || !path) return null;
  const ps = projectScope(path, liveFacts(view.state.doc.toString()));
  if (!ps) return null;
  return { kb: ps.kb, scope: ps.scope, addPackage: (name, v) => void addPackage(name, v, path).then((ok) => ok && relint()) };
};

// ------------------------------------------------------------ pop-up boxes

const KIND_LABEL: Record<Problem["level"], string> = {
  error: "Erro de compilação",
  warning: "Aviso de compilação",
  typesetting: "Tipografia",
};

function card(kind: string, cls: string, message: string, where?: string, note?: string): () => Node {
  return () => {
    const box = document.createElement("div");
    box.className = `diag-card ${cls}`;
    const head = box.appendChild(document.createElement("div"));
    head.className = "diag-head";
    head.appendChild(document.createElement("span")).textContent = kind;
    if (where) {
      const loc = head.appendChild(document.createElement("span"));
      loc.className = "diag-loc";
      loc.textContent = where;
    }
    const msg = box.appendChild(document.createElement("div"));
    msg.className = "diag-msg";
    msg.textContent = message;
    const hint = hintFor(message);
    if (hint) {
      const h = box.appendChild(document.createElement("div"));
      h.className = "diag-hint";
      h.textContent = hint;
    }
    if (note) {
      const n = box.appendChild(document.createElement("div"));
      n.className = "diag-note";
      n.textContent = note;
    }
    return box;
  };
}

function compileDiagnostic(m: CompileMark): Diagnostic {
  const p = m.problem;
  const actions: Action[] = [{ name: "Ver no log", apply: () => diagnosticHooks.showInLogs(p) }];
  return {
    from: m.from,
    to: m.to,
    severity: p.level === "error" ? "error" : p.level === "warning" ? "warning" : "info",
    message: p.message,
    markClass: m.stale ? "cm-staleCompile" : undefined,
    renderMessage: card(
      KIND_LABEL[p.level],
      p.level,
      p.message,
      p.file && p.line ? `${p.file}:${p.line}` : undefined,
      m.stale ? "Esta linha foi editada depois da compilação; o aviso some ou se confirma na próxima." : undefined,
    ),
    actions,
  };
}

const TEX_FILE = /\.(tex|ltx|latex)$/i;
const REF_SET = new Set(REF);
const CITE_SET = new Set(CITE);

function commandDiagnostic(w: CommandWarning, path: string): Diagnostic {
  const pkg = w.fixes.find((f) => f.fix.kind === "package");
  const actions: Action[] = w.fixes.map(({ label, fix }) => ({
    name: label,
    apply: (view: EditorView, from: number, to: number) => {
      // Keep typing where you were after clicking the fix.
      if (fix.kind === "package") void addPackage(fix.name, view, path).then((ok) => (view.focus(), ok && relint()));
      // The diagnostic's range follows the edits made since: \name or {name}.
      else view.dispatch({ changes: { from: view.state.sliceDoc(from, from + 1) === "\\" ? from + 1 : from, to, insert: fix.text }, userEvent: "input.complete" });
      view.focus();
    },
  }));
  return {
    from: w.from,
    to: w.to,
    severity: "warning",
    message: w.message,
    markClass: "cm-commandWarning",
    renderMessage: card(pkg ? "Pacote não carregado" : "Comando desconhecido", "live-warning", w.message),
    actions,
  };
}

const COMMON = new Set<string>(COMMON_COMMANDS);

/** Live checks (no compilation) of one LaTeX source. */
function liveChecks(view: EditorView, path: string): Diagnostic[] {
  const text = view.state.doc.toString();
  const out: Diagnostic[] = [];
  const facts = liveFacts(text);
  const ps = projectScope(path, facts);
  const scan = scanLatex(text, { verbatimEnvs: ps?.verbatimEnvs ?? facts.verbatimEnvs });
  for (const issue of scan.issues) {
    out.push({
      from: issue.from,
      to: issue.to,
      severity: "error",
      message: issue.message,
      markClass: "cm-syntaxIssue",
      renderMessage: card("Verificação de sintaxe", "syntax", issue.message),
    });
  }
  const { index, files } = projectData();
  const warnings = checkReferences(text, REF_SET, CITE_SET, {
    labelsElsewhere: index ? new Set(index.labels.filter((l) => l.file !== path).map((l) => l.key)) : null,
    citations: index ? new Set(index.citations.map((c) => c.key)) : null,
    files,
  });
  for (const w of warnings) {
    out.push({
      from: w.from,
      to: w.to,
      severity: "warning",
      message: w.message,
      markClass: "cm-liveWarning",
      renderMessage: card("Aviso (ao vivo)", "live-warning", w.message),
    });
  }
  commandNote = ps ? ps.incomplete : "carregando a base de comandos…";
  if (ps && !ps.incomplete) {
    const warnings = checkCommands(scan.uses, {
      kb: ps.kb,
      scope: ps.scope,
      commands: ps.commands,
      envs: ps.envs,
      classes: ps.classes,
      preferred: COMMON,
      cursor: view.hasFocus ? view.state.selection.main.head : undefined,
    });
    for (const w of warnings) out.push(commandDiagnostic(w, path));
  }
  return out.sort((a, b) => a.from - b.from);
}

/** Why the command check is off for the visible file (null = on). */
let commandNote: string | null = null;

function publishLive(view: EditorView, path: string, live: Diagnostic[]) {
  if (activeEditor.view !== view) return;
  const doc = view.state.doc;
  const issues: LiveIssue[] = live.map((d) => {
    const line = doc.lineAt(d.from);
    return {
      line: line.number,
      col: d.from - line.from + 1,
      message: d.message,
      severity: d.severity === "error" ? "error" : "warning",
      kind: d.markClass === "cm-syntaxIssue" ? "syntax" : d.markClass === "cm-commandWarning" ? "command" : "reference",
    };
  });
  useLive.getState().publish(path, issues, commandNote);
}

/**
 * Markers, underlines and hover boxes for one document: problems from the
 * last compilation (kept in place while typing) plus the live checks of
 * LaTeX sources, refreshed on every pause in typing.
 */
export function diagnosticsExtension(path: string): Extension {
  const isTeX = TEX_FILE.test(path);
  return [
    compileMarks,
    linter(
      (view) => {
        const out = view.state.field(compileMarks).marks.map(compileDiagnostic);
        const live = isTeX && usePrefs.getState().syntaxCheck ? liveChecks(view, path) : [];
        publishLive(view, path, live);
        return out.concat(live);
      },
      {
        delay: 400,
        // Without an edit, lint again when the compile problems, the
        // preferences or the project data change.
        needsRefresh: (u) =>
          u.transactions.some((tr) => tr.effects.some((e) => e.is(setCompileProblems) || e.is(refreshLint))),
      },
    ),
    lintGutter({ hoverTime: 120 }),
  ];
}
