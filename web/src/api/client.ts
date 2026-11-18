import { filenameFromDisposition, parseWarningsHeader } from "../lib/download";
import type {
  Capabilities,
  CompileOptions,
  CompileResult,
  CreateProjectResponse,
  ProjectIndex,
  ProjectMeta,
  SyncForward,
  SyncInverse,
  TreeNode,
  WordCount,
} from "./types";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/** Encode a project-relative path for use in a URL, keeping the slashes. */
export function encodePath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

const base = (id: string) => `/api/projects/${encodeURIComponent(id)}`;

async function parseError(res: Response): Promise<ApiError> {
  try {
    const body: unknown = await res.json();
    if (body && typeof body === "object" && "error" in body) {
      const err = (body as { error: { code?: string; message?: string } }).error;
      return new ApiError(res.status, err.code ?? "unknown", err.message ?? res.statusText);
    }
  } catch {
    /* not JSON */
  }
  return new ApiError(res.status, "http_" + res.status, res.statusText || "Erro de rede");
}

interface RequestOptions {
  body?: BodyInit | null;
  json?: unknown;
  signal?: AbortSignal;
}

async function raw(method: string, url: string, opts: RequestOptions = {}): Promise<Response> {
  const headers: Record<string, string> = {};
  // Required by the server's CSRF guard on non-GET requests.
  if (method !== "GET") headers["X-Texdesk"] = "1";
  let body = opts.body ?? null;
  if (opts.json !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(opts.json);
  }
  const res = await fetch(url, { method, headers, body, signal: opts.signal });
  if (!res.ok) throw await parseError(res);
  return res;
}

async function json<T>(method: string, url: string, opts: RequestOptions = {}): Promise<T> {
  const res = await raw(method, url, opts);
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

/** Upload with progress reporting (fetch cannot report upload progress). */
function uploadWithProgress<T>(url: string, form: FormData, onProgress?: (fraction: number) => void): Promise<T> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", url);
    xhr.setRequestHeader("X-Texdesk", "1");
    xhr.responseType = "json";
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total);
    };
    xhr.onload = () => {
      const body = xhr.response as unknown;
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(body as T);
        return;
      }
      const err =
        body && typeof body === "object" && "error" in body
          ? (body as { error: { code: string; message: string } }).error
          : { code: "http_" + xhr.status, message: xhr.statusText || "Falha no upload" };
      reject(new ApiError(xhr.status, err.code, err.message));
    };
    xhr.onerror = () => reject(new ApiError(0, "network", "Falha de rede durante o upload"));
    xhr.send(form);
  });
}

export const api = {
  capabilities: () => json<Capabilities>("GET", "/api/capabilities"),

  listProjects: () => json<ProjectMeta[]>("GET", "/api/projects"),
  getProject: (id: string) => json<ProjectMeta>("GET", base(id)),
  createBlank: (name: string) =>
    json<CreateProjectResponse>("POST", "/api/projects", { json: { name, template: "blank" } }),
  importZip: (file: File, onProgress?: (f: number) => void) => {
    const form = new FormData();
    form.append("name", file.name.replace(/\.zip$/i, ""));
    form.append("file", file);
    return uploadWithProgress<CreateProjectResponse>("/api/projects", form, onProgress);
  },
  updateProject: (id: string, patch: Partial<Pick<ProjectMeta, "name" | "mainFile" | "compiler">>) =>
    json<ProjectMeta>("PATCH", base(id), { json: patch }),
  deleteProject: (id: string) => json<void>("DELETE", base(id)),

  tree: (id: string) => json<TreeNode>("GET", `${base(id)}/tree`),
  fileUrl: (id: string, path: string) => `${base(id)}/files/${encodePath(path)}`,
  readText: async (id: string, path: string, signal?: AbortSignal) =>
    (await raw("GET", `${base(id)}/files/${encodePath(path)}`, { signal })).text(),
  writeText: (id: string, path: string, content: string) =>
    json<{ path: string }>("PUT", `${base(id)}/files/${encodePath(path)}`, { body: content }),
  createEntry: (id: string, path: string, type: "file" | "folder") =>
    json<{ path: string }>("POST", `${base(id)}/files`, { json: { path, type } }),
  rename: (id: string, path: string, newPath: string) =>
    json<{ path: string }>("PATCH", `${base(id)}/files/${encodePath(path)}`, { json: { newPath } }),
  remove: (id: string, path: string) => json<void>("DELETE", `${base(id)}/files/${encodePath(path)}`),
  upload: (id: string, dir: string, files: File[], onProgress?: (f: number) => void) => {
    const form = new FormData();
    form.append("dir", dir);
    for (const f of files) {
      form.append("files", f);
      // webkitRelativePath is set for folder uploads; multipart filenames lose directories.
      form.append("paths", f.webkitRelativePath || f.name);
    }
    return uploadWithProgress<{ uploaded: string[]; skipped: string[] }>(`${base(id)}/upload`, form, onProgress);
  },

  compile: (id: string, opts: CompileOptions, signal?: AbortSignal) =>
    json<CompileResult>("POST", `${base(id)}/compile`, { json: opts, signal }),
  pdfUrl: (id: string, buildId: string) => `${base(id)}/compile/${encodeURIComponent(buildId)}/pdf`,
  syncForward: (id: string, buildId: string, file: string, line: number, col: number) =>
    json<SyncForward>(
      "GET",
      `${base(id)}/synctex/forward?${new URLSearchParams({ buildId, file, line: String(line), col: String(col) })}`,
    ),
  syncInverse: (id: string, buildId: string, page: number, x: number, y: number) =>
    json<SyncInverse>(
      "GET",
      `${base(id)}/synctex/inverse?${new URLSearchParams({ buildId, page: String(page), x: x.toFixed(2), y: y.toFixed(2) })}`,
    ),
  wordCount: (id: string) => json<WordCount>("GET", `${base(id)}/wordcount`),
  index: (id: string) => json<ProjectIndex>("GET", `${base(id)}/index`),

  exportUrl: (id: string, kind: "pdf" | "zip" | "md") => `${base(id)}/export/${kind}`,
  /** Markdown export: fetched (not a plain link) to read the warnings header. */
  exportMarkdown: async (id: string, signal?: AbortSignal) => {
    const res = await fetch(`${base(id)}/export/md`, { signal });
    if (!res.ok) throw await parseError(res);
    return {
      blob: await res.blob(),
      filename: filenameFromDisposition(res.headers.get("Content-Disposition"), "documento.md"),
      warnings: parseWarningsHeader(res.headers.get("X-Texdesk-Warnings")),
      media: Number(res.headers.get("X-Texdesk-Media") ?? 0),
    };
  },
};
