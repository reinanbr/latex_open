import { StreamLanguage, type StreamParser, type StringStream } from "@codemirror/language";

/**
 * A compact LaTeX tokenizer (StreamLanguage). Token names are Lezer highlight
 * tag names ("tagName", "string.special", …), mapped to colors in theme.ts.
 */

const MATH_ENVS = new Set([
  "equation", "equation*", "align", "align*", "gather", "gather*", "multline", "multline*",
  "flalign", "flalign*", "alignat", "alignat*", "eqnarray", "eqnarray*", "displaymath", "math",
]);
const VERBATIM_ENVS = new Set(["verbatim", "verbatim*", "lstlisting", "minted", "Verbatim", "comment"]);
const SECTION_CMDS = new Set(["part", "chapter", "section", "subsection", "subsubsection", "paragraph", "subparagraph"]);
const REF_CMDS = new Set([
  "ref", "eqref", "pageref", "autoref", "cref", "Cref", "nameref", "vref", "label",
  "cite", "citep", "citet", "parencite", "textcite", "autocite", "footcite", "citeauthor", "citeyear", "nocite",
  "input", "include", "includegraphics", "bibliography", "addbibresource", "usepackage", "documentclass",
  "RequirePackage", "includeonly", "subfile", "import",
]);

type Arg = "env-begin" | "env-end" | "ref" | "heading" | null;

interface LatexState {
  /** Closing delimiter of the current math mode ("$", "$$", "\\)", "\\]", "env:<name>"), or null. */
  math: string | null;
  /** Name of the verbatim environment we are inside, or null. */
  verbatim: string | null;
  /** Delimiter of an inline \verb, or null. */
  verbDelim: string | null;
  /** The next brace group is an argument of special kind. */
  arg: Arg;
  /** Inside an argument group: its kind and brace depth. */
  inArg: Arg;
  argDepth: number;
  /** Name collected inside \begin{...} to switch modes after the group. */
  envName: string;
}

function tokenVerbatim(stream: StringStream, state: LatexState): string {
  const end = `\\end{${state.verbatim}}`;
  const idx = stream.string.indexOf(end, stream.pos);
  if (idx === stream.pos) {
    stream.match("\\end");
    state.verbatim = null;
    state.arg = "env-end";
    return "keyword";
  }
  if (idx > stream.pos) stream.pos = idx;
  else stream.skipToEnd();
  return "monospace";
}

const latexParser: StreamParser<LatexState> = {
  name: "latex",
  startState: () => ({ math: null, verbatim: null, verbDelim: null, arg: null, inArg: null, argDepth: 0, envName: "" }),
  copyState: (s) => ({ ...s }),

  token(stream, state) {
    if (state.verbatim) return tokenVerbatim(stream, state);

    if (state.verbDelim) {
      const close = stream.string.indexOf(state.verbDelim, stream.pos);
      if (close < 0) stream.skipToEnd();
      else {
        stream.pos = close + 1;
        state.verbDelim = null;
      }
      return "monospace";
    }

    // Inside an argument group such as \ref{...} or \begin{...}.
    if (state.inArg) {
      const ch = stream.peek();
      if (ch === "}") {
        stream.next();
        if (--state.argDepth === 0) {
          const kind = state.inArg;
          state.inArg = null;
          if (kind === "env-begin") {
            if (VERBATIM_ENVS.has(state.envName)) state.verbatim = state.envName;
            else if (MATH_ENVS.has(state.envName) && !state.math) state.math = "env:" + state.envName;
          }
        }
        return "brace";
      }
      if (ch === "{") {
        stream.next();
        state.argDepth++;
        return "brace";
      }
      if (state.inArg === "heading") {
        // Commands inside headings keep their color.
        if (stream.match(/^\\[a-zA-Z@]+/)) return "tagName";
        stream.next();
        stream.eatWhile(/[^{}\\]/);
        return "heading";
      }
      stream.eatWhile(/[^{}]/);
      if (state.inArg === "env-begin" || state.inArg === "env-end") {
        state.envName = stream.current().trim();
        return "typeName";
      }
      return "labelName";
    }

    // An argument keyword was seen; wait for its group (optional [..] allowed).
    if (state.arg) {
      if (stream.eatSpace()) return null;
      if (stream.peek() === "[") {
        stream.next();
        stream.eatWhile(/[^\]]/);
        stream.eat("]");
        return "attributeValue";
      }
      if (stream.peek() === "*") {
        stream.next();
        return "tagName";
      }
      if (stream.peek() === "{") {
        stream.next();
        state.inArg = state.arg;
        state.argDepth = 1;
        state.arg = null;
        state.envName = "";
        return "brace";
      }
      state.arg = null;
    }

    if (stream.match("%")) {
      stream.skipToEnd();
      return "comment";
    }

    if (stream.peek() === "\\") {
      // Math delimiters.
      if (stream.match("\\(") || stream.match("\\[")) {
        if (!state.math) state.math = stream.current() === "\\(" ? "\\)" : "\\]";
        return "processingInstruction";
      }
      if (stream.match("\\)") || stream.match("\\]")) {
        if (state.math === stream.current()) state.math = null;
        return "processingInstruction";
      }
      const cmd = stream.match(/^\\([a-zA-Z@]+)/) as RegExpMatchArray | null;
      if (cmd) {
        const name = cmd[1] ?? "";
        if (name === "begin" || name === "end") {
          state.arg = name === "begin" ? "env-begin" : "env-end";
          if (name === "end" && state.math?.startsWith("env:")) state.math = null;
          return "keyword";
        }
        if (name === "verb" || name === "lstinline") {
          stream.eat("*");
          const d = stream.next();
          if (d && d !== "{") state.verbDelim = d;
          return "keyword";
        }
        if (SECTION_CMDS.has(name)) {
          state.arg = "heading";
          return "heading";
        }
        if (REF_CMDS.has(name)) {
          state.arg = "ref";
          return "tagName";
        }
        return state.math ? "tagName.special" : "tagName";
      }
      stream.next();
      stream.next(); // escaped char like \% \{ \\ \,
      return "escape";
    }

    if (stream.match("$$") || stream.match("$")) {
      const d = stream.current();
      if (state.math === d) state.math = null;
      else if (!state.math) state.math = d;
      return "processingInstruction";
    }

    const ch = stream.next();
    if (ch === "{" || ch === "}") return "brace";
    if (ch === "[" || ch === "]") return "squareBracket";
    if (ch === "&") return "operator";
    if (ch === "~") return "operator";
    if (state.math) {
      if (ch && /[0-9]/.test(ch)) {
        stream.eatWhile(/[0-9.]/);
        return "number";
      }
      if (ch === "^" || ch === "_") return "operator";
      stream.eatWhile(/[^\\$%{}[\]&^_\s]/);
      return "string.special";
    }
    stream.eatWhile(/[^\\$%{}[\]&~]/);
    return null;
  },

  blankLine(state) {
    // A paragraph break ends inline math (TeX would error anyway); avoids runaway coloring.
    if (state.math === "$") state.math = null;
  },

  languageData: {
    commentTokens: { line: "%" },
    closeBrackets: { brackets: ["{", "[", "("] },
  },
};

export const latexLanguage = StreamLanguage.define(latexParser);

// ---------------------------------------------------------------- BibTeX

interface BibState {
  /** 0 = outside an entry, 1 = after @type before "{", 2 = in entry body. */
  stage: 0 | 1 | 2;
  depth: number;
  expectKey: boolean;
  inValue: boolean;
  quote: boolean;
}

const bibtexParser: StreamParser<BibState> = {
  name: "bibtex",
  startState: () => ({ stage: 0, depth: 0, expectKey: false, inValue: false, quote: false }),
  copyState: (s) => ({ ...s }),
  token(stream, state) {
    if (stream.eatSpace()) return null;
    if (state.stage === 0) {
      if (stream.match(/^@[a-zA-Z]+/)) {
        state.stage = 1;
        return "keyword";
      }
      if (stream.match("%")) {
        stream.skipToEnd();
        return "comment";
      }
      stream.skipToEnd(); // text between entries is a comment in BibTeX
      return "comment";
    }
    if (state.stage === 1) {
      if (stream.eat("{") || stream.eat("(")) {
        state.stage = 2;
        state.depth = 1;
        state.expectKey = true;
        return "brace";
      }
      stream.next();
      return null;
    }
    // stage 2: entry body
    if (state.expectKey) {
      if (stream.match(/^[^,\s}]+/)) {
        state.expectKey = false;
        return "labelName";
      }
    }
    if (state.inValue && state.depth > 1) {
      // Inside {...} value.
      const ch = stream.next();
      if (ch === "{") state.depth++;
      else if (ch === "}") {
        state.depth--;
        if (state.depth === 1) state.inValue = false;
        return "string";
      } else if (ch === "\\") stream.match(/^[a-zA-Z@]+|^./);
      else stream.eatWhile(/[^{}\\]/);
      return "string";
    }
    if (state.quote) {
      const ch = stream.next();
      if (ch === '"') {
        state.quote = false;
        state.inValue = false;
      } else stream.eatWhile(/[^"\\{}]/);
      return "string";
    }
    const ch = stream.peek();
    if (ch === "{") {
      stream.next();
      state.depth++;
      state.inValue = true;
      return "string";
    }
    if (ch === "}" || ch === ")") {
      stream.next();
      state.depth--;
      if (state.depth <= 0) {
        state.stage = 0;
        state.inValue = false;
      }
      return "brace";
    }
    if (ch === '"') {
      stream.next();
      state.quote = true;
      state.inValue = true;
      return "string";
    }
    if (stream.match(/^[a-zA-Z_-]+(?=\s*=)/)) return "propertyName";
    if (stream.match(/^[0-9]+/)) return "number";
    if (stream.match(/^[a-zA-Z_]+/)) return "variableName";
    stream.next();
    return "operator";
  },
  languageData: { commentTokens: { line: "%" } },
};

export const bibtexLanguage = StreamLanguage.define(bibtexParser);
