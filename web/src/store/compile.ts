import { create } from "zustand";
import { api, ApiError } from "../api/client";
import type { CompileResult, Problem, SyncForward } from "../api/types";
import type { Zoom } from "../pdf/PdfDocument";
import { useEditor } from "./editor";
import { usePrefs } from "./prefs";
import { countLive, useLive } from "./live";
import { activeEditor, applyToState, applyToView, compileStartEffect, diagnosticHooks, resetApplied, setProblems } from "../editor/diagnostics";

interface CompileStore {
  compiling: boolean;
  result: CompileResult | null;
  /** Request-level failure (no result), e.g. latexmk missing. */
  error: string | null;
  /** Build whose PDF is displayed (the last one that produced a PDF). */
  pdfBuildId: string | null;
  logsOpen: boolean;
  logsTab: "problems" | "raw";
  zoom: Zoom;
  scale: number;
  page: number;
  numPages: number;
  highlight: (SyncForward & { nonce: number }) | null;
  /** Problem to scroll to and highlight in the logs ("Ver no log"). */
  focus: { problem: Problem; nonce: number } | null;
  /**
   * Build whose errors the pop-up over the PDF shows (null = hidden). Set by
   * manual compilations; live ones only keep an open pop-up up to date.
   */
  alert: string | null;

  set: (patch: Partial<CompileStore>) => void;
  reset: () => void;
}

const initial = {
  compiling: false,
  result: null,
  error: null,
  pdfBuildId: null,
  logsOpen: false,
  logsTab: "problems" as const,
  page: 1,
  numPages: 0,
  highlight: null,
  focus: null,
  alert: null,
};

export const useCompile = create<CompileStore>((set) => ({
  ...initial,
  zoom: "fit-width",
  scale: 1,
  set: (patch) => set(patch),
  reset: () => set(initial),
}));

let controller: AbortController | null = null;

/** Save everything, then compile. A new call supersedes a running one. */
export async function compileProject(projectId: string, opts: { clean?: boolean; auto?: boolean } = {}): Promise<CompileResult | null> {
  controller?.abort();
  const ctl = new AbortController();
  controller = ctl;
  const store = useCompile.getState();
  store.set({ compiling: true, error: null });
  try {
    const { docs } = useEditor.getState();
    // Remember each doc as compiled: results come back in its line numbers
    // while the user may keep typing.
    if (docs) {
      for (const path of docs.paths()) {
        if (path === activeEditor.path && activeEditor.view) activeEditor.view.dispatch({ effects: compileStartEffect() });
        else docs.transform(path, (st) => st.update({ effects: compileStartEffect() }).state);
      }
    }
    await docs?.flushAll();
    const prefs = usePrefs.getState();
    const result = await api.compile(
      projectId,
      {
        compiler: prefs.compilerOverride ?? undefined,
        draft: prefs.draft,
        stopOnFirstError: prefs.stopOnFirstError,
        clean: opts.clean || undefined,
      },
      ctl.signal,
    );
    if (controller !== ctl || result.status === "canceled") return null;
    publish(result, Boolean(opts.auto));
    return result;
  } catch (err) {
    if (controller !== ctl || (err instanceof DOMException && err.name === "AbortError")) return null;
    useCompile.getState().set({
      error: err instanceof ApiError || err instanceof Error ? err.message : String(err),
      logsOpen: true,
    });
    return null;
  } finally {
    if (controller === ctl) {
      controller = null;
      useCompile.getState().set({ compiling: false });
    }
  }
}

function publish(result: CompileResult, auto: boolean) {
  const s = useCompile.getState();
  const noPdf = !result.pdfAvailable;
  const hasErrors = result.problems.some((p) => p.level === "error");
  s.set({
    result,
    pdfBuildId: result.pdfAvailable ? result.buildId : s.pdfBuildId,
    // Without a fresh PDF the problems are what matters — but live
    // compilations while typing never take over the PDF view.
    logsOpen: noPdf && !auto ? true : s.logsOpen,
    logsTab: noPdf && !auto ? "problems" : s.logsTab,
    alert: hasErrors && (!auto || s.alert !== null) ? result.buildId : null,
  });
  // Editor markers.
  setProblems(result.buildId, result.problems);
  resetApplied();
  const { docs } = useEditor.getState();
  if (docs) {
    for (const path of docs.paths()) {
      if (path === activeEditor.path && activeEditor.view) applyToView(activeEditor.view, path);
      else docs.transform(path, (st) => applyToState(st, path));
    }
  }
}

/** Open the logs on one problem (from the editor pop-ups). */
export function showProblemInLogs(problem: Problem) {
  useCompile.getState().set({ logsOpen: true, logsTab: "problems", focus: { problem, nonce: Date.now() } });
}
diagnosticHooks.showInLogs = showProblemInLogs;

export function countProblems(problems: Problem[] | undefined) {
  let errors = 0;
  let warnings = 0;
  let typesetting = 0;
  for (const p of problems ?? []) {
    if (p.level === "error") errors++;
    else if (p.level === "warning") warnings++;
    else typesetting++;
  }
  return { errors, warnings, typesetting };
}

/** Worst problem level per file (for tree markers). */
export function problemFiles(problems: Problem[] | undefined): Map<string, "error" | "warning"> {
  const m = new Map<string, "error" | "warning">();
  for (const p of problems ?? []) {
    if (!p.file || p.level === "typesetting") continue;
    if (p.level === "error") m.set(p.file, "error");
    else if (!m.has(p.file)) m.set(p.file, "warning");
  }
  return m;
}

// ------------------------------------------------------------ auto-compile

let autoTimer: number | null = null;

/**
 * Called after each successful save (the editor saves 1 s after typing
 * stops). With auto-compile on, compiles shortly after the last save, never overlapping a running compilation
 * (if one is running, it retries shortly after).
 */
export function scheduleAutoCompile(projectId: string, delayMs = 800) {
  if (!usePrefs.getState().autoCompile) return;
  if (autoTimer !== null) window.clearTimeout(autoTimer);
  autoTimer = window.setTimeout(() => {
    autoTimer = null;
    if (useCompile.getState().compiling) scheduleAutoCompile(projectId, 1000);
    // Half-typed code (an unclosed brace…) would only produce noise: wait
    // until the live check of the open file has no errors.
    else if (autoCompilePaused()) return;
    // Typed again since that save: its own save schedules the next compile
    // (compiling now would flush half-typed text before the live check runs).
    else if (useEditor.getState().docs?.isDirty()) return;
    else void compileProject(projectId, { auto: true });
  }, delayMs);
}

/** Live compilation waits while the open file has syntax errors. */
export function autoCompilePaused(): boolean {
  return countLive(useLive.getState().issues).errors > 0;
}

export function cancelAutoCompile() {
  if (autoTimer !== null) window.clearTimeout(autoTimer);
  autoTimer = null;
}
