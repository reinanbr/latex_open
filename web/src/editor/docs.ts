import { EditorState, type ChangeSpec, type Extension, type StateEffect } from "@codemirror/state";
import { api } from "../api/client";

export type SaveStatus = "saved" | "dirty" | "saving" | "error";

interface Entry {
  state: EditorState;
  /** Content as last confirmed by the server. */
  saved: string;
  timer: number | null;
  /** Tail of the save chain for this file (saves never overlap). */
  chain: Promise<void>;
  scrollTop: number;
}

export interface DocManagerOptions {
  projectId: string;
  makeExtensions: (path: string) => Extension[];
  onStatus: (path: string, status: SaveStatus, error?: string) => void;
  /** Called after any successful save (used by auto-compile). */
  onSaved?: (path: string) => void;
  debounceMs?: number;
}

/**
 * Owns one EditorState per open text file, independent of the (single)
 * EditorView, and persists changes with a debounced auto-save.
 */
export class DocManager {
  private docs = new Map<string, Entry>();
  private loading = new Map<string, Promise<EditorState>>();
  private opts: Required<Omit<DocManagerOptions, "onSaved">> & Pick<DocManagerOptions, "onSaved">;

  constructor(opts: DocManagerOptions) {
    this.opts = { debounceMs: 1000, ...opts };
  }

  has(path: string): boolean {
    return this.docs.has(path);
  }

  get(path: string): EditorState | undefined {
    return this.docs.get(path)?.state;
  }

  /** Text of an open document, if loaded. */
  text(path: string): string | undefined {
    return this.docs.get(path)?.state.doc.toString();
  }

  paths(): string[] {
    return [...this.docs.keys()];
  }

  async load(path: string): Promise<EditorState> {
    const existing = this.docs.get(path);
    if (existing) return existing.state;
    let p = this.loading.get(path);
    if (!p) {
      p = (async () => {
        const text = await api.readText(this.opts.projectId, path);
        const state = EditorState.create({ doc: text, extensions: this.opts.makeExtensions(path) });
        this.docs.set(path, { state, saved: text, timer: null, chain: Promise.resolve(), scrollTop: 0 });
        this.opts.onStatus(path, "saved");
        return state;
      })().finally(() => this.loading.delete(path));
      this.loading.set(path, p);
    }
    return p;
  }

  /** Record the view's latest state for a document. */
  update(path: string, state: EditorState, docChanged: boolean) {
    const e = this.docs.get(path);
    if (!e) return;
    e.state = state;
    if (docChanged) {
      this.opts.onStatus(path, "dirty");
      this.schedule(path, e);
    }
  }

  setScroll(path: string, top: number) {
    const e = this.docs.get(path);
    if (e) e.scrollTop = top;
  }

  getScroll(path: string): number {
    return this.docs.get(path)?.scrollTop ?? 0;
  }

  isDirty(path?: string): boolean {
    const check = (e: Entry) => e.state.doc.toString() !== e.saved;
    if (path) {
      const e = this.docs.get(path);
      return e ? check(e) : false;
    }
    for (const e of this.docs.values()) if (check(e)) return true;
    return false;
  }

  private schedule(path: string, e: Entry) {
    if (e.timer !== null) window.clearTimeout(e.timer);
    e.timer = window.setTimeout(() => {
      e.timer = null;
      void this.save(path);
    }, this.opts.debounceMs);
  }

  /** Save one document now (chained after any in-flight save). */
  save(path: string): Promise<void> {
    const e = this.docs.get(path);
    if (!e) return Promise.resolve();
    if (e.timer !== null) {
      window.clearTimeout(e.timer);
      e.timer = null;
    }
    e.chain = e.chain.then(async () => {
      const cur = this.docs.get(path);
      if (!cur) return; // closed or renamed meanwhile
      const content = cur.state.doc.toString();
      if (content === cur.saved) {
        this.opts.onStatus(path, "saved");
        return;
      }
      this.opts.onStatus(path, "saving");
      try {
        await api.writeText(this.opts.projectId, path, content);
        cur.saved = content;
        const stillDirty = cur.state.doc.toString() !== content;
        this.opts.onStatus(path, stillDirty ? "dirty" : "saved");
        this.opts.onSaved?.(path);
      } catch (err) {
        this.opts.onStatus(path, "error", err instanceof Error ? err.message : String(err));
        // Retry later; edits keep rescheduling too.
        if (cur.timer === null) cur.timer = window.setTimeout(() => {
          cur.timer = null;
          void this.save(path);
        }, 5000);
      }
    });
    return e.chain;
  }

  /** Save every dirty document; resolves when all saves settled. */
  async flushAll(): Promise<void> {
    await Promise.all(this.paths().map((p) => this.save(p)));
  }

  /** Best-effort save during page unload (fetch keepalive, ≤64 KB bodies). */
  flushOnUnload() {
    for (const [path, e] of this.docs) {
      const content = e.state.doc.toString();
      if (content === e.saved || content.length > 60_000) continue;
      void fetch(api.fileUrl(this.opts.projectId, path), {
        method: "PUT",
        keepalive: true,
        headers: { "X-Texdesk": "1" },
        body: content,
      });
    }
  }

  /** Save every open document at or under a path (before a move). */
  async flushUnder(path: string) {
    await Promise.all(this.paths().filter((p) => p === path || p.startsWith(path + "/")).map((p) => this.save(p)));
  }

  /** Re-key documents after a rename/move of a file or folder succeeded. */
  rekey(from: string, to: string) {
    const moved = [...this.docs.keys()].filter((p) => p === from || p.startsWith(from + "/"));
    for (const p of moved) {
      const e = this.docs.get(p);
      if (!e) continue;
      this.docs.delete(p);
      this.docs.set(to + p.slice(from.length), e);
    }
  }

  /** Forget documents (after deletion) without saving. */
  drop(path: string) {
    for (const p of [...this.docs.keys()]) {
      if (p === path || p.startsWith(path + "/")) {
        const e = this.docs.get(p);
        if (e?.timer != null) window.clearTimeout(e.timer);
        this.docs.delete(p);
      }
    }
  }

  /** Close one document, saving it first. */
  async close(path: string) {
    await this.save(path);
    this.docs.delete(path);
  }

  /** Replace a clean document's content with the server version. */
  async reloadIfClean(path: string): Promise<boolean> {
    const e = this.docs.get(path);
    if (!e || e.state.doc.toString() !== e.saved) return false;
    const text = await api.readText(this.opts.projectId, path);
    if (text === e.saved) return false;
    e.state = e.state.update({ changes: { from: 0, to: e.state.doc.length, insert: text } }).state;
    e.saved = text;
    return true;
  }

  /** Apply effects (e.g. compartment reconfiguration) to every stored state. */
  applyToAll(effects: StateEffect<unknown>[], except?: string) {
    for (const [p, e] of this.docs) {
      if (p === except) continue;
      e.state = e.state.update({ effects }).state;
    }
  }

  /** Replace a stored state through a transformation (hidden docs only). */
  transform(path: string, fn: (s: EditorState) => EditorState) {
    const e = this.docs.get(path);
    if (e) e.state = fn(e.state);
  }

  /** Change a stored document that is not in the view, and save it. */
  change(path: string, changes: ChangeSpec) {
    const e = this.docs.get(path);
    if (!e) return;
    e.state = e.state.update({ changes }).state;
    this.opts.onStatus(path, "dirty");
    this.schedule(path, e);
  }

  /** Apply effects to one stored state (not the one in the view). */
  apply(path: string, effects: StateEffect<unknown>[]) {
    const e = this.docs.get(path);
    if (e) e.state = e.state.update({ effects }).state;
  }

  dispose() {
    for (const e of this.docs.values()) if (e.timer !== null) window.clearTimeout(e.timer);
  }
}
