/**
 * Live syntax check for LaTeX source, run in the browser while typing (no
 * compilation): unbalanced braces, \begin/\end that do not match, and math
 * delimiters ($, $$, \(, \[) left open.
 *
 * It only reports what is certainly wrong for TeX, to avoid false alarms:
 * comments, verbatim environments, \verb, \url and the bodies of macro
 * definitions (\newcommand{\x}{\begin{center}} is legitimate) are skipped,
 * and math is only checked in the document body (not in the preamble).
 */
import { VERBATIM_ENVS } from "./latexStructure";

export interface SyntaxIssue {
  from: number;
  to: number;
  message: string;
}

/** A command or environment used in typeset code (not in definitions, comments or verbatim). */
export interface LatexUse {
  kind: "command" | "env";
  name: string;
  /** For a command, the backslash; for an environment, its name inside \begin{…}. */
  from: number;
  to: number;
}

export interface ScanOptions {
  /** User-defined environments whose body is code (\lstnewenvironment…). */
  verbatimEnvs?: Iterable<string>;
}

export interface ScanResult {
  issues: SyntaxIssue[];
  uses: LatexUse[];
}

/** Commands whose arguments are code, not typeset text. */
const DEF_COMMANDS = new Set([
  "newcommand", "renewcommand", "providecommand", "DeclareRobustCommand", "def", "gdef", "edef", "xdef",
  "newenvironment", "renewenvironment", "NewDocumentCommand", "RenewDocumentCommand", "ProvideDocumentCommand",
  "DeclareDocumentCommand", "NewDocumentEnvironment", "RenewDocumentEnvironment", "NewExpandableDocumentCommand",
  "newrobustcmd", "renewrobustcmd", "lstnewenvironment", "NewEnviron", "RenewEnviron", "newcolumntype",
  "pretocmd", "apptocmd", "patchcmd", "AtBeginDocument", "AtEndDocument", "AtBeginEnvironment",
  "AtEndEnvironment", "BeforeBeginEnvironment", "AfterEndEnvironment", "addto", "g@addto@macro", "lstset",
  "tikzset", "pgfplotsset", "hypersetup", "newtcolorbox", "DeclareTColorBox", "newtheoremstyle",
  // biblatex: formats, drivers and maps are code run in its own context (\printfield, \map…)
  "DeclareFieldFormat", "DeclareListFormat", "DeclareNameFormat", "DeclareIndexFieldFormat", "DeclareIndexListFormat",
  "DeclareIndexNameFormat", "DeclareBibliographyDriver", "DeclareSourcemap", "DeclareStyleSourcemap",
  "DeclareDriverSourcemap", "defbibfilter", "defbibcheck", "defbibenvironment", "defbibheading", "defbibnote",
  "DeclareSortingTemplate", "DeclareLabelalphaTemplate", "DeclareUniquenameTemplate", "DeclareCiteCommand",
  "DeclareMultiCiteCommand", "newbibmacro", "renewbibmacro", "providebibmacro", "AtEveryBibitem", "AtEveryCitekey",
  "AtBeginBibliography", "AtNextBibliography", "AtEveryLositem", "AtDataInput", "DeclareFieldInputHandler",
  "DeclareListInputHandler", "DeclareNameInputHandler", "DeclareDelimFormat",
  // other packages' code arguments
  "newglossarystyle", "renewglossarystyle", "tcbset", "newtcbox", "setbeamertemplate", "defbeamertemplate",
  "addtobeamertemplate", "pdfstringdefDisableCommands", "xpatchcmd", "xapptocmd", "xpretocmd", "robustify",
]);

/** Commands whose argument is taken verbatim (may contain %, #, $ …). */
const RAW_ARG = new Set(["url", "path", "href", "includegraphics", "input", "include", "bibliography", "addbibresource"]);

const MAX_ISSUES = 100;

const isLetter = (c: string | undefined) => c !== undefined && /[A-Za-z@]/.test(c);

export function checkSyntax(text: string, opts: ScanOptions = {}): SyntaxIssue[] {
  return scanLatex(text, opts).issues;
}

const MAX_USES = 20000;

export function scanLatex(text: string, opts: ScanOptions = {}): ScanResult {
  const issues: SyntaxIssue[] = [];
  const uses: LatexUse[] = [];
  const verbatimEnvs = new Set([...VERBATIM_ENVS, ...(opts.verbatimEnvs ?? [])]);
  /** Inside \ExplSyntaxOn … \ExplSyntaxOff (names with _ and :). */
  let expl = false;
  const add = (from: number, to: number, message: string) => {
    if (issues.length < MAX_ISSUES) issues.push({ from, to, message });
  };
  const n = text.length;
  const docBegin = /\\begin\s*\{document\}/.exec(text);
  // Math is checked in the body only; a file without \begin{document}
  // (a chapter pulled in with \input) is all body.
  const bodyStart = docBegin ? docBegin.index : 0;

  const braces: number[] = [];
  const envs: { name: string; from: number; to: number }[] = [];
  let dollar: { kind: "$" | "$$"; pos: number } | null = null;
  let delim: { kind: "\\(" | "\\["; pos: number } | null = null;
  /** Brace depth where a macro definition started (its body is code). */
  let def: number | null = null;

  const closeMath = () => {
    if (dollar) {
      add(dollar.pos, dollar.pos + dollar.kind.length, `Fórmula aberta com ${dollar.kind} e não fechada: falta o ${dollar.kind} final antes do fim do parágrafo.`);
    }
    if (delim) {
      const close = delim.kind === "\\(" ? "\\)" : "\\]";
      add(delim.pos, delim.pos + 2, `Fórmula aberta com ${delim.kind} e não fechada: falta ${close} antes do fim do parágrafo.`);
    }
    dollar = null;
    delim = null;
  };
  const parBreak = () => {
    closeMath();
    if (def !== null && braces.length <= def) def = null;
  };

  /** Index just after the group starting at `open` (a "{"), or -1. */
  const skipGroup = (open: number): number => {
    let depth = 0;
    for (let j = open; j < n; j++) {
      const c = text[j];
      if (c === "\\") j++;
      else if (c === "{") depth++;
      else if (c === "}" && --depth === 0) return j + 1;
    }
    return -1;
  };
  const skipSpaces = (j: number) => {
    while (j < n && (text[j] === " " || text[j] === "\t")) j++;
    return j;
  };
  /** After a definition's group closes: does another argument follow? */
  const defContinues = (j: number) => {
    let newlines = 0;
    while (j < n && /\s/.test(text[j]!)) {
      if (text[j] === "\n" && ++newlines > 1) return false;
      j++;
    }
    return text[j] === "{" || text[j] === "[";
  };

  let i = 0;
  scan: while (i < n) {
    const c = text[i]!;

    if (c === "\n") {
      i++;
      let j = i;
      while (j < n && (text[j] === " " || text[j] === "\t" || text[j] === "\r")) j++;
      if (text[j] === "\n") parBreak();
      continue;
    }
    if (c === "%") {
      while (i < n && text[i] !== "\n") i++;
      continue;
    }
    if (c === "{") {
      braces.push(i++);
      continue;
    }
    if (c === "}") {
      if (braces.length === 0) {
        add(i, i + 1, "Chave } sem a { correspondente.");
      } else {
        braces.pop();
        if (def !== null && braces.length === def && !defContinues(i + 1)) def = null;
      }
      i++;
      continue;
    }
    if (c === "$") {
      const double = text[i + 1] === "$";
      let width = double ? 2 : 1;
      if (def === null && i >= bodyStart) {
        if (dollar?.kind === "$") {
          dollar = null; // closes; a second $ right after opens a new formula
          width = 1;
        } else if (dollar?.kind === "$$") {
          if (double) dollar = null;
          else width = 1; // $ inside $$ … $$, e.g. \text{se $x>0$}
        } else if (!delim) {
          dollar = { kind: double ? "$$" : "$", pos: i };
        } // inside \( \) or \[ \]: $ only appears within \text{…}
      }
      i += width;
      continue;
    }
    if (c !== "\\") {
      i++;
      continue;
    }

    // ---- control sequence
    let end = i + 1;
    if (isLetter(text[end])) {
      while (isLetter(text[end])) end++;
    } else {
      end = Math.min(n, end + 1); // control symbol: \$ \{ \\ \( …
    }
    const name = text.slice(i + 1, end);
    const math = def === null && i >= bodyStart;
    if (name === "ExplSyntaxOn") expl = true;
    else if (name === "ExplSyntaxOff") expl = false;
    else if (def === null && !expl && end - i > 1 && /^[A-Za-z]+$/.test(name) && uses.length < MAX_USES) {
      uses.push({ kind: "command", name, from: i, to: end });
    }

    switch (name) {
      case "(":
      case "[": {
        if (math && !dollar && !delim) delim = { kind: name === "(" ? "\\(" : "\\[", pos: i };
        i = end;
        continue;
      }
      case ")":
      case "]": {
        const open = name === ")" ? "\\(" : "\\[";
        if (math) {
          if (delim?.kind === open) delim = null;
          else if (!delim && !dollar) add(i, end, `\\${name} sem o ${open} correspondente.`);
        }
        i = end;
        continue;
      }
      case "verb": {
        const j = text[end] === "*" ? end + 1 : end;
        const d = text[j];
        const lineEnd = text.indexOf("\n", j) === -1 ? n : text.indexOf("\n", j);
        const close = d && d !== "\n" ? text.indexOf(d, j + 1) : -1;
        if (close === -1 || close > lineEnd) {
          add(i, end, "\\verb sem o delimitador de fechamento na mesma linha.");
          i = lineEnd;
        } else i = close + 1;
        continue;
      }
      case "lstinline":
      case "mintinline": {
        let j = skipSpaces(end);
        if (name === "mintinline" && text[j] === "{") j = Math.max(j + 1, skipGroup(j));
        if (text[j] === "[") j = Math.max(j + 1, text.indexOf("]", j) + 1);
        if (text[j] === "{") {
          const g = skipGroup(j);
          i = g === -1 ? end : g;
        } else if (text[j] && text[j] !== "\n") {
          const close = text.indexOf(text[j]!, j + 1);
          i = close === -1 ? end : close + 1;
        } else i = end;
        continue;
      }
      case "iffalse": {
        const fi = /\\fi(?![A-Za-z@])/g;
        fi.lastIndex = end;
        const m = fi.exec(text);
        i = m ? m.index + m[0].length : n;
        continue;
      }
      case "begin":
      case "end": {
        const m = /^\s*\{([^{}\n]*)\}/.exec(text.slice(end, end + 200));
        if (!m) {
          i = end;
          continue;
        }
        const env = m[1]!.trim();
        const tokEnd = end + m[0].length;
        if (def !== null) {
          i = tokEnd;
          continue;
        }
        if (name === "begin" && !expl && uses.length < MAX_USES) {
          const at = end + m[0].indexOf("{") + 1 + (m[1]!.length - m[1]!.trimStart().length);
          uses.push({ kind: "env", name: env, from: at, to: at + env.length });
        }
        if (name === "begin") {
          if (verbatimEnvs.has(env)) {
            const re = new RegExp(`\\\\end\\s*\\{${env.replace(/[*]/g, "\\*")}\\}`, "g");
            re.lastIndex = tokEnd;
            const close = re.exec(text);
            if (!close) {
              add(i, tokEnd, `\\begin{${env}} sem o \\end{${env}} correspondente.`);
              break scan;
            }
            i = close.index + close[0].length;
            continue;
          }
          envs.push({ name: env, from: i, to: tokEnd });
        } else {
          const at = envs.map((e) => e.name).lastIndexOf(env);
          if (at === -1) {
            add(i, tokEnd, `\\end{${env}} sem o \\begin{${env}} correspondente.`);
          } else {
            for (const open of envs.splice(at).slice(1)) {
              add(open.from, open.to, `\\begin{${open.name}} não foi fechado: falta \\end{${open.name}} antes do \\end{${env}}.`);
            }
          }
          if (env === "document") {
            closeMath();
            i = tokEnd;
            break scan; // TeX ignores everything after \end{document}
          }
        }
        i = tokEnd;
        continue;
      }
    }

    if (RAW_ARG.has(name)) {
      let j = skipSpaces(end);
      if (text[j] === "[") j = Math.max(j + 1, text.indexOf("]", j) + 1);
      j = skipSpaces(j);
      if (text[j] === "{") {
        const g = skipGroup(j);
        if (g !== -1) {
          i = g;
          continue;
        }
      }
    }
    if (def === null && DEF_COMMANDS.has(name)) def = braces.length;
    i = end;
  }

  if (i >= n) closeMath();
  for (const open of envs) add(open.from, open.to, `\\begin{${open.name}} sem o \\end{${open.name}} correspondente.`);
  for (const pos of braces) add(pos, pos + 1, "Chave { aberta e não fechada.");
  return { issues: issues.sort((a, b) => a.from - b.from), uses };
}
