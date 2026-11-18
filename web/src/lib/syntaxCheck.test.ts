import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { checkSyntax } from "./syntaxCheck";

const msgs = (src: string) => checkSyntax(src).map((i) => i.message);
const doc = (body: string, preamble = "") => `\\documentclass{article}\n${preamble}\\begin{document}\n${body}\n\\end{document}\n`;

describe("checkSyntax", () => {
  it("accepts correct documents", () => {
    expect(
      checkSyntax(
        doc(
          "Texto $x^2$ e $$y$$, \\(a\\) e \\[b\\].\n\n\\begin{itemize}\n\\item \\{ chaves \\} 100\\% e \\$5\n\\end{itemize}\n" +
            "\\[ f(x) = \\begin{cases} 1 & \\text{se $x>0$} \\\\[2pt] 0 \\end{cases} \\]\n$a$$b$",
        ),
      ),
    ).toEqual([]);
  });

  it("reports unbalanced braces with positions", () => {
    const src = doc("\\textbf{negrito\n\nfim}}");
    const issues = checkSyntax(src);
    expect(issues.map((i) => i.message)).toEqual(["Chave } sem a { correspondente."]);
    expect(src.slice(issues[0]!.from, issues[0]!.to)).toBe("}");
    expect(msgs(doc("\\section{Título"))).toEqual(["Chave { aberta e não fechada."]);
  });

  it("reports environments that do not match", () => {
    expect(msgs(doc("\\begin{itemize}\n\\item a\n\\end{enumerate}"))).toEqual([
      "\\begin{itemize} não foi fechado: falta \\end{itemize} antes do \\end{document}.",
      "\\end{enumerate} sem o \\begin{enumerate} correspondente.",
    ]);
    expect(msgs(doc("\\begin{figure}\\begin{center}x\\end{figure}"))).toEqual([
      "\\begin{center} não foi fechado: falta \\end{center} antes do \\end{figure}.",
    ]);
    const src = doc("\\begin {table}\nx");
    const [issue] = checkSyntax(src).filter((i) => i.message.includes("table"));
    expect(src.slice(issue!.from, issue!.to)).toBe("\\begin {table}");
  });

  it("reports math left open at the end of a paragraph", () => {
    expect(msgs(doc("Seja $x = 2\n\nOutro parágrafo."))).toEqual([
      "Fórmula aberta com $ e não fechada: falta o $ final antes do fim do parágrafo.",
    ]);
    expect(msgs(doc("\\[ a + b"))).toEqual(["Fórmula aberta com \\[ e não fechada: falta \\] antes do fim do parágrafo."]);
    expect(msgs(doc("texto \\) solto"))).toEqual(["\\) sem o \\( correspondente."]);
    expect(msgs(doc("$$ x"))[0]).toContain("$$");
  });

  it("ignores comments, verbatim and raw arguments", () => {
    expect(
      checkSyntax(
        doc(
          "% \\begin{itemize} { $\n100\\% certo\n\\begin{verbatim}\n\\begin{x} { $ \\end{y}\n\\end{verbatim}\n" +
            "\\begin{lstlisting}\nif (a) { $x\n\\end{lstlisting}\n\\verb|{$| e \\verb*+}+ e \\lstinline{a{b}c} \\lstinline|$|\n" +
            "\\url{http://x.org/a%20b#c} \\href{http://x/%7B}{site}\n\\iffalse { \\begin{x} \\fi",
        ),
      ),
    ).toEqual([]);
  });

  it("does not flag macro definitions or math in the preamble", () => {
    const preamble =
      "\\newcommand{\\beq}{\\begin{equation}}\n\\newcommand{\\eeq}{\\end{equation}}\n" +
      "\\newenvironment{caixa}\n  {\\begin{center}\\begin{minipage}{5cm}}\n  {\\end{minipage}\\end{center}}\n" +
      "\\def\\dolar{$}\n\\renewcommand*\\x[2][a]{#1 \\(}\n\\lstset{literate={$}{{\\$}}1}\n";
    expect(checkSyntax(doc("\\beq a \\eeq\n\\begin{caixa}x\\end{caixa}", preamble))).toEqual([]);
  });

  it("checks a file without \\begin{document} (an \\input chapter) as body", () => {
    expect(msgs("\\section{A}\nSeja $x\n\nfim")).toHaveLength(1);
    expect(msgs("\\section{A}\n\\begin{itemize}\n\\item a\n\\end{itemize}\n")).toEqual([]);
  });

  it("stops at \\end{document}", () => {
    expect(msgs(doc("ok") + "lixo { \\begin{x} $")).toEqual([]);
  });

  it("finds no problems in the test projects", () => {
    for (const f of ["../testdata/sample-project/main.tex", "../testdata/abntex2-project/main.tex"]) {
      expect(checkSyntax(readFileSync(f, "utf8")), f).toEqual([]);
    }
  });
});
