/**
 * LaTeX knowledge base: which commands and environments the kernel, each
 * class and each package define (extracted from TeX itself by
 * scripts/latexkb/gen.mjs), with the packages each one loads. Used in the
 * browser for autocomplete and for the live check of unknown commands.
 */

export interface KBEntry {
  /** Packages it loads. */
  deps?: string[];
  /** Classes it loads (abntex2 → memoir). */
  classes?: string[];
  /** "name" or "name:spec", space separated; spec letters: s(tar) o(ptional) m(andatory), "?" = rest unknown. */
  cmds: string;
  envs: string;
  /** Defined (as \relax placeholders), but not worth offering. */
  hidden?: string;
}

export interface KBData {
  generated: string;
  engine: string;
  kernel: KBEntry;
  classes: Record<string, KBEntry>;
  packages: Record<string, KBEntry>;
  /** Packages/classes that could not be loaded when generating. */
  failed: Record<string, string>;
}

export interface KBItem {
  spec: string | null;
  /** "LaTeX", "classe article" or the package name. */
  source: string;
}

export interface Scope {
  /** Knowledge base entries in scope ("k", "c:article", "p:graphics"…). */
  keys: Set<string>;
  cmds: Map<string, KBItem>;
  envs: Map<string, KBItem>;
  hidden: Set<string>;
  /** Classes/packages in use that the knowledge base does not know. */
  unknown: string[];
}

interface Parsed {
  cmds: Map<string, string | null>;
  envs: Map<string, string | null>;
  hidden: string[];
}

/**
 * Packages proposed first when a command is missing (and in autocomplete),
 * in this order: \includegraphics → graphicx (not graphics, which defines it).
 */
export const POPULAR_PACKAGES = [
  "graphicx", "xcolor", "amsmath", "amssymb", "amsthm", "mathtools", "hyperref", "cleveref", "geometry",
  "booktabs", "tabularx", "multirow", "longtable", "array", "caption", "subcaption", "float", "enumitem",
  "listings", "tikz", "pgfplots", "siunitx", "biblatex", "natbib", "csquotes", "url", "fancyhdr", "titlesec",
  "setspace", "lipsum", "bm", "xspace", "ulem", "soul", "colortbl", "wrapfig", "pdfpages", "makecell",
  "multicol", "todonotes", "tcolorbox", "mdframed", "framed", "fontawesome5", "textcomp", "gensymb",
  "upgreek", "mathrsfs", "esint", "cancel", "nicefrac", "xfrac", "units", "physics", "algorithm2e",
  "algpseudocode", "glossaries", "acronym", "nomencl", "imakeidx", "makeidx", "appendix", "tocloft",
  "rotating", "pdflscape", "afterpage", "placeins", "ragged2e", "changepage", "etoolbox", "xparse",
  "ifthen", "calc", "comment", "verbatim", "fancyvrb", "minted", "abntex2cite", "indentfirst", "lastpage",
  "chngcntr", "babel", "fontspec", "inputenc", "fontenc", "microtype", "lmodern", "tikz-cd", "circuitikz",
  "forest", "pgfgantt", "tabularray", "threeparttable", "dcolumn", "hhline", "diagbox", "adjustbox",
  "pifont", "marvosym", "wasysym", "stmaryrd", "mathdots", "braket", "tensor", "cases", "empheq",
];

/** Engine-specific primitives (pdfTeX, XeTeX, LuaTeX): never reported. */
export const ENGINE_PREFIX = /^(pdf|XeTeX|xetex|lua|Umath|Ustack|Udelim|Uradical|Uover|Uchar)/;

function parseList(s: string | undefined, into: Map<string, string | null>) {
  if (!s) return;
  for (const item of s.split(" ")) {
    if (!item) continue;
    const at = item.indexOf(":");
    if (at < 0) into.set(item, null);
    else into.set(item.slice(0, at), item.slice(at + 1));
  }
}

export class LatexKB {
  private parsed = new Map<string, Parsed>();
  private sources: Map<string, string[]> | null = null;
  private envSources: Map<string, string[]> | null = null;
  private closures = new Map<string, Set<string>>();

  constructor(readonly data: KBData) {}

  hasPackage(name: string) {
    return Object.hasOwn(this.data.packages, name);
  }
  hasClass(name: string) {
    return Object.hasOwn(this.data.classes, name);
  }
  packageNames() {
    return Object.keys(this.data.packages);
  }
  classNames() {
    return Object.keys(this.data.classes);
  }

  private entry(key: string): KBEntry | undefined {
    if (key === "k") return this.data.kernel;
    const name = key.slice(2);
    return key.startsWith("c:") ? this.data.classes[name] : this.data.packages[name];
  }

  /** What one entry defines itself (not what it loads). */
  own(key: string): { cmds: ReadonlyMap<string, string | null>; envs: ReadonlyMap<string, string | null> } {
    return this.parse(key);
  }

  private parse(key: string): Parsed {
    let p = this.parsed.get(key);
    if (!p) {
      const e = this.entry(key);
      p = { cmds: new Map(), envs: new Map(), hidden: e?.hidden ? e.hidden.split(" ") : [] };
      parseList(e?.cmds, p.cmds);
      parseList(e?.envs, p.envs);
      this.parsed.set(key, p);
    }
    return p;
  }

  /** Keys ("c:article", "p:graphics"…) loaded, directly or not, by `key`. */
  closure(key: string): Set<string> {
    let c = this.closures.get(key);
    if (c) return c;
    c = new Set();
    const visit = (k: string) => {
      if (c!.has(k)) return;
      const e = this.entry(k);
      if (!e) return;
      c!.add(k);
      for (const cl of e.classes ?? []) visit("c:" + cl);
      for (const d of e.deps ?? []) visit("p:" + d);
    };
    visit(key);
    this.closures.set(key, c);
    return c;
  }

  static label(key: string) {
    return key === "k" ? "LaTeX" : key.startsWith("c:") ? `classe ${key.slice(2)}` : key.slice(2);
  }

  /** Everything defined by the kernel plus these classes and packages. */
  scope(classes: string[], packages: string[]): Scope {
    const keys = new Set<string>(["k"]);
    const unknown: string[] = [];
    for (const c of classes) {
      if (this.hasClass(c)) for (const k of this.closure("c:" + c)) keys.add(k);
      else unknown.push(c);
    }
    for (const p of packages) {
      if (this.hasPackage(p)) for (const k of this.closure("p:" + p)) keys.add(k);
      else unknown.push(p);
    }
    const cmds = new Map<string, KBItem>();
    const envs = new Map<string, KBItem>();
    const hidden = new Set<string>();
    for (const key of keys) {
      const p = this.parse(key);
      const source = LatexKB.label(key);
      for (const [n, spec] of p.cmds) if (!cmds.has(n)) cmds.set(n, { spec, source });
      for (const [n, spec] of p.envs) if (!envs.has(n)) envs.set(n, { spec, source });
      for (const n of p.hidden) hidden.add(n);
    }
    return { keys, cmds, envs, hidden, unknown };
  }

  private allKeys() {
    return ["k", ...this.classNames().map((c) => "c:" + c), ...this.packageNames().map((p) => "p:" + p)];
  }

  /** Keys that define the command (or environment) themselves. */
  definedBy(name: string, kind: "command" | "env"): string[] {
    if (!this.sources || !this.envSources) {
      this.sources = new Map();
      this.envSources = new Map();
      for (const key of this.allKeys()) {
        const p = this.parse(key);
        for (const n of p.cmds.keys()) this.sources.set(n, [...(this.sources.get(n) ?? []), key]);
        for (const n of p.hidden) this.sources.set(n, [...(this.sources.get(n) ?? []), key]);
        for (const n of p.envs.keys()) this.envSources.set(n, [...(this.envSources.get(n) ?? []), key]);
      }
    }
    return (kind === "command" ? this.sources : this.envSources).get(name) ?? [];
  }

  /** Signature of a command defined somewhere in the knowledge base. */
  specOf(name: string, kind: "command" | "env" = "command"): string | null {
    for (const key of this.definedBy(name, kind)) {
      const p = this.parse(key);
      const s = (kind === "command" ? p.cmds : p.envs).get(name);
      if (s) return s;
    }
    return null;
  }

  /**
   * What would define a missing command: the most common package that loads
   * a definer, else a definer; or the classes that define it.
   */
  provider(name: string, kind: "command" | "env"): { package: string } | { classes: string[] } | null {
    const by = this.definedBy(name, kind);
    if (by.length === 0) return null;
    const set = new Set(by);
    for (const p of POPULAR_PACKAGES) {
      if (!this.hasPackage(p)) continue;
      for (const k of this.closure("p:" + p)) if (set.has(k)) return { package: p };
    }
    const pkg = by.find((k) => k.startsWith("p:"));
    if (pkg) return { package: pkg.slice(2) };
    const classes = by.filter((k) => k.startsWith("c:")).map((k) => k.slice(2));
    return classes.length ? { classes } : null;
  }
}

// ------------------------------------------------------------ snippets

/** Snippet arguments for a signature ("{#{}}{#{}}"), or null if not fully known. */
export function specSnippet(spec: string | null): string | null {
  if (spec === null || spec.includes("?")) return null;
  const m = spec.replace(/[so]/g, "").length;
  return m > 0 && m <= 9 ? "{#{}}".repeat(m) : null;
}

/** Human form of a signature: \textcolor{…}{…}, \section*[…]{…}. */
export function specLabel(name: string, spec: string | null): string {
  if (!spec) return "\\" + name;
  let out = "\\" + name;
  for (const c of spec) {
    if (c === "s") out += "*";
    else if (c === "o") out += "[…]";
    else if (c === "m") out += "{…}";
    else if (c === "?") out += "…";
  }
  return out;
}

// ------------------------------------------------------- typo distance

/** Optimal string alignment distance, capped at max+1. */
export function editDistance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const n = a.length;
  const m = b.length;
  let prev2: number[] = [];
  let prev = Array.from({ length: m + 1 }, (_, j) => j);
  for (let i = 1; i <= n; i++) {
    const cur = [i];
    let best = i;
    for (let j = 1; j <= m; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, prev2[j - 2]! + 1);
      cur.push(v);
      if (v < best) best = v;
    }
    if (best > max) return max + 1;
    prev2 = prev;
    prev = cur;
  }
  return prev[m]!;
}

/** Closest names to a misspelled one (best first). */
export function closest(name: string, candidates: Iterable<string>, preferred: Set<string> = new Set(), limit = 3): string[] {
  if (name.length < 3) return [];
  const max = name.length <= 4 ? 1 : 2;
  const lower = name.toLowerCase();
  const found: { n: string; d: number }[] = [];
  for (const c of candidates) {
    if (c === name || Math.abs(c.length - name.length) > max) continue;
    // Same letters in another case is the most likely slip (\Textbf).
    const d = c.toLowerCase() === lower ? 0.5 : editDistance(name, c, max);
    if (d <= max) found.push({ n: c, d });
  }
  const score = (x: { n: string; d: number }) =>
    x.d * 10 + (x.n[0] === name[0] ? 0 : 3) + (preferred.has(x.n) ? 0 : 2) + Math.abs(x.n.length - name.length) * 0.1;
  return found
    .sort((a, b) => score(a) - score(b) || a.n.localeCompare(b.n))
    .slice(0, limit)
    .map((x) => x.n);
}

// -------------------------------------------- definitions in the source

export interface SourceFacts {
  classes: string[];
  packages: string[];
  /** Commands the text defines (\newcommand, \def, \let, \newif…). */
  commands: Set<string>;
  envs: Set<string>;
  verbatimEnvs: Set<string>;
  /** Names built at run time (\csname…): the command set is not fully known. */
  dynamic: boolean;
}

const DEFINE_RE = new RegExp(
  String.raw`\\(?:(?:re)?newcommand|providecommand|DeclareRobustCommand|(?:re)?newrobustcmd|(?:re)?newcommandx|` +
    String.raw`(?:New|Renew|Provide|Declare)(?:Expandable)?DocumentCommand|(?:New|Renew|Declare)CommandCopy|` +
    String.raw`[gex]?def|(?:global\s*)?let|newlength|newsavebox|newcount|newdimen|newskip|newmuskip|newtoks|newbox|` +
    String.raw`newwrite|newread|chardef|mathchardef|countdef|dimendef|DeclarePairedDelimiter[XP]?|DeclareMathOperator|` +
    String.raw`DeclareMathSymbol|DeclareMathDelimiter|DeclareMathAccent|DeclareTextFontCommand|DeclareOldFontCommand|` +
    String.raw`DeclareMathAlphabet|DeclareSymbolFontAlphabet|newfontfamily|newfontface|setmathfont|newif|font|` +
    String.raw`DeclareCiteCommand|DeclareMultiCiteCommand|DeclareCaseLangs|newrobustcmd|` +
    // pgf/TikZ macros set by computation
    String.raw`pgfmathsetmacro|pgfmathtruncatemacro|pgfmathsetlengthmacro|pgfplotstableread\s*\{[^{}]*\}|` +
    String.raw`pgfplotstablegetelem\s*\{[^{}]*\}\s*\{[^{}]*\}\s*\\of\s*\{?[^{}]*\}?|readlist\*?)` +
    String.raw`\*?\s*\{?\s*\\([A-Za-z]+)`,
  "g",
);
const COUNTER_RE = /\\newcounter\s*\{([A-Za-z]+)\}/g;
// Commands named by a braced argument: memoir's \newlistof{listofquadros}{loq}{…}.
const NAMED_RE = /\\(?:newlistof|newfixedcaption)\s*(?:\[[^\]]*\]\s*)?\{\\?([A-Za-z]+)\}/g;
// TikZ/pgfplots loop variables: plot[variable=\x], \foreach … [count=\i, evaluate=\x as \y].
const TIKZVAR_RE = /\b(?:variable|count|remember\s*=\s*\\[A-Za-z]+\s+as|evaluate\s*=\s*\\[A-Za-z]+\s+as)\s*=?\s*\\([A-Za-z]+)/g;
const NEWENV_RE =
  /\\(?:(?:re)?newenvironment|(?:New|Renew|Provide|Declare)DocumentEnvironment|newtheorem\*?|lstnewenvironment|newtcolorbox|(?:Declare|New)TColorBox|newtcblisting|DeclareTCBListing|newtcbtheorem|newmdenv|newfloat|DeclareFloatingEnvironment|newlist|declaretheorem|NewEnviron|newenvironmentx|DefineVerbatimEnvironment|CustomVerbatimEnvironment)\*?\s*(?:\[[^\]]*\]\s*)?\{([^{}\\]+)\}/g;
const VERBENV_RE = /\\(lstnewenvironment|newtcblisting|DeclareTCBListing|DefineVerbatimEnvironment|CustomVerbatimEnvironment)\s*(?:\[[^\]]*\]\s*)?\{([^{}\\]+)\}/g;
const MINTED_RE = /\\newminted\s*(?:\[([^\]]*)\])?\s*\{([^{}]+)\}/g;
const MINTINLINE_RE = /\\newmintinline\s*(?:\[([^\]]*)\])?\s*\{([^{}]+)\}/g;
// \foreach \x/\y in …, \StrLen{…}[\n] (xstring results), \tikzmath{\x = …}
const FOREACH_RE = /\\foreach\s*((?:\\[A-Za-z]+\s*\/?\s*)+)(?:\[[^\]]*\]\s*)?in\b/g;
const OPTRESULT_RE = /\\(?:Str[A-Za-z]+|IfSubStr|setsepchar)\s*(?:\*\s*)?(?:\{[^{}]*\}\s*|\[[^\]]*\]\s*)*\[\s*\\([A-Za-z]+)\s*\]/g;
const TIKZMATH_RE = /\\tikzmath\s*\{([^]*?)\}\s*;?/g;
const DYNAMIC_RE = /\\(?:expandafter\s*\\(?:[gex]?def|let|newcommand|renewcommand|providecommand)\s*\\csname|@namedef|cs[gex]?def\b|csletcs\b|cslet\b)/;
const USE_RE = /\\(documentclass|usepackage|RequirePackage|LoadClass)\s*(?:\[[^\]]*\])?\s*\{([^{}]*)\}/g;

/** Text without comments (same length, comments blanked). */
export function blankComments(text: string): string {
  return text
    .split("\n")
    .map((line) => {
      for (let i = 0; i < line.length; i++) {
        if (line[i] === "\\") i++;
        else if (line[i] === "%") return line.slice(0, i) + " ".repeat(line.length - i);
      }
      return line;
    })
    .join("\n");
}

/** Classes, packages and definitions found in a LaTeX source. */
export function scanSource(text: string): SourceFacts {
  const code = blankComments(text);
  const f: SourceFacts = { classes: [], packages: [], commands: new Set(), envs: new Set(), verbatimEnvs: new Set(), dynamic: DYNAMIC_RE.test(code) };
  for (const m of code.matchAll(USE_RE)) {
    for (const raw of m[2]!.split(",")) {
      const name = raw.trim();
      if (!name || /[\\#]/.test(name)) continue;
      (m[1] === "documentclass" || m[1] === "LoadClass" ? f.classes : f.packages).push(name);
    }
  }
  for (const m of code.matchAll(DEFINE_RE)) {
    const name = m[1]!;
    f.commands.add(name);
    if (m[0].includes("newif") && name.startsWith("if")) {
      f.commands.add(name.slice(2) + "true");
      f.commands.add(name.slice(2) + "false");
    }
  }
  for (const m of code.matchAll(COUNTER_RE)) f.commands.add("the" + m[1]);
  for (const m of code.matchAll(NAMED_RE)) f.commands.add(m[1]!);
  for (const m of code.matchAll(TIKZVAR_RE)) f.commands.add(m[1]!);
  for (const m of code.matchAll(NEWENV_RE)) {
    const e = m[1]!.trim();
    f.envs.add(e);
    if (m[0].startsWith("\\newtcbtheorem")) f.envs.add(e + "*");
  }
  for (const m of code.matchAll(VERBENV_RE)) f.verbatimEnvs.add(m[2]!.trim());
  for (const m of code.matchAll(MINTED_RE)) {
    const e = m[1] || m[2]!.trim() + "code";
    f.envs.add(e);
    f.verbatimEnvs.add(e);
  }
  for (const m of code.matchAll(MINTINLINE_RE)) f.commands.add(m[1] || m[2]!.trim() + "inline");
  for (const m of code.matchAll(FOREACH_RE)) for (const v of m[1]!.matchAll(/\\([A-Za-z]+)/g)) f.commands.add(v[1]!);
  for (const m of code.matchAll(OPTRESULT_RE)) f.commands.add(m[1]!);
  for (const m of code.matchAll(TIKZMATH_RE)) for (const v of m[1]!.matchAll(/\\([A-Za-z]+)\s*=/g)) f.commands.add(v[1]!);
  return f;
}

// ------------------------------------------------- adding a \usepackage

/**
 * Where to add \usepackage{name} in a main file: after the last package of
 * the preamble (or after \documentclass). Null when there is no preamble or
 * the package is already there.
 */
export function packageInsertion(text: string, name: string): { from: number; insert: string } | null {
  const code = blankComments(text);
  const begin = /\\begin\s*\{document\}/.exec(code);
  if (!begin) return null;
  const preamble = code.slice(0, begin.index);
  let after = -1;
  for (const m of preamble.matchAll(USE_RE)) {
    if (m[1] === "usepackage" || m[1] === "RequirePackage") {
      if (m[2]!.split(",").some((p) => p.trim() === name)) return null;
    }
    if (m[1] !== "LoadClass") after = m.index! + m[0].length;
  }
  if (after < 0) return null;
  const eol = text.indexOf("\n", after);
  const at = eol < 0 || eol > begin.index ? after : eol;
  return { from: at, insert: `\n\\usepackage{${name}}` };
}
