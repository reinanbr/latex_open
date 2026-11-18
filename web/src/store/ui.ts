import { create } from "zustand";

export type Theme = "light" | "dark";

export interface Toast {
  id: number;
  kind: "info" | "success" | "error" | "warning";
  message: string;
}

export type DialogRequest =
  | { kind: "confirm"; title: string; message: string; confirmLabel?: string; danger?: boolean; resolve: (ok: boolean) => void }
  | {
      kind: "prompt";
      title: string;
      message?: string;
      initial: string;
      placeholder?: string;
      confirmLabel?: string;
      /** Character range to preselect, e.g. the name without the extension. */
      select?: [number, number];
      resolve: (value: string | null) => void;
    };

interface UIState {
  theme: Theme;
  toasts: Toast[];
  dialog: DialogRequest | null;
  setTheme: (t: Theme) => void;
  toast: (kind: Toast["kind"], message: string) => void;
  dismissToast: (id: number) => void;
  setDialog: (d: DialogRequest | null) => void;
}

export function readLS(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function writeLS(key: string, value: string) {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* storage unavailable */
  }
}

export function loadJSON<T>(key: string, fallback: T): T {
  const raw = readLS(key);
  if (!raw) return fallback;
  try {
    return { ...fallback, ...(JSON.parse(raw) as Partial<T>) };
  } catch {
    return fallback;
  }
}

function initialTheme(): Theme {
  const saved = readLS("texdesk.theme");
  if (saved === "light" || saved === "dark") return saved;
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

let toastSeq = 0;

export const useUI = create<UIState>((set, get) => ({
  theme: initialTheme(),
  toasts: [],
  dialog: null,
  setTheme: (theme) => {
    writeLS("texdesk.theme", theme);
    set({ theme });
  },
  toast: (kind, message) => {
    const id = ++toastSeq;
    set({ toasts: [...get().toasts, { id, kind, message }] });
    window.setTimeout(() => get().dismissToast(id), kind === "error" ? 8000 : 4000);
  },
  dismissToast: (id) => set({ toasts: get().toasts.filter((t) => t.id !== id) }),
  setDialog: (dialog) => set({ dialog }),
}));

export const toast = (kind: Toast["kind"], message: string) => useUI.getState().toast(kind, message);

export function confirmDialog(opts: { title: string; message: string; confirmLabel?: string; danger?: boolean }): Promise<boolean> {
  return new Promise((resolve) => useUI.getState().setDialog({ kind: "confirm", ...opts, resolve }));
}

export function promptDialog(opts: {
  title: string;
  message?: string;
  initial?: string;
  placeholder?: string;
  confirmLabel?: string;
  select?: [number, number];
}): Promise<string | null> {
  return new Promise((resolve) =>
    useUI.getState().setDialog({ kind: "prompt", initial: "", ...opts, resolve }),
  );
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
