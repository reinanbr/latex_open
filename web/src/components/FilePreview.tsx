import { useState } from "react";
import { api } from "../api/client";
import { basename, fileKind } from "../lib/format";
import { PdfDocument } from "../pdf/PdfDocument";

/** Preview for non-text files opened from the tree (images, PDFs, others). */
export function FilePreview({ projectId, path }: { projectId: string; path: string }) {
  const url = api.fileUrl(projectId, path);
  const kind = fileKind(path);
  const [dims, setDims] = useState<string>("");

  if (kind === "image") {
    return (
      <div className="file-preview">
        <img
          src={url}
          alt={basename(path)}
          onLoad={(e) => setDims(`${e.currentTarget.naturalWidth} × ${e.currentTarget.naturalHeight} px`)}
        />
        <div className="meta">
          {path} {dims && `· ${dims}`} ·{" "}
          <a href={`${url}?download=1`} download>
            baixar
          </a>
        </div>
      </div>
    );
  }
  if (kind === "pdf") {
    return (
      <div className="file-preview" style={{ padding: 0 }}>
        <PdfDocument url={url} />
      </div>
    );
  }
  return (
    <div className="editor-placeholder">
      <div>
        <p>
          <strong>{basename(path)}</strong> é um arquivo binário e não pode ser editado aqui.
        </p>
        <a className="btn" href={`${url}?download=1`} download>
          Baixar arquivo
        </a>
      </div>
    </div>
  );
}
