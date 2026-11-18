export type Compiler = "pdflatex" | "latex" | "xelatex" | "lualatex";

export const COMPILERS: readonly Compiler[] = ["pdflatex", "latex", "xelatex", "lualatex"];

export const COMPILER_LABEL: Record<Compiler, string> = {
  pdflatex: "pdfLaTeX",
  latex: "LaTeX (DVI → PDF)",
  xelatex: "XeLaTeX",
  lualatex: "LuaLaTeX",
};

export interface ProjectMeta {
  id: string;
  name: string;
  mainFile: string;
  compiler: Compiler;
  createdAt: string;
  updatedAt: string;
  lastAccess: string;
}

export interface CreateProjectResponse {
  project: ProjectMeta;
  warnings: string[];
}

export interface TreeNode {
  name: string;
  path: string;
  type: "file" | "folder";
  size?: number;
  modTime: string;
  children?: TreeNode[];
}

export interface Tool {
  available: boolean;
  path?: string;
  version?: string;
  reason?: string;
}

export interface Capabilities {
  latexmk: Tool;
  pdflatex: Tool;
  latex: Tool;
  xelatex: Tool;
  lualatex: Tool;
  synctex: Tool;
  pandoc: Tool;
  texcount: Tool;
  pdftoppm: Tool;
  gs: Tool;
}

export type ProblemLevel = "error" | "warning" | "typesetting";

export interface Problem {
  level: ProblemLevel;
  file?: string;
  line?: number;
  /** File name when the problem is not in a project source (e.g. "main.bbl"). */
  source?: string;
  message: string;
  raw: string;
}

export type CompileStatus = "success" | "error" | "timeout" | "canceled";

export interface CompileResult {
  status: CompileStatus;
  buildId: string;
  durationMs: number;
  pdfAvailable: boolean;
  log: string;
  /** latexmk console output (tail). */
  output: string;
  problems: Problem[];
  compiler: Compiler;
  mainFile: string;
  draft: boolean;
  startedAt: string;
}

export interface CompileOptions {
  compiler?: Compiler;
  draft?: boolean;
  stopOnFirstError?: boolean;
  /** Delete auxiliary files first ("recompile from scratch"). */
  clean?: boolean;
}

export interface SyncForward {
  page: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface SyncInverse {
  file: string;
  line: number;
  col: number;
}

export interface WordCount {
  words: number;
  headers: number;
  captions: number;
  math: number;
  source: "texcount" | "estimate";
}

export interface ProjectIndex {
  labels: { key: string; file: string; line: number }[];
  citations: { key: string; type?: string; title?: string; author?: string; year?: string; file: string }[];
  macros: { name: string; args: number; file: string }[];
  environments: string[];
  verbatimEnvironments?: string[];
  packages?: PackageUse[];
  classes?: PackageUse[];
  /** Commands defined with names built at run time (\csname): the command set is not fully known. */
  dynamic?: boolean;
}

/** A \documentclass, \usepackage or \RequirePackage of the project. */
export interface PackageUse {
  name: string;
  options?: string;
  file: string;
  line: number;
}
