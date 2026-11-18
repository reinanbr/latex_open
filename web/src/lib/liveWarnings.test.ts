import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { checkReferences, type ProjectRefs } from "./liveWarnings";
import { CITE, REF } from "../editor/completion";

const refCmds = new Set(REF);
const citeCmds = new Set(CITE);
const project: ProjectRefs = {
  labelsElsewhere: new Set(["sec:outro"]),
  citations: new Set(["knuth1984", "lamport1994"]),
  files: ["main.tex", "chapters/intro.tex", "figures/sample.png", "img/plot.pdf", "refs.bib"],
};
const check = (src: string, p: ProjectRefs = project) => checkReferences(src, refCmds, citeCmds, p);
const msgs = (src: string, p?: ProjectRefs) => check(src, p).map((w) => w.message);

describe("checkReferences", () => {
  it("accepts existing labels, keys and files", () => {
    expect(
      check(
        "\\section{A}\\label{sec:a}\nVer \\ref{sec:a}, \\cref{sec:a, sec:outro} e \\autoref{sec:outro}.\n" +
          "\\cite[p.~2]{knuth1984} \\citeonline{lamport1994} \\nocite{*}\n" +
          "\\includegraphics[width=3cm]{figures/sample} \\includegraphics{plot.pdf}\n\\include{chapters/intro} \\input{glyphtounicode}",
      ),
    ).toEqual([]);
  });

  it("reports unknown labels and keys at the key", () => {
    const src = "Ver \\ref{sec:nada} e \\cite{knuth1984,  semchave}.";
    const ws = check(src);
    expect(ws.map((w) => src.slice(w.from, w.to))).toEqual(["sec:nada", "semchave"]);
    expect(ws[0]!.message).toContain("\\label{sec:nada}");
    expect(ws[1]!.message).toContain("não existe nos arquivos .bib");
  });

  it("reports missing figures and included files", () => {
    expect(msgs("\\includegraphics{figures/outra}\n\\include{chapters/fim}\n\\input{partes/x}")).toEqual([
      'Figura não encontrada no projeto: "figures/outra".',
      'Arquivo não encontrado no projeto: "chapters/fim".',
      'Arquivo não encontrado no projeto: "partes/x".',
    ]);
  });

  it("reports a label defined twice in the file", () => {
    expect(msgs("\\label{x} a \\label{x}")).toHaveLength(2);
  });

  it("ignores comments, verbatim and macro definitions", () => {
    expect(
      check("% \\ref{nada}\n\\begin{verbatim}\n\\cite{nada}\n\\end{verbatim}\n\\newcommand{\\fig}[1]{\\includegraphics{#1}}\n\\verb|x| \\ref{sec:outro}"),
    ).toEqual([]);
  });

  it("waits for the project data", () => {
    expect(check("\\ref{a} \\cite{b} \\includegraphics{c}", { labelsElsewhere: null, citations: null, files: null })).toEqual([]);
  });

  it("finds nothing wrong in the test projects", () => {
    const sample: ProjectRefs = {
      labelsElsewhere: new Set(["sec:intro", "sec:methods", "fig:sample", "eq:euler"]),
      citations: new Set(["knuth1984", "lamport1994"]),
      files: ["main.tex", "chapters/intro.tex", "chapters/methods.tex", "figures/sample.png", "refs.bib"],
    };
    for (const f of ["main.tex", "chapters/intro.tex", "chapters/methods.tex"]) {
      expect(check(readFileSync("../testdata/sample-project/" + f, "utf8"), sample), f).toEqual([]);
    }
  });
});
