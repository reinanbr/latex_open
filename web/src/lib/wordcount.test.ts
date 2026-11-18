import { describe, expect, it } from "vitest";
import { estimateWords, inputsOf } from "./wordcount";

describe("estimateWords", () => {
  it("counts body prose only", () => {
    const tex = String.raw`\documentclass{article}
\usepackage{amsmath}
\title{Ignored preamble}
\begin{document}
\section{Introdução}\label{sec:intro}
Olá mundo, isto é um teste % comentário não conta
com $x^2 + y$ matemática e \textbf{negrito} e ver \ref{sec:intro}.
\begin{equation} a = b \end{equation}
50\% d'água.
\end{document}`;
    // Introdução Olá mundo isto é um teste com matemática e negrito e ver 50 d'água
    expect(estimateWords(tex)).toBe(15);
  });
  it("works on fragments without a document body", () => {
    expect(estimateWords("Só um \\emph{fragmento} aqui.")).toBe(4);
  });
});

describe("inputsOf", () => {
  it("lists included files", () => {
    expect(inputsOf("\\input{chapters/intro}\n% \\input{x}\n\\include{a.tex}\\subfile{./b}")).toEqual([
      "chapters/intro.tex",
      "a.tex",
      "b.tex",
    ]);
  });
});
