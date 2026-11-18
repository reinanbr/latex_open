import { describe, expect, it } from "vitest";
import { detectContext, innermostOpenEnv, optionsFor, type CompletionData } from "./completion";

const data: CompletionData = {
  index: {
    labels: [{ key: "sec:intro", file: "main.tex", line: 3 }],
    citations: [{ key: "knuth1984", title: "Literate Programming", author: "Knuth", year: "1984", file: "refs.bib" }],
    macros: [{ name: "R", args: 0, file: "main.tex" }, { name: "norm", args: 1, file: "main.tex" }],
    environments: ["myproof"],
  },
  files: ["main.tex", "chapters/intro.tex", "figures/a.png", "figures/b.pdf", "refs.bib"],
};

describe("detectContext", () => {
  it("detects reference arguments", () => {
    expect(detectContext("veja \\ref{sec")).toEqual({ kind: "ref", command: "ref", from: 10, prefix: "sec" });
    expect(detectContext("\\eqref{")).toMatchObject({ kind: "ref", prefix: "" });
    expect(detectContext("\\cref{a,b, c")).toMatchObject({ kind: "ref", from: 11, prefix: "c" });
  });
  it("detects citations with optional args and lists", () => {
    expect(detectContext("\\cite[p.~3]{knu")).toMatchObject({ kind: "cite", prefix: "knu" });
    expect(detectContext("\\parencite[][]{a,kn")).toMatchObject({ kind: "cite", prefix: "kn" });
    expect(detectContext("\\textcite{")).toMatchObject({ kind: "cite", prefix: "" });
  });
  it("detects files, environments and commands", () => {
    expect(detectContext("\\includegraphics[width=3cm]{fig")).toMatchObject({ kind: "graphics", prefix: "fig" });
    expect(detectContext("\\input{chap")).toMatchObject({ kind: "input" });
    expect(detectContext("\\addbibresource{")).toMatchObject({ kind: "bib", command: "addbibresource" });
    expect(detectContext("  \\begin{ite")).toMatchObject({ kind: "begin", from: 9, prefix: "ite" });
    expect(detectContext("\\end{")).toMatchObject({ kind: "end" });
    expect(detectContext("texto \\sec")).toEqual({ kind: "command", from: 6, prefix: "\\sec" });
  });
  it("ignores comments, line breaks and unknown arguments", () => {
    expect(detectContext("% \\ref{")).toBeNull();
    expect(detectContext("a \\\\")).toBeNull();
    expect(detectContext("\\textbf{x")).toBeNull();
    expect(detectContext("plain text")).toBeNull();
  });
});

describe("innermostOpenEnv", () => {
  it("returns the innermost unclosed environment", () => {
    expect(innermostOpenEnv("\\begin{document}\n\\begin{itemize}\n\\item a\n")).toBe("itemize");
    expect(innermostOpenEnv("\\begin{document}\n\\begin{itemize}\\end{itemize}\n")).toBe("document");
    expect(innermostOpenEnv("% \\begin{x}\n")).toBeNull();
  });
});

describe("optionsFor", () => {
  const labels = (kind: Parameters<typeof detectContext>[0]) => {
    const ctx = detectContext(kind);
    if (!ctx) throw new Error("no ctx");
    return optionsFor(ctx, data, "itemize").map((o) => o.label);
  };
  it("offers project data", () => {
    expect(labels("\\ref{")).toEqual(["sec:intro"]);
    expect(labels("\\cite{")).toEqual(["knuth1984"]);
    expect(labels("\\includegraphics{")).toEqual(["figures/a.png", "figures/b.pdf"]);
    expect(labels("\\input{")).toEqual(["main", "chapters/intro"]);
    expect(labels("\\bibliography{")).toEqual(["refs"]);
    expect(labels("\\addbibresource{")).toEqual(["refs.bib"]);
  });
  it("includes project environments and macros", () => {
    expect(labels("\\begin{")).toContain("myproof");
    expect(labels("\\begin{")).toContain("itemize");
    const cmds = labels("\\");
    expect(cmds.slice(0, 2)).toEqual(["\\R", "\\norm"]);
    expect(cmds).toContain("\\section");
  });
  it("knows abnTeX2", () => {
    expect(detectContext("\\citeonline{kn")).toMatchObject({ kind: "cite", prefix: "kn" });
    expect(detectContext("\\apud[p. 2]{")).toMatchObject({ kind: "cite" });
    expect(labels("\\citeonline{")).toEqual(["knuth1984"]);
    expect(labels("\\begin{")).toEqual(expect.arrayContaining(["resumo", "citacao", "siglas", "apendicesenv"]));
    expect(labels("\\")).toEqual(expect.arrayContaining(["\\citeonline", "\\imprimircapa", "\\fonte", "\\orientador"]));
    expect(labels("\\usepackage{")).toContain("abntex2cite");
  });
  it("boosts the environment to close", () => {
    const ctx = detectContext("\\end{");
    const opts = ctx ? optionsFor(ctx, data, "itemize") : [];
    expect(opts.find((o) => o.label === "itemize")?.boost).toBe(99);
  });
});
