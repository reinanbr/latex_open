// SyncTeX actions: editor → PDF (forward) and PDF → editor (inverse).
import { api } from "../api/client";
import { useCompile } from "./compile";
import { useEditor } from "./editor";
import { usePrefs } from "./prefs";
import { errorMessage, toast } from "./ui";

let nonce = 0;

/** Show the cursor position of the active file in the PDF. */
export async function syncToPdf(projectId: string) {
  const { active, cursor } = useEditor.getState();
  const { pdfBuildId } = useCompile.getState();
  if (!active || !cursor) return;
  if (!pdfBuildId) {
    toast("info", "Compile o projeto para sincronizar com o PDF.");
    return;
  }
  if (usePrefs.getState().layout === "editor") usePrefs.getState().set({ layout: "both" });
  try {
    const box = await api.syncForward(projectId, pdfBuildId, active, cursor.line, cursor.col);
    const n = ++nonce;
    useCompile.getState().set({ highlight: { ...box, nonce: n }, logsOpen: false });
    // One-shot: after the flash (2.5 s) drop it so a remounted PDF view
    // (layout switch) does not replay it.
    window.setTimeout(() => {
      if (useCompile.getState().highlight?.nonce === n) useCompile.getState().set({ highlight: null });
    }, 3000);
  } catch (err) {
    toast("info", errorMessage(err));
  }
}

/** Jump the editor to the source of a point of the PDF (in PDF points). */
export async function syncToCode(projectId: string, page: number, x: number, y: number) {
  const { pdfBuildId } = useCompile.getState();
  if (!pdfBuildId) return;
  try {
    const loc = await api.syncInverse(projectId, pdfBuildId, page, x, y);
    if (usePrefs.getState().layout === "pdf") usePrefs.getState().set({ layout: "both" });
    useEditor.getState().open(loc.file, { line: loc.line, col: loc.col > 0 ? loc.col : undefined, flash: true });
  } catch (err) {
    toast("info", errorMessage(err));
  }
}
