import { create } from "zustand";

/** A problem found while typing (no compilation) in the open file. */
export interface LiveIssue {
  line: number;
  col: number;
  message: string;
  severity: "error" | "warning";
  kind: "syntax" | "reference" | "command";
}

interface LiveStore {
  path: string | null;
  issues: LiveIssue[];
  /** Why unknown commands are not being checked (null = they are). */
  commandNote: string | null;
  publish: (path: string, issues: LiveIssue[], commandNote?: string | null) => void;
  clear: () => void;
}

export const useLive = create<LiveStore>((set, get) => ({
  path: null,
  issues: [],
  commandNote: null,
  publish: (path, issues, commandNote = null) => {
    const s = get();
    // The linter runs on every pause in typing: skip identical results.
    if (s.path === path && s.commandNote === commandNote && JSON.stringify(s.issues) === JSON.stringify(issues)) return;
    set({ path, issues, commandNote });
  },
  clear: () => set({ path: null, issues: [], commandNote: null }),
}));

export function countLive(issues: LiveIssue[]) {
  let errors = 0;
  let warnings = 0;
  for (const i of issues) {
    if (i.severity === "error") errors++;
    else warnings++;
  }
  return { errors, warnings };
}
