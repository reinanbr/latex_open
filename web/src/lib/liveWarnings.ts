/**
 * Live warnings that do not need a compilation: references and citations to
 * keys that do not exist, figures and included files missing from the
 * project, and labels defined twice. Checked against the project index (the
 * other files, refreshed after each save) plus the text being edited.
 */
import { stripComment, VERBATIM_ENVS } from "./latexStructure";

export interface LiveWarning {
  from: number;
  to: number;
  message: string;
}

export interface ProjectRefs {
  /**
   * Labels defined in the other files (from the index); null = not loaded
   * yet. This file's labels come from its live text.
   */
  labelsElsewhere: Set<string> | null;
  citations: Set<string> | null;
  files: string[] | null;
}

const IMAGE_EXT = [".pdf", ".png", ".jpg", ".jpeg", ".eps", ".ps", ".svg", ".gif", ".bmp", ".tif", ".tiff"];
const CMD = /\\([A-Za-z]+)\*?/g;

/** Does `name` match a project file (with one of `exts` when it has none)? */
function existsIn(files: string[], name: string, exts: string[]): boolean {
  const n = name.replace(/^\.\//, "");
  const candidates = /\.[A-Za-z0-9]+$/.test(n) ? [n] : [n, ...exts.map((e) => n + e)];
  return files.some((f) => candidates.some((c) => f === c || f.endsWith("/" + c)));
}

export function checkReferences(text: string, refCommands: Set<string>, citeCommands: Set<string>, project: ProjectRefs): LiveWarning[] {
  const out: LiveWarning[] = [];
  const localLabels = new Map<string, number[]>();
  const refs: { key: string; from: number }[] = [];
  const cites: { key: string; from: number }[] = [];
  const files: { kind: "figure" | "tex"; name: string; from: number }[] = [];

  let offset = 0;
  let verbatim: string | null = null;
  for (const raw of text.split("\n")) {
    const lineStart = offset;
    offset += raw.length + 1;
    if (verbatim) {
      const end = new RegExp(`\\\\end\\s*\\{${verbatim.replace("*", "\\*")}\\}`).exec(raw);
      if (end) verbatim = null;
      continue;
    }
    const line = stripComment(raw);
    const vb = /\\begin\s*\{([^}]+)\}/.exec(line);
    if (vb && VERBATIM_ENVS.has(vb[1]!) && !new RegExp(`\\\\end\\s*\\{${vb[1]!.replace("*", "\\*")}\\}`).test(line)) {
      verbatim = vb[1]!;
    }
    CMD.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = CMD.exec(line))) {
      const name = m[1]!;
      // Optional arguments, then the first mandatory one.
      const rest = /^\s*(?:\[[^\]]*\]\s*)*\{([^{}]*)\}/.exec(line.slice(m.index + m[0].length));
      if (!rest) continue;
      const arg = rest[1]!;
      const argStart = lineStart + m.index + m[0].length + rest[0].length - arg.length - 1;
      if (arg.includes("#") || arg.includes("\\")) continue; // inside a macro definition
      const keys = () => {
        const list: { key: string; from: number }[] = [];
        let pos = 0;
        for (const part of arg.split(",")) {
          const key = part.trim();
          if (key) list.push({ key, from: argStart + pos + part.indexOf(key) });
          pos += part.length + 1;
        }
        return list;
      };
      if (name === "label") {
        const k = arg.trim();
        if (k) localLabels.set(k, [...(localLabels.get(k) ?? []), argStart + arg.indexOf(k)]);
      } else if (refCommands.has(name)) refs.push(...keys());
      else if (citeCommands.has(name)) cites.push(...keys().filter((c) => c.key !== "*"));
      else if (name === "includegraphics") files.push({ kind: "figure", name: arg.trim(), from: argStart });
      // \input may also load files of the TeX distribution (\input{glyphtounicode}):
      // only check it when it clearly points into the project.
      else if (name === "include" || name === "subfile" || (name === "input" && (arg.includes("/") || arg.trim().endsWith(".tex"))))
        files.push({ kind: "tex", name: arg.trim(), from: argStart });
    }
  }

  for (const [key, positions] of localLabels) {
    if (positions.length > 1) {
      for (const from of positions) out.push({ from, to: from + key.length, message: `O rótulo "${key}" está definido mais de uma vez neste arquivo; as referências podem apontar para o lugar errado.` });
    }
  }
  if (project.labelsElsewhere) {
    for (const r of refs) {
      if (!localLabels.has(r.key) && !project.labelsElsewhere.has(r.key)) {
        out.push({ from: r.from, to: r.from + r.key.length, message: `Referência a um rótulo inexistente: não há \\label{${r.key}} no projeto.` });
      }
    }
  }
  if (project.citations) {
    const noBib = project.citations.size === 0;
    for (const c of cites) {
      if (!project.citations.has(c.key)) {
        out.push({
          from: c.from,
          to: c.from + c.key.length,
          message: noBib ? `Citação de "${c.key}", mas o projeto não tem entradas em arquivos .bib.` : `A chave de citação "${c.key}" não existe nos arquivos .bib do projeto.`,
        });
      }
    }
  }
  if (project.files) {
    for (const f of files) {
      if (!f.name) continue;
      const ok = existsIn(project.files, f.name, f.kind === "figure" ? IMAGE_EXT : [".tex"]);
      if (!ok) {
        out.push({
          from: f.from,
          to: f.from + f.name.length,
          message: f.kind === "figure" ? `Figura não encontrada no projeto: "${f.name}".` : `Arquivo não encontrado no projeto: "${f.name}".`,
        });
      }
    }
  }
  return out.sort((a, b) => a.from - b.from);
}
