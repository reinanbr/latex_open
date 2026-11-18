// Generates the LaTeX knowledge base (web/src/data/latex-kb.json) used by the
// editor for autocomplete and live checks: the commands and environments that
// the LaTeX kernel, the common classes and the common packages define, with
// the packages each one loads.
//
// It asks TeX itself: every class/package is loaded in its own LuaLaTeX run
// and the hash table is dumped (dump.lua), so nothing is typed by hand.
//
//   node scripts/latexkb/gen.mjs            (from web/; needs lualatex)
//   TEXMFHOME=... node scripts/latexkb/gen.mjs   (to include local classes)
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { cpus, tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DUMP = join(HERE, "dump.lua");
const OUT = process.env.OUT ?? join(HERE, "../../src/data/latex-kb.json");
const list = JSON.parse(readFileSync(join(HERE, "list.json"), "utf8"));
const { OPTIONS, INSIDE, SKIP } = list;
// ONLY=tikz,article: a quick partial run (for testing the generator).
const only = process.env.ONLY ? new Set(process.env.ONLY.split(",")) : null;
const CLASSES = list.CLASSES.filter((c) => !only || only.has(c));
const PACKAGES = list.PACKAGES.filter((c) => !only || only.has(c));

// Raw TeX runs are cached (keyed by the document and dump.lua), so changing
// how they are combined does not cost another full run. NOCACHE=1 to skip.
const CACHE = process.env.NOCACHE ? null : join(HERE, "../../node_modules/.cache/latexkb");
if (CACHE) mkdirSync(CACHE, { recursive: true });
const dumpHash = createHash("sha1").update(readFileSync(DUMP)).digest("hex");

async function run(body) {
  const dump = (n) => `\\directlua{KBFILE="${n}.tsv" dofile("${DUMP}")}`;
  const doc = "\\listfiles" + body(dump);
  const cached = CACHE && join(CACHE, createHash("sha1").update(dumpHash + doc + (process.env.TEXMFHOME ?? "")).digest("hex") + ".json");
  if (cached && existsSync(cached)) return JSON.parse(readFileSync(cached, "utf8"));
  const res = await runTeX(doc);
  if (cached) writeFileSync(cached, JSON.stringify(res));
  return res;
}

function runTeX(doc) {
  const dir = mkdtempSync(join(tmpdir(), "texdesk-kb-"));
  writeFileSync(join(dir, "k.tex"), doc);
  return new Promise((resolve) => {
    const p = spawn("lualatex", ["-interaction=nonstopmode", "-no-shell-escape", "k.tex"], { cwd: dir, stdio: "ignore" });
    const timer = setTimeout(() => p.kill("SIGKILL"), 120_000);
    p.on("close", () => {
      clearTimeout(timer);
      const read = (n) => (existsSync(join(dir, n + ".tsv")) ? readFileSync(join(dir, n + ".tsv"), "utf8") : null);
      const log = existsSync(join(dir, "k.log")) ? readFileSync(join(dir, "k.log"), "latin1") : "";
      const res = { kernel: read("kernel"), doc: read("doc"), inside: read("inside"), errors: (log.match(/^! .*/gm) ?? []).slice(0, 3) };
      rmSync(dir, { recursive: true, force: true });
      resolve(res);
    });
  });
}

/** name -> {cmd, spec, prim}; plus loaded classes/packages. */
function parse(tsv) {
  const names = new Map();
  const loaded = { class: [], package: [] };
  for (const line of tsv.split("\n")) {
    if (!line) continue;
    const [a, b, c, d] = line.split("\t");
    if (a === "@") loaded[b].push(c);
    else names.set(a, { cmd: b, spec: c === "!" ? null : c, prim: d === "p" });
  }
  return { names, loaded };
}

async function pool(items, n, fn) {
  const out = new Map();
  let i = 0;
  await Promise.all(
    Array.from({ length: n }, async () => {
      while (i < items.length) {
        const it = items[i++];
        out.set(it, await fn(it));
      }
    }),
  );
  return out;
}

const N = Math.max(2, cpus().length);
const base = await run((d) => `${d("kernel")}\\documentclass{article}\\begin{document}${d("doc")}\\end{document}\n`);
const kernel = parse(base.kernel).names;
const article = parse(base.doc);
const prims = new Set([...kernel].filter(([, v]) => v.prim).map(([k]) => k));
console.error(`kernel: ${kernel.size} names, article run: ${article.names.size}`);

const classRuns = await pool(CLASSES, N, (c) =>
  run((d) => `\\documentclass{${c}}\\begin{document}${d("doc")}\\end{document}\n`),
);
const pkgRuns = new Map();
let queue = [...PACKAGES];
while (queue.length) {
  const res = await pool(queue, N, (p) =>
    run(
      (d) =>
        `\\documentclass{article}\\usepackage${OPTIONS[p] ? `[${OPTIONS[p]}]` : ""}{${p}}\\begin{document}${d("doc")}` +
        // Commands that only exist inside an environment (\draw in tikzpicture).
        `${INSIDE[p] ? INSIDE[p].replace("DUMP", d("inside")) : ""}\\end{document}\n`,
    ),
  );
  const next = new Set();
  for (const [p, r] of res) {
    pkgRuns.set(p, r);
    if (r.doc) for (const q of parse(r.doc).loaded.package) if (!pkgRuns.has(q) && !queue.includes(q) && !SKIP.includes(q)) next.add(q);
  }
  queue = [...next];
  console.error(`packages: ${pkgRuns.size} done, ${queue.length} dependencies queued`);
}
for (const c of classRuns.values()) for (const q of c.doc ? parse(c.doc).loaded.package : []) if (!pkgRuns.has(q) && !SKIP.includes(q)) {
  pkgRuns.set(q, await run((d) => `\\documentclass{article}\\usepackage{${q}}\\begin{document}${d("doc")}\\end{document}\n`));
}

const isRelax = (v) => v.cmd === "relax";
const failed = {};
const parsedPkgs = new Map();
for (const [p, r] of pkgRuns) {
  if (!r.doc || r.errors.length) {
    failed[p] = r.errors[0] ?? "no output";
    continue;
  }
  const parsed = parse(r.doc);
  if (INSIDE[p] && !r.inside) {
    failed[p] = "no dump inside " + INSIDE[p];
    continue;
  }
  if (r.inside) for (const [k, v] of parse(r.inside).names) if (!parsed.names.has(k)) parsed.names.set(k, v);
  parsedPkgs.set(p, parsed);
}
/** Names a package run adds to the article run. */
const diff = new Map();
for (const [p, r] of parsedPkgs) {
  const s = new Set();
  for (const k of r.names.keys()) if (!article.names.has(k)) s.add(k);
  diff.set(p, s);
}

function entry(run, own, deps) {
  // Environments: \foo with \endfoo, not TeX primitives (\input/\endinput).
  const envs = [];
  const cmds = [];
  // \relax placeholders (often \csname leftovers): known, but not offered.
  const hidden = [];
  const envNames = new Set();
  for (const k of own) {
    if (k.startsWith("end") && own.has(k) && run.names.has(k.slice(3)) && !prims.has(k.slice(3)) && !prims.has(k)) envNames.add(k.slice(3));
    else if (run.names.has("end" + k) && !prims.has(k) && !prims.has("end" + k)) envNames.add(k);
  }
  for (const e of [...envNames].sort()) {
    const sp = run.names.get(e)?.spec;
    envs.push(sp ? `${e}:${sp}` : e);
  }
  for (const k of [...own].sort()) {
    if (envNames.has(k) || (k.startsWith("end") && envNames.has(k.slice(3))) || k.endsWith("*")) continue;
    const v = run.names.get(k);
    if (isRelax(v) && k !== "relax") hidden.push(k);
    else cmds.push(v.spec ? `${k}:${v.spec}` : k);
  }
  return { ...(deps.length ? { deps } : {}), cmds: cmds.join(" "), envs: envs.join(" "), ...(hidden.length ? { hidden: hidden.join(" ") } : {}) };
}

const packages = {};
for (const [p, r] of parsedPkgs) {
  const deps = r.loaded.package.filter((q) => q !== p && parsedPkgs.has(q));
  const own = new Set(diff.get(p));
  // A dependency that loads this package back (doc <-> hypdoc) defines
  // everything this one does: subtracting it would leave nothing.
  for (const q of deps) if (!parsedPkgs.get(q).loaded.package.includes(p)) for (const k of diff.get(q)) own.delete(k);
  packages[p] = entry(r, own, deps.sort());
}
const unparsed = new Set(Object.keys(failed));
const classes = {};
for (const [c, r] of classRuns) {
  if (!r.doc || r.errors.length) {
    failed[c + ".cls"] = r.errors[0] ?? "no output";
    continue;
  }
  const run = parse(r.doc);
  const deps = run.loaded.package.filter((q) => parsedPkgs.has(q));
  const own = new Set();
  for (const k of run.names.keys()) if (!kernel.has(k)) own.add(k);
  for (const q of deps) for (const k of diff.get(q)) own.delete(k);
  const parents = run.loaded.class.filter((k) => k !== c);
  classes[c] = { ...entry(run, own, deps.sort()), ...(parents.length ? { classes: parents } : {}) };
}
// A class loaded by another class (abntex2 -> memoir): drop what the parent defines.
for (const c of Object.values(classes)) {
  for (const parent of c.classes ?? []) {
    const p = classes[parent];
    if (!p) continue;
    const drop = new Set([p.cmds, p.envs, p.hidden ?? ""].join(" ").split(" ").map((x) => x.split(":")[0]));
    for (const f of ["cmds", "envs", "hidden"]) if (c[f]) c[f] = c[f].split(" ").filter((x) => !drop.has(x.split(":")[0])).join(" ");
  }
}

// Engine primitives LuaLaTeX lacks (\pdfoutput, \XeTeXlinebreaklocale...):
// candidates are the words in the pdfTeX/XeTeX binaries, kept when the
// engine's LaTeX format defines them.
function engineNames(engine) {
  const bin = execFileSync("kpsewhich", ["--var-value=SELFAUTOLOC"], { encoding: "utf8" }).trim() + "/" + engine.replace("latex", "tex");
  const words = new Set(execFileSync("strings", ["-n", "3", bin], { encoding: "latin1", maxBuffer: 1 << 28 }).match(/^[A-Za-z]{3,40}$/gm) ?? []);
  const dir = mkdtempSync(join(tmpdir(), "texdesk-kb-"));
  const tests = [...words].map((w) => `\\t{${w}}`).join("\n");
  writeFileSync(join(dir, "k.tex"), `\\newwrite\\o\\immediate\\openout\\o=names.txt\\def\\t#1{\\ifcsname #1\\endcsname\\immediate\\write\\o{#1}\\fi}\n${tests}\n\\immediate\\closeout\\o\\csname @@end\\endcsname\n`);
  spawnSync(engine, ["-interaction=batchmode", "-no-shell-escape", "k.tex"], { cwd: dir, stdio: "ignore" });
  const got = existsSync(join(dir, "names.txt")) ? readFileSync(join(dir, "names.txt"), "utf8").split("\n").filter(Boolean) : [];
  rmSync(dir, { recursive: true, force: true });
  return got;
}
for (const engine of ["pdflatex", "xelatex"]) {
  let n = 0;
  for (const w of engineNames(engine)) if (!kernel.has(w)) (kernel.set(w, { cmd: "primitive", spec: null, prim: true }), n++);
  console.error(`${engine}: +${n} names`);
}
const kernelEntry = entry({ names: kernel }, new Set(kernel.keys()), []);
const out = {
  generated: new Date().toISOString().slice(0, 10),
  engine: "LuaLaTeX",
  kernel: kernelEntry,
  classes,
  packages,
  failed,
};
writeFileSync(OUT, JSON.stringify(out));
console.error(`classes ${Object.keys(classes).length}, packages ${Object.keys(packages).length}, failed ${unparsed.size}: ${JSON.stringify(failed)}`);
console.error(`size ${(JSON.stringify(out).length / 1024).toFixed(0)} KB -> ${OUT}`);
