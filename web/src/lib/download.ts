/** File name from a Content-Disposition header (RFC 6266, incl. filename*). */
export function filenameFromDisposition(header: string | null, fallback: string): string {
  if (!header) return fallback;
  const star = /filename\*\s*=\s*([^']*)'[^']*'([^;]+)/i.exec(header);
  if (star?.[2]) {
    try {
      return decodeURIComponent(star[2].trim());
    } catch {
      /* fall through */
    }
  }
  const plain = /filename\s*=\s*("((?:[^"\\]|\\.)*)"|[^;]+)/i.exec(header);
  if (plain) return (plain[2] ?? plain[1] ?? "").replace(/\\(.)/g, "$1").trim() || fallback;
  return fallback;
}

/** Warnings header of the Markdown export: URL-encoded JSON array. */
export function parseWarningsHeader(header: string | null): string[] {
  if (!header) return [];
  try {
    const v: unknown = JSON.parse(decodeURIComponent(header.replace(/\+/g, " ")));
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/** Hand a blob to the browser as a download. */
export function saveBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
