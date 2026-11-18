import { describe, expect, it } from "vitest";
import { closest, editDistance, LatexKB, packageInsertion, scanSource, specLabel, specSnippet, type KBData } from "./latexKB";
import { checkCommands, type CommandContext } from "./commandCheck";
import { scanLatex } from "./syntaxCheck";

export const FIXTURE: KBData = {
  generated: "test",
  engine: "LuaLaTeX",
  kernel: { cmds: "documentclass usepackage verb begin:m end:m textbf:m textit:m emph:m newcommand item label:m ref:m relax def let hbox", envs: "document itemize enumerate center verbatim tabular:m" },
  classes: {
    article: { cmds: "section:so? subsection:so? maketitle today", envs: "figure table abstract" },
    report: { cmds: "chapter:so? section:so? maketitle today", envs: "figure table abstract" },
    memoir: { cmds: "chapter:so? section:so?", envs: "figure table", deps: ["array"] },
    abntex2: { cmds: "imprimircapa titulo:m", envs: "resumo citacao:o?", classes: ["memoir"], deps: ["hyperref"] },
  },
  packages: {
    graphics: { cmds: "includegraphics:s? graphicspath:m rotatebox", envs: "" },
    graphicx: { cmds: "", envs: "", deps: ["graphics", "keyval"] },
    keyval: { cmds: "setkeys:mm", envs: "" },
    color: { cmds: "textcolor:mm color", envs: "" },
    xcolor: { cmds: "colorlet:mm", envs: "testcolors:o?", deps: ["color"] },
    amsmath: { cmds: "eqref:m dfrac text:m", envs: "align align* gather", hidden: "placeholder" },
    tikz: { cmds: "tikz draw node fill", envs: "tikzpicture", deps: ["graphicx", "xcolor"] },
    hyperref: { cmds: "href:mm url autoref:s", envs: "" },
    array: { cmds: "newcolumntype:mo?", envs: "" },
  },
  failed: { siunitx: "not found" },
};

const kb = () => new LatexKB(FIXTURE);

describe("LatexKB", () => {
  it("collects the closure of classes and packages", () => {
    const s = kb().scope(["abntex2"], ["tikz"]);
    for (const c of ["imprimircapa", "chapter", "newcolumntype", "href", "draw", "includegraphics", "textcolor", "setkeys", "textbf"]) {
      expect(s.cmds.has(c), c).toBe(true);
    }
    expect(s.envs.has("resumo") && s.envs.has("tikzpicture") && s.envs.has("document")).toBe(true);
    expect(s.cmds.get("chapter")?.source).toBe("classe memoir");
    expect(s.unknown).toEqual([]);
    expect(kb().scope(["article"], ["siunitx", "meu"]).unknown).toEqual(["siunitx", "meu"]);
  });

  it("proposes the common package for a missing command", () => {
    // graphics defines it, but graphicx is the one people load.
    expect(kb().provider("includegraphics", "command")).toEqual({ package: "graphicx" });
    expect(kb().provider("textcolor", "command")).toEqual({ package: "xcolor" });
    expect(kb().provider("align", "env")).toEqual({ package: "amsmath" });
    expect(kb().provider("chapter", "command")).toEqual({ classes: ["report", "memoir"] });
    expect(kb().provider("nada", "command")).toBeNull();
  });

  it("turns signatures into snippets and labels", () => {
    expect(specSnippet("mm")).toBe("{#{}}{#{}}");
    expect(specSnippet("som")).toBe("{#{}}");
    expect(specSnippet("o?")).toBeNull();
    expect(specSnippet("")).toBeNull();
    expect(specLabel("section", "som")).toBe("\\section*[…]{…}");
  });
});

describe("typo suggestions", () => {
  it("measures edits with transpositions", () => {
    expect(editDistance("textbf", "textbf", 2)).toBe(0);
    expect(editDistance("textbff", "textbf", 2)).toBe(1);
    expect(editDistance("lable", "label", 2)).toBe(1);
    expect(editDistance("abc", "xyzw", 2)).toBe(3);
  });
  it("ranks the closest names", () => {
    expect(closest("textbff", ["textbf", "textit", "texttt"])).toEqual(["textbf"]);
    expect(closest("Textbf", ["textbf", "textsf"])[0]).toBe("textbf");
    expect(closest("lable", ["label", "table", "cable"], new Set(["label"]))[0]).toBe("label");
    expect(closest("xy", ["xz"])).toEqual([]);
  });
});

describe("scanSource", () => {
  it("finds classes, packages and definitions", () => {
    const f = scanSource(String.raw`\documentclass[12pt]{abntex2}
\usepackage[T1]{fontenc}
\usepackage{amsmath,
  graphicx}
% \usepackage{comentado}
\newcommand{\R}{\mathbb{R}}
\def\a{4.2}
\let\velho\section
\newif\ifrascunho
\newcounter{passo}
\newenvironment{caixa}{}{}
\lstnewenvironment{codigo}{}{}
\begin{tikzpicture}
\foreach \x/\y in {1/2} {}
\pgfmathsetmacro{\raio}{2}
\draw plot[domain=0:1, variable=\t] (\t, \t);
\foreach \p [count=\i, evaluate=\p as \q using \p*2] in {1,2} {}
\end{tikzpicture}
\newlistof{listofquadros}{loq}{Lista de quadros}`);
    expect(f.classes).toEqual(["abntex2"]);
    expect(f.packages).toEqual(["fontenc", "amsmath", "graphicx"]);
    for (const c of ["R", "a", "velho", "ifrascunho", "rascunhotrue", "thepasso", "x", "y", "raio", "t", "i", "q", "listofquadros"]) expect(f.commands.has(c), c).toBe(true);
    expect([...f.envs].sort()).toEqual(["caixa", "codigo"]);
    expect([...f.verbatimEnvs]).toEqual(["codigo"]);
    expect(f.dynamic).toBe(false);
    expect(scanSource(String.raw`\expandafter\def\csname x\endcsname{}`).dynamic).toBe(true);
  });
});

describe("packageInsertion", () => {
  const doc = "\\documentclass{article}\n\\usepackage{amsmath} % math\n\n\\begin{document}\noi\n\\end{document}\n";
  it("adds after the last package", () => {
    const at = packageInsertion(doc, "graphicx")!;
    const out = doc.slice(0, at.from) + at.insert + doc.slice(at.from);
    expect(out).toContain("\\usepackage{amsmath} % math\n\\usepackage{graphicx}\n");
  });
  it("adds after \\documentclass when there are no packages", () => {
    const d = "\\documentclass[\n  a4paper\n]{article}\n\\begin{document}\n\\end{document}";
    const at = packageInsertion(d, "xcolor")!;
    expect(d.slice(0, at.from) + at.insert + d.slice(at.from)).toBe("\\documentclass[\n  a4paper\n]{article}\n\\usepackage{xcolor}\n\\begin{document}\n\\end{document}");
  });
  it("does nothing when loaded or without a preamble", () => {
    expect(packageInsertion(doc, "amsmath")).toBeNull();
    expect(packageInsertion("só texto \\textbf{x}", "graphicx")).toBeNull();
  });
});

describe("checkCommands", () => {
  const text = String.raw`\documentclass{article}
\usepackage{amsmath}
\newcommand{\R}{\mathbb{R}}
\begin{document}
\textbff{a} \includegraphics{x} \R \eqref{e} \chapter{C}
\begin{align} \end{align}
\begin{tikzpicture}\end{tikzpicture}
\begin{itemise}\end{itemise}
\verb|\naoverifica| \pdfoutput % \comentario
\begin{verbatim}
\tambemnao
\end{verbatim}
\end{document}`;
  const cx = (): CommandContext => {
    const k = kb();
    const f = scanSource(text);
    return { kb: k, scope: k.scope(f.classes, f.packages), commands: f.commands, envs: f.envs, classes: f.classes };
  };
  const run = (c = cx()) => checkCommands(scanLatex(text).uses, c).map((w) => ({ text: text.slice(w.from, w.to), msg: w.message, fixes: w.fixes.map((f) => f.label) }));

  it("reports unknown commands and environments with fixes", () => {
    const got = run();
    expect(got.map((g) => g.text)).toEqual(["\\textbff", "\\includegraphics", "\\chapter", "tikzpicture", "itemise"]);
    expect(got[0]!.msg).toContain("Você quis dizer \\textbf?");
    expect(got[0]!.fixes[0]).toBe("Trocar por \\textbf");
    expect(got[1]!.msg).toContain("pacote graphicx");
    expect(got[1]!.fixes).toEqual(["Adicionar \\usepackage{graphicx}"]);
    expect(got[2]!.msg).toContain("classes report, memoir");
    expect(got[3]!.fixes).toEqual(["Adicionar \\usepackage{tikz}"]);
    expect(got[4]!.fixes[0]).toBe("Trocar por {itemize}");
  });

  it("skips the word being typed", () => {
    const at = text.indexOf("\\textbff") + 4;
    expect(run({ ...cx(), cursor: at }).map((g) => g.text)).not.toContain("\\textbff");
  });
});
