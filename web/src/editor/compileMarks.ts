import { ChangeSet, StateEffect, StateField, type Text } from "@codemirror/state";
import type { Problem } from "../api/types";

/** A problem of the last compilation, positioned in the document. */
export interface CompileMark {
  from: number;
  to: number;
  problem: Problem;
  /** The line was edited after the compilation that reported it. */
  stale: boolean;
}

interface MarksState {
  marks: CompileMark[];
  /**
   * Document as it was sent to the compiler, plus the edits made since: the
   * results refer to line numbers of that version, typing goes on meanwhile.
   */
  base: { doc: Text; changes: ChangeSet } | null;
}

/** Dispatch right before the files are saved for a compilation. */
export const compileStarted = StateEffect.define<null>();
/** The problems of this file from the finished compilation. */
export const setCompileProblems = StateEffect.define<Problem[]>();

function linesToMarks(doc: Text, problems: Problem[]): CompileMark[] {
  return problems
    .filter((p) => (p.line ?? 0) >= 1 && (p.line ?? 0) <= doc.lines)
    .map((p) => {
      const line = doc.line(p.line ?? 1);
      // Underline the line's text, not its leading indentation.
      const indent = line.text.length - line.text.trimStart().length;
      const from = Math.min(line.from + indent, line.to);
      return { from, to: Math.max(from, line.to), problem: p, stale: false };
    });
}

function mapMark(m: CompileMark, changes: ChangeSet): CompileMark {
  const stale = m.stale || changes.touchesRange(m.from, m.to) !== false;
  const from = changes.mapPos(m.from, 1);
  return { ...m, from, to: Math.max(from, changes.mapPos(m.to, -1)), stale };
}

export const compileMarks = StateField.define<MarksState>({
  create: () => ({ marks: [], base: null }),
  update(value, tr) {
    let { marks, base } = value;
    if (tr.docChanged) {
      if (marks.length) marks = marks.map((m) => mapMark(m, tr.changes));
      if (base) base = { doc: base.doc, changes: base.changes.compose(tr.changes) };
    }
    for (const e of tr.effects) {
      if (e.is(compileStarted)) {
        base = { doc: tr.state.doc, changes: ChangeSet.empty(tr.state.doc.length) };
      } else if (e.is(setCompileProblems)) {
        if (base) {
          const changes = base.changes;
          // Position against the compiled text, then follow the later edits
          // (marks on lines edited since then come out stale).
          marks = linesToMarks(base.doc, e.value).map((m) => (changes.empty ? m : mapMark(m, changes)));
        } else {
          marks = linesToMarks(tr.state.doc, e.value);
        }
        base = null;
      }
    }
    return marks === value.marks && base === value.base ? value : { marks, base };
  },
});
