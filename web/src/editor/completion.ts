// LaTeX autocomplete: context detection and option building are pure
// functions (unit-tested); the CodeMirror source glues them to the editor.
import { insertCompletionText, snippet, type Completion, type CompletionContext, type CompletionResult } from "@codemirror/autocomplete";
import type { EditorView } from "@codemirror/view";
import { scanEnvTokens, stripComment } from "../lib/latexStructure";
import type { ProjectIndex } from "../api/types";
import { POPULAR_PACKAGES, specLabel, specSnippet, type LatexKB, type Scope } from "../lib/latexKB";

export type ArgKind = "ref" | "cite" | "graphics" | "input" | "bib" | "begin" | "end" | "package" | "class";

export type LatexContext =
  | { kind: ArgKind; command: string; from: number; prefix: string }
  | { kind: "command"; from: number; prefix: string };

export const REF = ["ref", "eqref", "cref", "Cref", "autoref", "pageref", "nameref", "vref", "Vref", "labelcref", "cpageref", "Cpageref", "fref", "Fref"];
export const CITE = [
  "cite", "citep", "citet", "citealp", "citealt", "citeauthor", "citeyear", "citeyearpar", "nocite",
  "parencite", "Parencite", "textcite", "Textcite", "autocite", "Autocite", "footcite", "fullcite",
  "smartcite", "supercite", "Cite", "citetitle", "cites", "parencites",
  // abntex2cite (ABNT)
  "citeonline", "citeauthoronline", "citeyearonline", "apud", "apudonline",
];
const KIND: Record<string, ArgKind> = {
  includegraphics: "graphics",
  input: "input",
  include: "input",
  subfile: "input",
  includeonly: "input",
  bibliography: "bib",
  addbibresource: "bib",
  begin: "begin",
  end: "end",
  usepackage: "package",
  RequirePackage: "package",
  documentclass: "class",
  LoadClass: "class",
};
for (const c of REF) KIND[c] = "ref";
for (const c of CITE) KIND[c] = "cite";

/** Arguments that take comma-separated lists. */
const LIST_KINDS = new Set<ArgKind>(["ref", "cite", "bib", "package"]);

// \cmd*[opt][opt]{partial   — the cursor sits inside the mandatory argument.
const ARG_RE = /\\([a-zA-Z]+)\*?\s*(?:\[[^\]]*\]\s*)*\{([^{}]*)$/;
const CMD_RE = /\\([a-zA-Z@]*)$/;

/**
 * Classify the text before the cursor (on the current line). `from` is the
 * offset in `lineBefore` where the replaced text starts.
 */
export function detectContext(lineBefore: string): LatexContext | null {
  // Inside a comment: nothing to complete.
  if (stripComment(lineBefore).length !== lineBefore.length) return null;
  const arg = ARG_RE.exec(lineBefore);
  if (arg) {
    const command = arg[1] ?? "";
    const kind = KIND[command];
    if (!kind) return null;
    let content = arg[2] ?? "";
    let from = lineBefore.length - content.length;
    if (LIST_KINDS.has(kind)) {
      const comma = content.lastIndexOf(",");
      if (comma >= 0) {
        from += comma + 1;
        content = content.slice(comma + 1);
      }
    }
    const lead = content.length - content.trimStart().length;
    return { kind, command, from: from + lead, prefix: content.slice(lead) };
  }
  const cmd = CMD_RE.exec(lineBefore);
  if (cmd) {
    const from = cmd.index;
    // "\\" is a line break, not the start of a command.
    let slashes = 0;
    for (let i = from - 1; i >= 0 && lineBefore[i] === "\\"; i--) slashes++;
    if (slashes % 2 === 1) return null;
    return { kind: "command", from, prefix: lineBefore.slice(from) };
  }
  return null;
}

/** Name of the innermost environment still open at the end of `text`. */
export function innermostOpenEnv(text: string): string | null {
  const stack: string[] = [];
  for (const t of scanEnvTokens(text)) {
    if (t.kind === "begin") stack.push(t.name);
    else {
      const i = stack.lastIndexOf(t.name);
      if (i >= 0) stack.length = i;
    }
  }
  return stack[stack.length - 1] ?? null;
}

// --------------------------------------------------------------- data

export interface CompletionData {
  index: ProjectIndex;
  /** All project files (relative paths). */
  files: string[];
  mainFile?: string;
}

let data: CompletionData = {
  index: { labels: [], citations: [], macros: [], environments: [] },
  files: [],
};

let loaded = { index: false, files: false };

export function setCompletionData(patch: Partial<CompletionData>, isLoaded = true) {
  data = { ...data, ...patch };
  if (patch.index) loaded = { ...loaded, index: isLoaded };
  if (patch.files) loaded = { ...loaded, files: isLoaded };
}

/** Project data for live checks; null parts are not loaded yet. */
export function projectData(): { index: CompletionData["index"] | null; files: string[] | null; mainFile: string | null } {
  return { index: loaded.index ? data.index : null, files: loaded.files ? data.files : null, mainFile: data.mainFile || null };
}

// ------------------------------------------------------ built-in lists

/** Common commands. `#{}` marks the fields of the inserted snippet. */
const COMMANDS: [string, string?][] = [
  ["section", "{#{}}"], ["section*", "{#{}}"], ["subsection", "{#{}}"], ["subsection*", "{#{}}"],
  ["subsubsection", "{#{}}"], ["chapter", "{#{}}"], ["chapter*", "{#{}}"], ["part", "{#{}}"],
  ["paragraph", "{#{}}"], ["subparagraph", "{#{}}"],
  ["label", "{#{}}"], ["ref", "{#{}}"], ["eqref", "{#{}}"], ["cref", "{#{}}"], ["Cref", "{#{}}"],
  ["autoref", "{#{}}"], ["pageref", "{#{}}"], ["cite", "{#{}}"], ["citep", "{#{}}"], ["citet", "{#{}}"],
  ["parencite", "{#{}}"], ["textcite", "{#{}}"], ["autocite", "{#{}}"], ["footcite", "{#{}}"],
  ["textbf", "{#{}}"], ["textit", "{#{}}"], ["emph", "{#{}}"], ["underline", "{#{}}"],
  ["texttt", "{#{}}"], ["textsc", "{#{}}"], ["textrm", "{#{}}"], ["textsf", "{#{}}"], ["textsuperscript", "{#{}}"],
  ["textsubscript", "{#{}}"], ["textcolor", "{#{}}{#{}}"], ["footnote", "{#{}}"], ["url", "{#{}}"],
  ["href", "{#{}}{#{}}"], ["caption", "{#{}}"], ["includegraphics", "[width=#{\\linewidth}]{#{}}"],
  ["input", "{#{}}"], ["include", "{#{}}"], ["usepackage", "{#{}}"], ["documentclass", "{#{}}"],
  ["bibliography", "{#{}}"], ["bibliographystyle", "{#{}}"], ["addbibresource", "{#{}}"], ["printbibliography"],
  ["begin", "{#{}}"], ["end", "{#{}}"], ["item"], ["maketitle"], ["tableofcontents"], ["listoffigures"],
  ["listoftables"], ["appendix"], ["title", "{#{}}"], ["author", "{#{}}"], ["date", "{#{}}"], ["today"],
  ["newcommand", "{#{}}{#{}}"], ["renewcommand", "{#{}}{#{}}"], ["newenvironment", "{#{}}{#{}}{#{}}"],
  ["frac", "{#{}}{#{}}"], ["dfrac", "{#{}}{#{}}"], ["sqrt", "{#{}}"], ["sum"], ["prod"], ["int"], ["oint"],
  ["lim"], ["infty"], ["partial"], ["nabla"], ["cdot"], ["cdots"], ["ldots"], ["dots"], ["times"], ["leq"], ["geq"],
  ["neq"], ["approx"], ["equiv"], ["in"], ["notin"], ["subset"], ["subseteq"], ["cup"], ["cap"], ["forall"],
  ["exists"], ["rightarrow"], ["leftarrow"], ["Rightarrow"], ["Leftrightarrow"], ["mapsto"], ["to"],
  ["alpha"], ["beta"], ["gamma"], ["delta"], ["epsilon"], ["varepsilon"], ["zeta"], ["eta"], ["theta"],
  ["lambda"], ["mu"], ["nu"], ["xi"], ["pi"], ["rho"], ["sigma"], ["tau"], ["phi"], ["varphi"], ["chi"],
  ["psi"], ["omega"], ["Gamma"], ["Delta"], ["Theta"], ["Lambda"], ["Pi"], ["Sigma"], ["Phi"], ["Psi"], ["Omega"],
  ["mathbb", "{#{}}"], ["mathcal", "{#{}}"], ["mathrm", "{#{}}"], ["mathbf", "{#{}}"], ["mathit", "{#{}}"],
  ["text", "{#{}}"], ["left"], ["right"], ["hat", "{#{}}"], ["bar", "{#{}}"], ["vec", "{#{}}"], ["tilde", "{#{}}"],
  ["overline", "{#{}}"], ["operatorname", "{#{}}"], ["quad"], ["qquad"], ["hspace", "{#{}}"], ["vspace", "{#{}}"],
  ["newline"], ["newpage"], ["clearpage"], ["noindent"], ["centering"], ["small"], ["footnotesize"],
  ["large"], ["Large"], ["LARGE"], ["huge"], ["hline"], ["toprule"], ["midrule"], ["bottomrule"],
  ["multicolumn", "{#{}}{#{}}{#{}}"], ["multirow", "{#{}}{#{}}{#{}}"], ["linewidth"], ["textwidth"],
  // abnTeX2 (trabalhos acadêmicos ABNT)
  ["citeonline", "{#{}}"], ["citeauthoronline", "{#{}}"], ["apud", "{#{}}{#{}}"], ["apudonline", "{#{}}{#{}}"],
  ["titulo", "{#{}}"], ["autor", "{#{}}"], ["orientador", "{#{}}"], ["coorientador", "{#{}}"],
  ["instituicao", "{#{}}"], ["tipotrabalho", "{#{}}"], ["preambulo", "{#{}}"], ["local", "{#{}}"],
  ["data", "{#{}}"], ["imprimircapa"], ["imprimirfolhaderosto"], ["imprimirfolhaderosto*"],
  ["pretextual"], ["textual"], ["postextual"], ["fonte", "{#{}}"], ["nota", "{#{}}"],
  ["listadeilustracoes"], ["listadetabelas"], ["sigla", "{#{}}{#{}}"], ["simbolo", "{#{}}{#{}}"],
];

/** Environments; the second element is the initial body. */
const ENVIRONMENTS: [string, string?][] = [
  ["document"], ["abstract"], ["itemize", "\\item "], ["enumerate", "\\item "], ["description", "\\item[#{}] "],
  ["figure", "\\centering\n\t\\includegraphics[width=\\linewidth]{#{}}\n\t\\caption{#{}}\n\t\\label{fig:#{}}"],
  ["figure*"], ["table", "\\centering\n\t\\caption{#{}}\n\t\\label{tab:#{}}\n\t"], ["table*"],
  ["tabular", ""], ["tabularx"], ["equation"], ["equation*"], ["align"], ["align*"], ["gather"], ["gather*"],
  ["multline"], ["split"], ["cases"], ["matrix"], ["pmatrix"], ["bmatrix"], ["vmatrix"], ["array"],
  ["center"], ["flushleft"], ["flushright"], ["quote"], ["quotation"], ["verse"], ["verbatim"], ["lstlisting"],
  ["minipage"], ["theorem"], ["lemma"], ["proof"], ["definition"], ["corollary"], ["proposition"], ["remark"],
  ["example"], ["thebibliography"], ["frame"], ["columns"], ["column"], ["block"], ["tikzpicture"], ["subfigure"],
  // abnTeX2
  ["resumo"], ["citacao"], ["epigrafe"], ["dedicatoria"], ["agradecimentos"], ["siglas", "\\item[#{}] "],
  ["simbolos", "\\item[#{}] "], ["fichacatalografica"], ["folhadeaprovacao"], ["errata"], ["apendicesenv"],
  ["anexosenv"],
];

/** Names of the built-in command list (preferred among typo suggestions). */
export const COMMON_COMMANDS: string[] = COMMANDS.map(([n]) => n.replace(/\*$/, ""));

const PACKAGES = [
  "amsmath", "amssymb", "amsthm", "mathtools", "graphicx", "xcolor", "hyperref", "cleveref", "geometry",
  "babel", "inputenc", "fontenc", "lmodern", "microtype", "booktabs", "tabularx", "multirow", "array",
  "longtable", "caption", "subcaption", "float", "enumitem", "listings", "minted", "tikz", "pgfplots",
  "siunitx", "biblatex", "natbib", "csquotes", "fontspec", "unicode-math", "polyglossia", "url", "xparse",
  "fancyhdr", "titlesec", "setspace", "parskip", "lipsum", "algorithm2e", "algorithmicx", "physics", "bm",
  "abntex2cite", "indentfirst", "lastpage", "chngcntr",
];

const IMAGE_EXT = /\.(png|jpe?g|pdf|eps|svg|gif|bmp|tiff?)$/i;

// ------------------------------------------------------------- options

type Apply = NonNullable<Completion["apply"]>;

/** Like snippet(), but swallows a "}" right after the cursor (auto-closed brace). */
function closingApply(template: string): Apply {
  const sn = snippet(template);
  return (view: EditorView, c: Completion, from: number, to: number) => {
    if (view.state.sliceDoc(to, to + 1) === "}") to++;
    sn(view, c, from, to);
  };
}

/** Inserts `name}`, replacing an auto-closed "}" after the cursor. */
function plainClosingApply(name: string): Apply {
  return (view: EditorView, _c: Completion, from: number, to: number) => {
    if (view.state.sliceDoc(to, to + 1) === "}") to++;
    view.dispatch({
      changes: { from, to, insert: name + "}" },
      selection: { anchor: from + name.length + 1 },
      userEvent: "input.complete",
    });
  };
}

const stripExt = (p: string, ext: RegExp) => p.replace(ext, "");

/** Knowledge base view for completion (null while it loads). */
export interface KBCompletion {
  kb: LatexKB;
  scope: Scope;
  /** Adds \usepackage{name} to the preamble (after a completion from a package not loaded). */
  addPackage: (name: string, view: EditorView) => void;
}

/** Set by the diagnostics module: the knowledge base scope of the visible file. */
export const completionKB: { get: () => KBCompletion | null } = { get: () => null };

/** Runs `apply` (or inserts the text), then loads the package it needs. */
function withPackage(apply: Apply | undefined, label: string, pkg: string): Apply {
  return (view, c, from, to) => {
    if (typeof apply === "function") apply(view, c, from, to);
    else view.dispatch(insertCompletionText(view.state, typeof apply === "string" ? apply : label, from, to));
    // Looked up now: cached options outlive the file they were built for.
    completionKB.get()?.addPackage(pkg, view);
  };
}

/** A snippet parsed only when the option is applied. */
function lazySnippet(template: string): Apply {
  let sn: ReturnType<typeof snippet> | null = null;
  return (view, c, from, to) => (sn ??= snippet(template))(view, c, from, to);
}

type Named = { name: string; option: Completion };
const kbCache = new WeakMap<Scope, { inScope: Named[]; missing: Named[] | null }>();

/** Commands of the knowledge base: those in scope, then common packages not loaded. */
function kbCommands(k: KBCompletion, seen: Set<string>, withMissing: boolean): Completion[] {
  let cached = kbCache.get(k.scope);
  if (!cached) {
    const inScope: Named[] = [];
    for (const [name, item] of k.scope.cmds) {
      if (name.length > 40) continue;
      const args = specSnippet(item.spec);
      inScope.push({
        name,
        option: {
          label: "\\" + name,
          type: "function",
          detail: item.source,
          info: item.spec ? specLabel(name, item.spec) : undefined,
          boost: -1,
          ...(args ? { apply: lazySnippet(`\\${name}${args}`) } : {}),
        },
      });
    }
    cached = { inScope, missing: null };
    kbCache.set(k.scope, cached);
  }
  if (withMissing && !cached.missing) {
    const missing: Named[] = [];
    const taken = new Set(k.scope.cmds.keys());
    for (const pkg of POPULAR_PACKAGES) {
      if (!k.kb.hasPackage(pkg) || k.scope.keys.has("p:" + pkg)) continue;
      for (const [name, spec] of k.kb.own("p:" + pkg).cmds) {
        // Long internal names (\pgfmathfloatifapproxequalrel) only add noise here.
        if (taken.has(name) || name.length > 22 || name.startsWith("pgf")) continue;
        taken.add(name);
        const args = specSnippet(spec);
        missing.push({
          name,
          option: {
            label: "\\" + name,
            type: "function",
            detail: `+ ${pkg}`,
            info: `${specLabel(name, spec)} — do pacote ${pkg} (adiciona \\usepackage{${pkg}})`,
            boost: -3,
            apply: withPackage(args ? lazySnippet(`\\${name}${args}`) : undefined, "\\" + name, pkg),
          },
        });
      }
    }
    cached.missing = missing;
  }
  const out: Completion[] = [];
  for (const n of cached.inScope) if (!seen.has(n.name)) out.push(n.option);
  if (withMissing) for (const n of cached.missing ?? []) if (!seen.has(n.name)) out.push(n.option);
  return out;
}

/** Package that would provide a built-in list entry missing from the scope. */
function missingPackage(name: string, kind: "command" | "env", k: KBCompletion | null): string | null {
  if (!k) return null;
  const has = kind === "command" ? k.scope.cmds.has(name) || k.scope.envs.has(name) : k.scope.envs.has(name) || k.scope.cmds.has(name);
  if (has) return null;
  const p = k.kb.provider(name, kind);
  return p && "package" in p ? p.package : null;
}

function envOption(name: string, body: string, k: KBCompletion | null, detail?: string, spec?: string | null): Completion {
  const args = specSnippet(spec ?? null) ?? "";
  // The cursor must end up in the body: add a field when the body has none.
  const apply = closingApply(`${name}}${args}\n\t${body.includes("#{") ? body : body + "#{}"}\n\\end{${name}}`);
  const pkg = missingPackage(name, "env", k);
  if (pkg && k) return { label: name, type: "type", detail: `+ ${pkg}`, boost: -2, apply: withPackage(apply, name, pkg) };
  return { label: name, type: "type", detail, apply };
}

/** Options for a detected context (labels are what the user sees). */
export function optionsFor(ctx: LatexContext, d: CompletionData, openEnv: string | null = null, k: KBCompletion | null = null, withMissing = true): Completion[] {
  switch (ctx.kind) {
    case "ref":
      return d.index.labels.map((l) => ({ label: l.key, type: "variable", detail: `${l.file}:${l.line}` }));
    case "cite":
      return d.index.citations.map((c) => ({
        label: c.key,
        type: "text",
        detail: c.year ?? "",
        info: [c.author, c.title].filter(Boolean).join(" — ") || undefined,
      }));
    case "graphics":
      return d.files.filter((f) => IMAGE_EXT.test(f)).map((f) => ({ label: f, type: "constant" }));
    case "input":
      return d.files.filter((f) => /\.tex$/i.test(f)).map((f) => ({ label: stripExt(f, /\.tex$/i), type: "constant", detail: f }));
    case "bib": {
      const keepExt = ctx.command === "addbibresource";
      return d.files
        .filter((f) => /\.bib$/i.test(f))
        .map((f) => ({ label: keepExt ? f : stripExt(f, /\.bib$/i), type: "constant" }));
    }
    case "package": {
      const loaded = new Set((d.index.packages ?? []).map((u) => u.name));
      const names = [...new Set([...POPULAR_PACKAGES, ...PACKAGES, ...(k?.kb.packageNames() ?? [])])];
      const popular = new Set([...POPULAR_PACKAGES, ...PACKAGES]);
      return names.map((p) => ({
        label: p,
        type: "namespace",
        boost: popular.has(p) ? 1 : 0,
        detail: loaded.has(p) ? "já carregado" : undefined,
      }));
    }
    case "class": {
      const common = ["article", "report", "book", "abntex2", "beamer", "memoir", "letter", "standalone", "scrartcl", "scrreprt", "scrbook", "amsart"];
      return [...new Set([...common, ...(k?.kb.classNames() ?? [])])].map((c) => ({ label: c, type: "class", boost: common.includes(c) ? 1 : 0 }));
    }
    case "begin": {
      const out: Completion[] = [];
      const seen = new Set<string>();
      for (const [n, body] of ENVIRONMENTS) {
        seen.add(n);
        out.push({ ...envOption(n, body ?? "", k, k?.scope.envs.get(n)?.source, k?.scope.envs.get(n)?.spec), boost: 1 });
      }
      for (const n of d.index.environments ?? []) {
        if (seen.has(n)) continue;
        seen.add(n);
        out.push(envOption(n, "", null, "projeto"));
      }
      if (k) {
        for (const [n, item] of k.scope.envs) {
          if (seen.has(n)) continue;
          seen.add(n);
          out.push({ ...envOption(n, "", null, item.source, item.spec), boost: -1 });
        }
        if (withMissing) {
          for (const pkg of POPULAR_PACKAGES) {
            if (!k.kb.hasPackage(pkg) || k.scope.keys.has("p:" + pkg)) continue;
            for (const [n, spec] of k.kb.own("p:" + pkg).envs) {
              if (seen.has(n)) continue;
              seen.add(n);
              const opt = envOption(n, "", null, undefined, spec);
              out.push({ ...opt, detail: `+ ${pkg}`, boost: -3, apply: withPackage(opt.apply, n, pkg) });
            }
          }
        }
      }
      return out;
    }
    case "end": {
      const names = new Set<string>(ENVIRONMENTS.map(([n]) => n));
      for (const n of d.index.environments ?? []) names.add(n);
      if (openEnv) names.add(openEnv);
      return [...names].map((name) => ({
        label: name,
        type: "type",
        boost: name === openEnv ? 99 : 0,
        detail: name === openEnv ? "aberto" : undefined,
        apply: plainClosingApply(name),
      }));
    }
    case "command": {
      const seen = new Set<string>();
      const out: Completion[] = [];
      for (const m of d.index.macros ?? []) {
        if (seen.has(m.name)) continue;
        seen.add(m.name);
        const args = "{#{}}".repeat(Math.min(m.args, 9));
        out.push({
          label: "\\" + m.name,
          type: "function",
          detail: m.file,
          boost: 1,
          ...(args ? { apply: snippet(`\\${m.name}${args}`) } : {}),
        });
      }
      for (const [name, args] of COMMANDS) {
        if (seen.has(name)) continue;
        seen.add(name);
        const base = name.replace(/\*$/, "");
        const apply = args ? snippet(`\\${name}${args}`) : undefined;
        const pkg = missingPackage(base, "command", k);
        if (pkg && k) {
          if (!withMissing) continue;
          out.push({ label: "\\" + name, type: "keyword", detail: `+ ${pkg}`, boost: -2, apply: withPackage(apply, "\\" + name, pkg) });
        } else {
          out.push({ label: "\\" + name, type: "keyword", detail: k?.scope.cmds.get(base)?.source, ...(apply ? { apply } : {}) });
        }
      }
      if (k) out.push(...kbCommands(k, seen, withMissing));
      return out;
    }
  }
}

// ---------------------------------------------------------- CM source

export function latexCompletionSource(cx: CompletionContext): CompletionResult | null {
  const line = cx.state.doc.lineAt(cx.pos);
  const ctx = detectContext(line.text.slice(0, cx.pos - line.from));
  if (!ctx) return null;
  // The partial "\end{xx" is not a complete token, so scanning up to the
  // cursor finds the environment it should close.
  const openEnv = ctx.kind === "end" ? innermostOpenEnv(cx.state.sliceDoc(0, cx.pos)) : null;
  // Commands of packages not loaded yet are offered from the 2nd letter on
  // (fewer distractions when just typing "\").
  const short = ctx.prefix.replace(/^\\/, "").length < 2;
  const options = optionsFor(ctx, data, openEnv, completionKB.get(), !short);
  if (options.length === 0) return null;
  return {
    from: line.from + ctx.from,
    options,
    validFor: short ? (ctx.kind === "command" ? /^\\[a-zA-Z@*]?$/ : /^[^{},\s]?$/) : ctx.kind === "command" ? /^\\[a-zA-Z@*]*$/ : /^[^{},\s]*$/,
  };
}
