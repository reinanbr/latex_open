/**
 * Pure, editor-independent analysis of LaTeX source: environments
 * (\begin/\end pairs) and sectioning commands. Used by folding, environment
 * matching and the outline panel.
 */

/** Return the line with any TeX comment removed (an unescaped %). */
export function stripComment(line: string): string {
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === "\\") i++;
    else if (c === "%") return line.slice(0, i);
  }
  return line;
}

export interface EnvToken {
  kind: "begin" | "end";
  name: string;
  /** Offset of the backslash. */
  from: number;
  /** Offset just after the closing brace. */
  to: number;
  line: number; // 1-based
}

export interface EnvPair {
  begin: EnvToken;
  end: EnvToken | null; // null when unmatched
}

const ENV_RE = /\\(begin|end)\s*\{([^{}\s]+)\}/g;

/** Environments whose body is verbatim: \end inside them is literal text. */
export const VERBATIM_ENVS = new Set([
  "verbatim", "verbatim*", "lstlisting", "minted", "Verbatim", "Verbatim*", "BVerbatim", "LVerbatim", "SaveVerbatim",
  "VerbatimOut", "comment", "filecontents", "filecontents*", "tcblisting", "luacode", "luacode*", "pycode", "pyblock",
  "sagesilent", "sageblock", "asy", "mpost", "gnuplot", "spverbatim", "alltt*",
]);

/** Scan \begin{..}/\end{..} tokens, skipping comments and verbatim bodies. */
export function scanEnvTokens(text: string): EnvToken[] {
  const out: EnvToken[] = [];
  let offset = 0;
  let lineNo = 0;
  let verbatim: string | null = null;
  for (const line of text.split("\n")) {
    lineNo++;
    const code = verbatim ? line : stripComment(line);
    ENV_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = ENV_RE.exec(code))) {
      const kind = m[1] as "begin" | "end";
      const name = m[2] ?? "";
      if (verbatim) {
        if (kind === "end" && name === verbatim) {
          verbatim = null;
          out.push({ kind, name, from: offset + m.index, to: offset + m.index + m[0].length, line: lineNo });
        }
        continue;
      }
      out.push({ kind, name, from: offset + m.index, to: offset + m.index + m[0].length, line: lineNo });
      if (kind === "begin" && VERBATIM_ENVS.has(name)) {
        verbatim = name;
        // The rest of this line is verbatim too.
        break;
      }
    }
    offset += line.length + 1;
  }
  return out;
}

/** Pair \begin with \end using a stack; mismatches are reported unmatched. */
export function matchEnvironments(tokens: EnvToken[]): { pairs: EnvPair[]; unmatchedEnds: EnvToken[] } {
  const pairs: EnvPair[] = [];
  const unmatchedEnds: EnvToken[] = [];
  const stack: EnvPair[] = [];
  for (const t of tokens) {
    if (t.kind === "begin") {
      const p: EnvPair = { begin: t, end: null };
      pairs.push(p);
      stack.push(p);
      continue;
    }
    // Find the nearest open env with this name; anything opened after it is unclosed.
    let i = stack.length - 1;
    while (i >= 0 && stack[i]?.begin.name !== t.name) i--;
    if (i < 0) {
      unmatchedEnds.push(t);
      continue;
    }
    const p = stack[i];
    if (p) p.end = t;
    stack.length = i;
  }
  return { pairs, unmatchedEnds };
}

export const SECTION_LEVELS: Record<string, number> = {
  part: 0,
  chapter: 1,
  section: 2,
  subsection: 3,
  subsubsection: 4,
  paragraph: 5,
  subparagraph: 6,
};

export interface Section {
  level: number;
  command: string;
  title: string;
  line: number; // 1-based
  from: number; // offset of the backslash
  starred: boolean;
}

const SECTION_RE = /\\(part|chapter|section|subsection|subsubsection|paragraph|subparagraph)(\*?)\s*(?:\[[^\]]*\])?\s*\{/g;

/** Read a balanced {...} group starting right after an opening brace. */
function readGroup(s: string, start: number): string | null {
  let depth = 1;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (c === "\\") {
      i++;
      continue;
    }
    if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return s.slice(start, i);
  }
  return null;
}

/** Turn a section title's TeX into readable text for the outline. */
export function cleanTitle(tex: string): string {
  return tex
    .replace(/\\(?:label|index|footnote|cite\w*|ref)\s*\{[^{}]*\}/g, "")
    .replace(/\\(?:textbf|textit|emph|texttt|textsc|textsf|textrm|underline|mbox|text)\s*\{([^{}]*)\}/g, "$1")
    .replace(/\\(?:LaTeX|TeX)\b\{?\}?/g, (m) => (m.startsWith("\\LaTeX") ? "LaTeX" : "TeX"))
    .replace(/\\[a-zA-Z@]+\*?/g, "")
    .replace(/\\(.)/g, "$1")
    .replace(/[{}]/g, "")
    .replace(/~/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Extract sectioning commands (multi-line titles are supported). */
export function parseSections(text: string): Section[] {
  const out: Section[] = [];
  // Blank out comments but keep offsets stable.
  const lines = text.split("\n");
  const code = lines.map((l) => {
    const c = stripComment(l);
    return c + " ".repeat(l.length - c.length);
  });
  const joined = code.join("\n");
  const lineStarts: number[] = [];
  let pos = 0;
  for (const l of lines) {
    lineStarts.push(pos);
    pos += l.length + 1;
  }
  const lineOf = (offset: number) => {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if ((lineStarts[mid] ?? 0) <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
  SECTION_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = SECTION_RE.exec(joined))) {
    const command = m[1] ?? "section";
    const raw = readGroup(joined, m.index + m[0].length);
    if (raw === null) continue;
    out.push({
      level: SECTION_LEVELS[command] ?? 2,
      command,
      title: cleanTitle(raw) || "(sem título)",
      line: lineOf(m.index),
      from: m.index,
      starred: m[2] === "*",
    });
  }
  return out;
}

/**
 * Line range a section heading folds: from the heading line to the line
 * before the next heading of the same or a higher level (or \end{document}),
 * excluding trailing blank lines. Returns null if nothing to fold.
 */
export function sectionFoldRange(
  sections: Section[],
  index: number,
  lines: string[],
): { startLine: number; endLine: number } | null {
  const s = sections[index];
  if (!s) return null;
  let endLine = lines.length;
  for (let i = index + 1; i < sections.length; i++) {
    const next = sections[i];
    if (next && next.level <= s.level) {
      endLine = next.line - 1;
      break;
    }
  }
  for (let l = s.line; l < endLine; l++) {
    if (/\\end\s*\{document\}/.test(stripComment(lines[l] ?? ""))) {
      endLine = l; // line index l is 1-based line l+1; fold up to the line before it
      break;
    }
  }
  while (endLine > s.line && (lines[endLine - 1] ?? "").trim() === "") endLine--;
  return endLine > s.line ? { startLine: s.line, endLine } : null;
}
