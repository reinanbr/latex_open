import { create } from "zustand";
import type { DocManager, SaveStatus } from "../editor/docs";
import type { Section } from "../lib/latexStructure";

export interface GotoRequest {
  path: string;
  line: number;
  col?: number;
  /** Briefly highlight the target line (SyncTeX). */
  flash?: boolean;
  nonce: number;
}

interface EditorStore {
  projectId: string | null;
  docs: DocManager | null;
  tabs: string[];
  active: string | null;
  saveStatus: Record<string, SaveStatus>;
  saveError: string | null;
  cursor: { line: number; col: number } | null;
  goto: GotoRequest | null;
  /** Bumped when a document was replaced from the server (view must reload). */
  reloaded: Record<string, number>;
  /** Sections of the active document (null for non-LaTeX files). */
  outline: { path: string; sections: Section[] } | null;

  init: (projectId: string, docs: DocManager) => void;
  open: (path: string, at?: { line: number; col?: number; flash?: boolean }) => void;
  close: (path: string) => void;
  setActive: (path: string | null) => void;
  renamePath: (from: string, to: string) => void;
  removePath: (path: string) => void;
  setSaveStatus: (path: string, status: SaveStatus, error?: string) => void;
  setCursor: (c: { line: number; col: number } | null) => void;
  markReloaded: (path: string) => void;
  setOutline: (o: { path: string; sections: Section[] } | null) => void;
}

let gotoSeq = 0;

const under = (p: string, root: string) => p === root || p.startsWith(root + "/");

export const useEditor = create<EditorStore>((set, get) => ({
  projectId: null,
  docs: null,
  tabs: [],
  active: null,
  saveStatus: {},
  saveError: null,
  cursor: null,
  goto: null,
  reloaded: {},
  outline: null,

  init: (projectId, docs) =>
    set({ projectId, docs, tabs: [], active: null, saveStatus: {}, saveError: null, cursor: null, goto: null, reloaded: {}, outline: null }),

  open: (path, at) => {
    const { tabs } = get();
    set({
      tabs: tabs.includes(path) ? tabs : [...tabs, path],
      active: path,
      goto: at ? { path, line: at.line, col: at.col, flash: at.flash, nonce: ++gotoSeq } : get().goto,
    });
  },

  close: (path) => {
    const { tabs, active, docs } = get();
    const idx = tabs.indexOf(path);
    const next = tabs.filter((t) => t !== path);
    let nextActive = active;
    if (active === path) nextActive = next[Math.min(idx, next.length - 1)] ?? null;
    set({ tabs: next, active: nextActive });
    void docs?.close(path);
  },

  setActive: (active) => set({ active }),

  renamePath: (from, to) => {
    const map = (p: string) => (under(p, from) ? to + p.slice(from.length) : p);
    const { tabs, active, saveStatus } = get();
    const status: Record<string, SaveStatus> = {};
    for (const [k, v] of Object.entries(saveStatus)) status[map(k)] = v;
    set({ tabs: tabs.map(map), active: active ? map(active) : null, saveStatus: status });
  },

  removePath: (path) => {
    const { tabs, active, docs, saveStatus } = get();
    const next = tabs.filter((t) => !under(t, path));
    const status = Object.fromEntries(Object.entries(saveStatus).filter(([k]) => !under(k, path)));
    set({ tabs: next, active: active && under(active, path) ? (next[next.length - 1] ?? null) : active, saveStatus: status });
    docs?.drop(path);
  },

  setSaveStatus: (path, status, error) =>
    set((s) => ({
      saveStatus: { ...s.saveStatus, [path]: status },
      saveError: status === "error" ? (error ?? "erro") : status === "saved" ? null : s.saveError,
    })),

  setCursor: (cursor) => set({ cursor }),
  setOutline: (outline) => set({ outline }),
  markReloaded: (path) => set((s) => ({ reloaded: { ...s.reloaded, [path]: (s.reloaded[path] ?? 0) + 1 } })),
}));

/** Aggregate save state for the status indicator. */
export function overallSaveStatus(map: Record<string, SaveStatus>): SaveStatus {
  const v = Object.values(map);
  if (v.includes("error")) return "error";
  if (v.includes("saving")) return "saving";
  if (v.includes("dirty")) return "dirty";
  return "saved";
}
