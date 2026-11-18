// Rough word count used when texcount is not installed on the server.

const DROP_WITH_ARG =
  /\\(?:label|ref|eqref|cref|Cref|autoref|pageref|cite[a-zA-Z]*|[a-z]*cite|includegraphics|input|include|usepackage|documentclass|bibliography(?:style)?|addbibresource|begin|end|url|hspace|vspace|newcommand|renewcommand|setlength)\*?\s*(?:\[[^\]]*\])*\s*(?:\{[^{}]*\}\s*)?/g;
const MATH = /\$\$[\s\S]*?\$\$|\$[^$]*\$|\\\[[\s\S]*?\\\]|\\\([\s\S]*?\\\)|\\begin\{(equation|align|gather|multline|eqnarray)\*?\}[\s\S]*?\\end\{\1\*?\}/g;
const WORD = /[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu;

/** Remove comments line by line (keeping escaped \%). */
function stripComments(text: string): string {
  return text.replace(/(^|[^\\])%.*$/gm, "$1");
}

/** Words in the document body (or the whole text when there is no body). */
export function estimateWords(text: string): number {
  let t = stripComments(text);
  const begin = t.indexOf("\\begin{document}");
  if (begin >= 0) t = t.slice(begin + "\\begin{document}".length);
  const end = t.indexOf("\\end{document}");
  if (end >= 0) t = t.slice(0, end);
  t = t.replace(MATH, " ").replace(DROP_WITH_ARG, " ").replace(/\\[a-zA-Z@]+\*?/g, " ").replace(/\\./g, " ");
  return t.match(WORD)?.length ?? 0;
}

/** Files referenced by \input/\include/\subfile (with .tex added when missing). */
export function inputsOf(text: string): string[] {
  const out: string[] = [];
  const re = /\\(?:input|include|subfile)\s*\{([^{}]+)\}/g;
  for (const m of stripComments(text).matchAll(re)) {
    let f = (m[1] ?? "").trim().replace(/^\.\//, "");
    if (!f) continue;
    if (!/\.[a-z]+$/i.test(f)) f += ".tex";
    out.push(f);
  }
  return out;
}
