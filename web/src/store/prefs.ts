import { create } from "zustand";
import type { Compiler } from "../api/types";
import { loadJSON, readLS, writeLS } from "./ui";

export type Layout = "both" | "editor" | "pdf";

export interface Prefs {
  fontSize: number;
  lineWrap: boolean;
  keymap: "default" | "vim";
  autoCompile: boolean;
  draft: boolean;
  stopOnFirstError: boolean;
  /** Bumped when a default changes for existing users too. */
  version: number;
  /** Live syntax check in the editor (no compilation needed). */
  syntaxCheck: boolean;
  layout: Layout;
  /** Per-session compiler override; null = use the project's compiler. */
  compilerOverride: Compiler | null;
}

const DEFAULTS: Prefs = {
  fontSize: 14,
  lineWrap: true,
  keymap: "default",
  autoCompile: true,
  draft: false,
  stopOnFirstError: false,
  syntaxCheck: true,
  version: 2,
  layout: "both",
  compilerOverride: null,
};

const KEY = "texdesk.prefs";

interface PrefsState extends Prefs {
  set: (patch: Partial<Prefs>) => void;
}

function storedVersion(): number {
  try {
    const raw = readLS(KEY);
    return raw ? Number((JSON.parse(raw) as Partial<Prefs>).version ?? 1) : DEFAULTS.version;
  } catch {
    return DEFAULTS.version;
  }
}

function loadPrefs(): Prefs {
  const p = loadJSON<Prefs>(KEY, DEFAULTS);
  // v2: compilation follows typing ("live") by default, for everyone.
  if (storedVersion() < 2) return { ...p, autoCompile: true, version: 2 };
  return p;
}

export const usePrefs = create<PrefsState>((set, get) => ({
  ...loadPrefs(),
  compilerOverride: null,
  set: (patch) => {
    set(patch);
    const { set: _ignored, compilerOverride: _c, ...rest } = { ...get(), ...patch };
    writeLS(KEY, JSON.stringify(rest));
  },
}));
