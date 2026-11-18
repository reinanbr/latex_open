import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import type { Problem } from "../api/types";
import { compileMarks, compileStarted, setCompileProblems } from "./compileMarks";

const problem = (line: number): Problem => ({ level: "error", file: "a.tex", line, message: "Undefined control sequence.", raw: "" });
const marked = (s: EditorState) =>
  s.field(compileMarks).marks.map((m) => ({ text: s.doc.sliceString(m.from, m.to), stale: m.stale }));

describe("compileMarks", () => {
  const doc = "um\n  \\erro aqui\ntrês\n";
  const create = () => EditorState.create({ doc, extensions: [compileMarks] });

  it("places problems on their line, without the indentation", () => {
    const s = create().update({ effects: setCompileProblems.of([problem(2)]) }).state;
    expect(marked(s)).toEqual([{ text: "\\erro aqui", stale: false }]);
  });

  it("keeps up with edits made while the compilation ran", () => {
    let s = create().update({ effects: compileStarted.of(null) }).state;
    // The user keeps typing: two new lines at the top.
    s = s.update({ changes: { from: 0, insert: "novo 1\nnovo 2\n" } }).state;
    s = s.update({ effects: setCompileProblems.of([problem(2)]) }).state;
    expect(marked(s)).toEqual([{ text: "\\erro aqui", stale: false }]);
  });

  it("marks a problem stale when its line is edited", () => {
    let s = create().update({ effects: setCompileProblems.of([problem(2)]) }).state;
    s = s.update({ changes: { from: s.doc.line(2).from + 3, insert: "X" } }).state;
    expect(marked(s)[0]!.stale).toBe(true);
    // Edits elsewhere keep it fresh.
    let t = create().update({ effects: setCompileProblems.of([problem(2)]) }).state;
    t = t.update({ changes: { from: 0, insert: "zero\n" } }).state;
    expect(marked(t)).toEqual([{ text: "\\erro aqui", stale: false }]);
  });

  it("an edit of the reported line during the compilation makes it stale", () => {
    let s = create().update({ effects: compileStarted.of(null) }).state;
    s = s.update({ changes: { from: s.doc.line(2).from + 2, to: s.doc.line(2).from + 8, insert: "\\certo" } }).state;
    s = s.update({ effects: setCompileProblems.of([problem(2)]) }).state;
    expect(marked(s)[0]!.stale).toBe(true);
  });

  it("drops problems beyond the end of the document", () => {
    const s = create().update({ effects: setCompileProblems.of([problem(99)]) }).state;
    expect(marked(s)).toEqual([]);
  });
});
