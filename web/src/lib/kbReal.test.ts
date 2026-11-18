// The generated knowledge base against real documents: no false alarms on
// the repository's sample projects (and on any extra file listed in
// TEXDESK_KB_DOCS, e.g. a thesis, for manual checks).
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { LatexKB, scanSource, type KBData } from "./latexKB";
import { checkCommands } from "./commandCheck";
import { scanLatex } from "./syntaxCheck";

const ROOT = resolve(__dirname, "../../..");
const data = JSON.parse(readFileSync(resolve(__dirname, "../data/latex-kb.json"), "utf8")) as KBData;
const kb = new LatexKB(data);

function texFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? texFiles(p) : /\.(tex|sty|cls)$/.test(f) ? [p] : [];
  });
}

/** Unknown commands in a project (all its files share classes, packages and definitions). */
function check(files: string[]) {
  const texts = files.map((f) => readFileSync(f, "utf8"));
  const facts = texts.map(scanSource);
  const classes = facts.flatMap((f) => f.classes).filter((c) => c !== "subfiles");
  const packages = facts.flatMap((f) => f.packages);
  const commands = new Set(facts.flatMap((f) => [...f.commands]));
  const envs = new Set(facts.flatMap((f) => [...f.envs]));
  const verbatimEnvs = facts.flatMap((f) => [...f.verbatimEnvs]);
  const scope = kb.scope(classes, packages);
  expect(scope.unknown).toEqual([]);
  return texts.flatMap((t, i) =>
    checkCommands(scanLatex(t, { verbatimEnvs }).uses, { kb, scope, commands, envs, classes }).map((w) => `${files[i]}: ${t.slice(w.from, w.to)} — ${w.message}`),
  );
}

describe("generated knowledge base", () => {
  it("knows the kernel, the common classes and packages", () => {
    const s = kb.scope(["article"], ["amsmath", "graphicx", "hyperref", "tikz", "booktabs", "listings"]);
    for (const c of ["textbf", "section", "includegraphics", "href", "draw", "node", "toprule", "lstinline", "frac", "eqref", "pdfoutput", "XeTeXlinebreaklocale", "directlua"]) {
      expect(s.cmds.has(c) || s.hidden.has(c) || /^(pdf|XeTeX|lua)/.test(c), c).toBe(true);
    }
    for (const e of ["document", "itemize", "figure", "align", "tikzpicture", "lstlisting", "tabular"]) expect(s.envs.has(e), e).toBe(true);
    expect(kb.provider("includegraphics", "command")).toEqual({ package: "graphicx" });
    expect(kb.provider("toprule", "command")).toEqual({ package: "booktabs" });
    expect(kb.provider("textcolor", "command")).toEqual({ package: "xcolor" });
    expect(kb.scope(["abntex2"], ["abntex2cite"]).cmds.has("citeonline")).toBe(true);
  });

  for (const project of ["sample-project", "abntex2-project"]) {
    it(`no false alarms in testdata/${project}`, () => {
      expect(check(texFiles(join(ROOT, "testdata", project)))).toEqual([]);
    });
  }

  const extra = (process.env.TEXDESK_KB_DOCS ?? "").split(":").filter((p) => p && existsSync(p));
  it.runIf(extra.length > 0)("no false alarms in TEXDESK_KB_DOCS", () => {
    expect(check(extra.flatMap((p) => (statSync(p).isDirectory() ? texFiles(p) : [p])))).toEqual([]);
  });
});
