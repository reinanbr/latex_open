import type { Text } from "@codemirror/state";
import { parseSections } from "../lib/latexStructure";
import { extname } from "../lib/format";
import { useEditor } from "../store/editor";

let timer: number | null = null;

const TEX = new Set(["tex", "ltx", "sty", "cls", "dtx"]);

/** Recompute the outline of the active document (debounced while typing). */
export function updateOutline(path: string, doc: Text, delayMs = 0) {
  if (timer !== null) window.clearTimeout(timer);
  timer = null;
  const run = () => {
    timer = null;
    const set = useEditor.getState().setOutline;
    if (!TEX.has(extname(path))) set(null);
    else set({ path, sections: parseSections(doc.toString()) });
  };
  if (delayMs <= 0) run();
  else timer = window.setTimeout(run, delayMs);
}
