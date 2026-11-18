import { describe, expect, it } from "vitest";
import { cleanTitle, matchEnvironments, parseSections, scanEnvTokens, sectionFoldRange, stripComment } from "./latexStructure";

describe("stripComment", () => {
  it("removes comments but keeps escaped percent", () => {
    expect(stripComment("a % b")).toBe("a ");
    expect(stripComment("50\\% off % note")).toBe("50\\% off ");
    expect(stripComment("x \\\\% c")).toBe("x \\\\");
  });
});

describe("environments", () => {
  it("pairs nested environments", () => {
    const text = "\\begin{figure}\n\\begin{center}\nx\n\\end{center}\n\\end{figure}";
    const { pairs, unmatchedEnds } = matchEnvironments(scanEnvTokens(text));
    expect(unmatchedEnds).toHaveLength(0);
    expect(pairs.map((p) => [p.begin.name, p.begin.line, p.end?.line])).toEqual([
      ["figure", 1, 5],
      ["center", 2, 4],
    ]);
  });

  it("ignores commented and verbatim content", () => {
    const text = [
      "% \\begin{itemize}",
      "\\begin{verbatim}",
      "\\end{itemize} \\begin{x}",
      "\\end{verbatim}",
      "\\begin{a}\\end{a}",
    ].join("\n");
    const { pairs, unmatchedEnds } = matchEnvironments(scanEnvTokens(text));
    expect(pairs.map((p) => p.begin.name)).toEqual(["verbatim", "a"]);
    expect(pairs.every((p) => p.end !== null)).toBe(true);
    expect(unmatchedEnds).toHaveLength(0);
  });

  it("reports mismatches", () => {
    const { pairs, unmatchedEnds } = matchEnvironments(scanEnvTokens("\\begin{a}\\begin{b}\\end{a}\\end{c}"));
    expect(pairs.find((p) => p.begin.name === "b")?.end).toBeNull();
    expect(pairs.find((p) => p.begin.name === "a")?.end).not.toBeNull();
    expect(unmatchedEnds.map((t) => t.name)).toEqual(["c"]);
  });

  it("records offsets", () => {
    const text = "ab\\begin{x}cd";
    const [t] = scanEnvTokens(text);
    expect(text.slice(t!.from, t!.to)).toBe("\\begin{x}");
  });
});

describe("parseSections", () => {
  it("extracts levels, titles and lines", () => {
    const text = [
      "\\documentclass{article}",
      "\\section{Introdução}\\label{sec:intro}",
      "% \\section{Commented}",
      "\\subsection*{Com \\textbf{negrito} e \\LaTeX}",
      "\\section[short]{Long {nested} title}",
      "\\chapter{Multi",
      "line}",
    ].join("\n");
    const s = parseSections(text);
    expect(s.map((x) => [x.command, x.title, x.line, x.starred])).toEqual([
      ["section", "Introdução", 2, false],
      ["subsection", "Com negrito e LaTeX", 4, true],
      ["section", "Long nested title", 5, false],
      ["chapter", "Multi line", 6, false],
    ]);
  });

  it("cleans titles", () => {
    expect(cleanTitle("Results~and \\emph{Discussion}\\label{x}")).toBe("Results and Discussion");
    expect(cleanTitle("100\\% sure")).toBe("100% sure");
  });

  it("computes fold ranges", () => {
    const lines = ["\\section{A}", "a", "\\subsection{B}", "b", "", "\\section{C}", "c", "\\end{document}"];
    const sections = parseSections(lines.join("\n"));
    expect(sectionFoldRange(sections, 0, lines)).toEqual({ startLine: 1, endLine: 4 });
    expect(sectionFoldRange(sections, 1, lines)).toEqual({ startLine: 3, endLine: 4 });
    expect(sectionFoldRange(sections, 2, lines)).toEqual({ startLine: 6, endLine: 7 });
  });
});
