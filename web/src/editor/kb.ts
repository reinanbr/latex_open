// Glue between the LaTeX knowledge base and the editor: loads it on demand
// (a separate chunk), computes what the current project has in scope (class,
// packages, its own definitions) and adds a \usepackage to the main file.
import type { EditorView } from "@codemirror/view";
import { LatexKB, packageInsertion, scanSource, type KBData, type Scope, type SourceFacts } from "../lib/latexKB";
import { useEditor } from "../store/editor";
import { toast } from "../store/ui";
import { projectData } from "./completion";
// A hashed asset fetched on demand (not parsed by TypeScript nor bundled in the JS).
import kbUrl from "../data/latex-kb.json?url";

let kb: LatexKB | null = null;
let loading: Promise<LatexKB | null> | null = null;
let failed = false;
const listeners = new Set<() => void>();

/** Called once when the knowledge base becomes available. */
export function onKBLoaded(fn: () => void) {
  listeners.add(fn);
}

/** The knowledge base, or null while it loads (the load starts on first call). */
export function getKB(): LatexKB | null {
  if (!kb && !loading && !failed) {
    loading = fetch(kbUrl)
      .then((r) => {
        if (!r.ok) throw new Error(String(r.status));
        return r.json() as Promise<KBData>;
      })
      .then((data) => {
        kb = new LatexKB(data);
        for (const fn of listeners) fn();
        return kb;
      })
      .catch(() => {
        failed = true;
        return null;
      });
  }
  return kb;
}

export function loadKB(): Promise<LatexKB | null> {
  getKB();
  return loading ?? Promise.resolve(kb);
}

/** Packages added from a quick fix, before the index catches up. */
const pending = new Set<string>();

export function resetKBProject() {
  pending.clear();
  scopeCache = null;
}

/** Classes that only forward to another document's class. */
const FORWARDING_CLASSES = new Set(["subfiles"]);

export interface ProjectScope {
  kb: LatexKB;
  scope: Scope;
  classes: string[];
  commands: Set<string>;
  envs: Set<string>;
  verbatimEnvs: Set<string>;
  /** Why commands cannot be checked (unknown package, dynamic definitions…). */
  incomplete: string | null;
}

let scopeCache: { key: string; scope: Scope } | null = null;

/**
 * Everything defined for a file of the project: the knowledge base entries
 * of the classes and packages used anywhere in it, plus the definitions of
 * the other files (index) and of this file's live text. Null until both the
 * knowledge base and the index are loaded.
 */
export function projectScope(path: string, live: SourceFacts): ProjectScope | null {
  const k = getKB();
  const { index, files } = projectData();
  if (!k || !index || !files) return null;
  const local = new Set(files.filter((f) => /\.(sty|cls)$/i.test(f)).map((f) => f.replace(/^.*\//, "").replace(/\.(sty|cls)$/i, "")));
  const others = <T extends { file: string }>(list: T[] | undefined) => (list ?? []).filter((u) => u.file !== path);
  for (const p of pending) if ((index.packages ?? []).some((u) => u.name === p)) pending.delete(p);
  const classes = [...new Set([...others(index.classes).map((u) => u.name), ...live.classes])].filter((c) => !FORWARDING_CLASSES.has(c) && !local.has(c));
  const packages = [...new Set([...others(index.packages).map((u) => u.name), ...live.packages, ...pending])].filter((p) => !local.has(p));
  const key = classes.slice().sort().join(",") + "|" + packages.slice().sort().join(",");
  if (scopeCache?.key !== key) scopeCache = { key, scope: k.scope(classes, packages) };
  const scope = scopeCache.scope;

  const commands = new Set<string>([...index.macros.map((m) => m.name), ...live.commands]);
  const envs = new Set<string>([...(index.environments ?? []), ...live.envs]);
  const verbatimEnvs = new Set<string>([...(index.verbatimEnvironments ?? []), ...live.verbatimEnvs]);
  let incomplete: string | null = null;
  const hasLocalClass = [...others(index.classes), ...live.classes.map((name) => ({ name }))].some((u) => local.has(u.name));
  if (scope.unknown.length) incomplete = `pacote ou classe fora da base de conhecimento: ${scope.unknown.slice(0, 3).join(", ")}`;
  else if (classes.length === 0 && !hasLocalClass) incomplete = "o projeto não tem \\documentclass";
  else if (hasLocalClass) incomplete = "o projeto usa uma classe própria (.cls)";
  else if (index.dynamic || live.dynamic) incomplete = "o projeto define comandos com nomes montados (\\csname)";
  return { kb: k, scope, classes, commands, envs, verbatimEnvs, incomplete };
}

/** Facts of a live text, memoized on the text itself. */
let factsCache: { text: string; facts: SourceFacts } | null = null;
export function liveFacts(text: string): SourceFacts {
  if (factsCache?.text !== text) factsCache = { text, facts: scanSource(text) };
  return factsCache.facts;
}

// ------------------------------------------------- adding a \usepackage

/** File with the preamble: the one with \documentclass, else the main file. */
function preambleFile(): string | null {
  const { index } = projectData();
  const main = projectData().mainFile;
  const withClass = (index?.classes ?? []).filter((u) => !FORWARDING_CLASSES.has(u.name)).map((u) => u.file);
  if (main && withClass.includes(main)) return main;
  return withClass[0] ?? main ?? null;
}

/**
 * Adds \usepackage{name} to the preamble (in the open editor when the
 * preamble is there, otherwise in the stored document, which is then saved).
 */
export async function addPackage(name: string, view: EditorView | null, viewPath: string | null): Promise<boolean> {
  let target = preambleFile();
  if (view && /\\begin\s*\{document\}/.test(view.state.doc.toString()) && /\\documentclass/.test(view.state.doc.toString())) target = viewPath;
  if (!target) {
    toast("error", `Não encontrei o preâmbulo (\\documentclass) para adicionar \\usepackage{${name}}.`);
    return false;
  }
  if (view && target === viewPath) {
    const at = packageInsertion(view.state.doc.toString(), name);
    if (!at) return false;
    view.dispatch({ changes: { from: at.from, insert: at.insert }, userEvent: "input.package" });
  } else {
    const docs = useEditor.getState().docs;
    if (!docs) return false;
    try {
      const state = await docs.load(target);
      const at = packageInsertion(state.doc.toString(), name);
      if (!at) return false;
      docs.change(target, { from: at.from, insert: at.insert });
    } catch {
      toast("error", `Não foi possível abrir ${target}.`);
      return false;
    }
  }
  pending.add(name);
  toast("success", `\\usepackage{${name}} adicionado em ${target}`);
  return true;
}
