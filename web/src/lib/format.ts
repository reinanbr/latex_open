const rtf = new Intl.RelativeTimeFormat("pt-BR", { numeric: "auto" });

/** "há 5 minutos", "ontem", or a date for older entries. */
export function relativeTime(iso: string, now = Date.now()): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "";
  const diff = (t - now) / 1000;
  const abs = Math.abs(diff);
  if (abs < 45) return "agora mesmo";
  if (abs < 3600) return rtf.format(Math.round(diff / 60), "minute");
  if (abs < 86400) return rtf.format(Math.round(diff / 3600), "hour");
  if (abs < 7 * 86400) return rtf.format(Math.round(diff / 86400), "day");
  return new Date(t).toLocaleDateString("pt-BR", { day: "2-digit", month: "short", year: "numeric" });
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function basename(p: string): string {
  return p.slice(p.lastIndexOf("/") + 1);
}

export function dirname(p: string): string {
  const i = p.lastIndexOf("/");
  return i < 0 ? "" : p.slice(0, i);
}

export function extname(p: string): string {
  const b = basename(p);
  const i = b.lastIndexOf(".");
  return i <= 0 ? "" : b.slice(i + 1).toLowerCase();
}

export function joinPath(dir: string, name: string): string {
  return dir ? `${dir}/${name}` : name;
}

const TEXT_EXTS = new Set([
  "tex", "bib", "sty", "cls", "bst", "bbx", "cbx", "lbx", "dtx", "ins", "ltx", "txt", "md", "bbl",
  "clo", "def", "cfg", "fd", "rnw", "tikz", "pgf", "lua", "csv", "dat", "tsv", "latexmkrc",
  "gitignore", "ist", "gst", "json", "yaml", "yml", "xml", "asy", "mp",
]);
const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "svg", "webp", "bmp"]);

export type FileKind = "text" | "image" | "pdf" | "binary";

export function fileKind(path: string): FileKind {
  const ext = extname(path);
  if (ext === "") {
    const b = basename(path).toLowerCase();
    return ["latexmkrc", "makefile", "readme", "license"].includes(b) ? "text" : "binary";
  }
  if (TEXT_EXTS.has(ext)) return "text";
  if (IMAGE_EXTS.has(ext)) return "image";
  if (ext === "pdf") return "pdf";
  return "binary";
}
