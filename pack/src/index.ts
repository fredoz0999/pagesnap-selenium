/**
 * Session index: build (compact + chunk + embed) and hybrid query
 * (BM25 keyword + vector cosine + exact accessible-name bonus).
 */
import fs from "node:fs";
import path from "node:path";
import { chunkSnapshot, dedupeChunks, findChrome, type Chunk, type ChunkOptions, type PageEntry } from "./chunk.js";
import { compactNodes } from "./compact.js";
import { LEGEND } from "./compact.js";
import { cosine, expand, makeEmbedder, tokenize } from "./embed.js";
import { estimateTokens, parseSnapshot } from "./parse.js";
import { writeSessionPrompts } from "./prompts.js";

export const LEAN_DIR = "lean";
export const INDEX_FILE = "index.json";
export const INDEX_VERSION = 2;

export interface SessionIndex {
  version: number;
  embedder: string;
  builtAt: string;
  pages: PageEntry[];
  chunks: Chunk[];
  vectors: number[][];
  stats: { rawTokens: number; compactTokens: number; chunkCount: number };
}

export interface BuildOptions extends ChunkOptions {
  embedder?: string;
  /** spec name used in the generated prompts (default: slug of the session goal) */
  name?: string;
}

export function snapshotFiles(sessionDir: string): string[] {
  return fs
    .readdirSync(sessionDir)
    .filter((f) => /^\d+_.+\.ya?ml$/i.test(f))
    .sort();
}

export async function buildIndex(sessionDir: string, opts: BuildOptions = {}): Promise<SessionIndex> {
  const files = snapshotFiles(sessionDir);
  if (!files.length) throw new Error("No NN_*.yaml snapshots in " + sessionDir);
  const leanDir = path.join(sessionDir, LEAN_DIR);
  fs.mkdirSync(leanDir, { recursive: true });

  const pages: PageEntry[] = [];
  let all: Chunk[] = [];
  const snaps = files.map((f) => parseSnapshot(fs.readFileSync(path.join(sessionDir, f), "utf8"), f));
  const chrome = opts.chrome ?? findChrome(snaps.map((s) => compactNodes(s.roots, opts)));
  const chromeTexts = new Set<string>();
  for (const snap of snaps) {
    const { chunks, page, compact, chromeText } = chunkSnapshot(snap, { ...opts, chrome });
    fs.writeFileSync(path.join(leanDir, snap.file.replace(/\.ya?ml$/i, ".txt")), compact, "utf8");
    if (chromeText) chromeTexts.add(chromeText);
    pages.push(page);
    all = all.concat(chunks);
  }
  const chromePath = path.join(leanDir, "CHROME.txt");
  if (chromeTexts.size) fs.writeFileSync(chromePath, "# Site chrome shared by most pages\n" + [...chromeTexts].join("\n") + "\n", "utf8");
  else fs.rmSync(chromePath, { force: true });
  const chunks = dedupeChunks(all);
  const embedder = makeEmbedder(opts.embedder);
  const vectors = (await embedder.embed(chunks.map((c) => c.path + "\n" + c.text))).map((v) =>
    v.map((x) => Math.round(x * 1e4) / 1e4)
  );
  const index: SessionIndex = {
    version: INDEX_VERSION,
    embedder: embedder.id,
    builtAt: new Date().toISOString(),
    pages,
    chunks,
    vectors,
    stats: {
      rawTokens: pages.reduce((a, p) => a + p.rawTokens, 0),
      compactTokens: pages.reduce((a, p) => a + p.compactTokens, 0),
      chunkCount: chunks.length,
    },
  };
  fs.writeFileSync(path.join(leanDir, INDEX_FILE), JSON.stringify(index), "utf8");
  fs.writeFileSync(path.join(leanDir, "PACK.md"), packMd(index), "utf8");
  writeSessionPrompts(sessionDir, opts.name);
  return index;
}

export function loadIndex(sessionDir: string): SessionIndex {
  const p = path.join(sessionDir, LEAN_DIR, INDEX_FILE);
  if (!fs.existsSync(p)) throw new Error("No index at " + p + " - run: npm run pack -- build " + sessionDir);
  const idx = JSON.parse(fs.readFileSync(p, "utf8")) as SessionIndex;
  if (idx.version !== INDEX_VERSION) throw new Error("Index version mismatch - rebuild with: npm run pack -- build " + sessionDir);
  return idx;
}

/** True when any snapshot is newer than the index (or index missing). */
export function indexIsStale(sessionDir: string): boolean {
  const p = path.join(sessionDir, LEAN_DIR, INDEX_FILE);
  if (!fs.existsSync(p)) return true;
  try {
    if ((JSON.parse(fs.readFileSync(p, "utf8")) as { version?: number }).version !== INDEX_VERSION) return true;
  } catch {
    return true;
  }
  const t = fs.statSync(p).mtimeMs;
  return snapshotFiles(sessionDir).some((f) => fs.statSync(path.join(sessionDir, f)).mtimeMs > t);
}

// ---------------------------------------------------------------- BM25

function bm25Scores(query: string[], docs: string[][], k1 = 1.2, b = 0.75): number[] {
  const N = docs.length;
  const avgdl = docs.reduce((a, d) => a + d.length, 0) / Math.max(1, N);
  const df = new Map<string, number>();
  for (const d of docs) for (const t of new Set(d)) df.set(t, (df.get(t) || 0) + 1);
  const qset = [...new Set(query)];
  return docs.map((d) => {
    const tf = new Map<string, number>();
    for (const t of d) tf.set(t, (tf.get(t) || 0) + 1);
    let s = 0;
    for (const t of qset) {
      const f = tf.get(t);
      if (!f) continue;
      const n = df.get(t) || 0;
      const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
      s += idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * d.length) / avgdl)));
    }
    return s;
  });
}

// ---------------------------------------------------------------- query

export interface QueryOptions {
  k?: number;
  step?: number;
  urlContains?: string;
  /** below this top score, fall back to the whole compact page (default 0.18) */
  minScore?: number;
  legend?: boolean;
  /** drop hits scoring below this fraction of the best hit (default 0.5) */
  relCutoff?: number;
  /**
   * With `step`: chunks unchanged since the previous step on the same page are
   * shown as one-line references, and regions that changed are added even if
   * they rank lower (that is usually what the step asserts on).
   */
  diff?: boolean;
}

export interface Hit {
  chunk: Chunk;
  /** set in diff mode: unchanged since this step, rendered as a reference */
  sameAs?: number;
  /** set in diff mode: region changed vs previous step */
  changed?: boolean;
  score: number;
  bm25: number;
  vec: number;
  exact: number;
}

export interface QueryResult {
  hits: Hit[];
  lowConfidence: boolean;
  text: string;
  tokens: number;
}

const QUOTED = /"((?:[^"\\]|\\.)*)"/g;

function exactBonus(query: string, chunk: Chunk): number {
  const q = query.toLowerCase();
  let bonus = 0;
  let m: RegExpExecArray | null;
  QUOTED.lastIndex = 0;
  while ((m = QUOTED.exec(chunk.text))) {
    const name = m[1].toLowerCase();
    if (name.length >= 3 && q.includes(name)) bonus += 0.15 + Math.min(0.15, name.length / 100);
  }
  return Math.min(0.45, bonus);
}

export async function queryIndex(sessionDir: string, query: string, opts: QueryOptions = {}): Promise<QueryResult> {
  const idx = loadIndex(sessionDir);
  const k = opts.k ?? 4;
  const embedder = makeEmbedder(idx.embedder);
  const [qv] = await embedder.embed([query]);
  const qTokens = expand(tokenize(query));
  const docs = idx.chunks.map((c) => expand(tokenize(c.path + " " + c.text)));
  const bm = bm25Scores(qTokens, docs);
  const bmMax = Math.max(1e-9, ...bm);

  let hits: Hit[] = idx.chunks.map((chunk, i) => {
    const vec = Math.max(0, cosine(qv, idx.vectors[i]));
    const b = bm[i] / bmMax;
    const exact = exactBonus(query, chunk);
    // Site chrome (nav, footer) matches many step texts; rank it below page content.
    const w = chunk.kind === "chrome" ? 0.6 : 1;
    return { chunk, bm25: b, vec, exact, score: w * (0.5 * b + 0.5 * vec + exact) };
  });
  if (opts.step != null) hits = hits.filter((h) => h.chunk.steps.includes(opts.step!));
  if (opts.urlContains) hits = hits.filter((h) => h.chunk.url.includes(opts.urlContains!));
  hits.sort((a, b) => b.score - a.score);
  // Drop tail hits that are far weaker than the best one.
  const best = hits.length ? hits[0].score : 0;
  const top = hits.slice(0, k).filter((h, i) => i === 0 || h.score >= best * (opts.relCutoff ?? 0.5));
  const lowConfidence = !top.length || top[0].score < (opts.minScore ?? 0.18);
  if (opts.diff && opts.step != null && !lowConfidence) applyDiff(idx, hits, top, opts.step);
  const text = renderResult(idx, query, top, lowConfidence, sessionDir, opts.legend !== false, opts.step);
  return { hits: top, lowConfidence, text, tokens: estimateTokens(text) };
}

function pathOf(url: string): string {
  try { return new URL(url).pathname; } catch { return url; }
}

/** Mark unchanged hits and append changed regions (max 2) for step-to-step diffs. */
function applyDiff(idx: SessionIndex, ranked: Hit[], top: Hit[], step: number): void {
  const cur = idx.pages.find((p) => p.step === step);
  const prev = idx.pages.find((p) => p.step === step - 1);
  if (!cur || !prev || pathOf(cur.url) !== pathOf(prev.url)) return;
  for (const h of top) {
    if (h.chunk.steps.includes(prev.step)) h.sameAs = prev.step;
    else h.changed = true;
  }
  const extra = ranked.filter((h) => !top.includes(h) && !h.chunk.steps.includes(prev.step) && h.chunk.kind !== "item").slice(0, 2);
  for (const h of extra) { h.changed = true; top.push(h); }
}

function renderResult(idx: SessionIndex, query: string, hits: Hit[], low: boolean, sessionDir: string, legend: boolean, step?: number): string {
  const out: string[] = [];
  out.push("# pagesnap query: " + JSON.stringify(query));
  if (legend) out.push(LEGEND);
  const shownStep = (h: Hit) => (step != null && h.chunk.steps.includes(step) ? step : h.chunk.steps[0]);
  const steps = [...new Set(hits.map(shownStep))].sort((a, b) => a - b);
  if (low) {
    const best = hits[0] ? idx.pages.find((p) => p.step === hits[0].chunk.steps[0]) : idx.pages[idx.pages.length - 1];
    out.push("");
    out.push("_Low-confidence match: returning the whole compact page instead of guessing._");
    if (best) {
      const p = path.join(sessionDir, LEAN_DIR, best.file.replace(/\.ya?ml$/i, ".txt"));
      out.push(fs.existsSync(p) ? fs.readFileSync(p, "utf8").trimEnd() : best.header);
    }
    return out.join("\n") + "\n";
  }
  for (const s of steps) {
    const page = idx.pages.find((p) => p.step === s);
    if (!page) continue;
    out.push("");
    out.push(page.header);
    if (page.outline.length) out.push("outline:", ...page.outline.map((l) => " " + l));
    const mine = hits.filter((x) => shownStep(x) === s);
    const same = mine.filter((h) => h.sameAs != null);
    if (same.length) {
      out.push("--- " + same.length + " matching region(s) unchanged since step " + same[0].sameAs + " (omitted): "
        + [...new Set(same.map((h) => h.chunk.path))].join("; "));
    }
    for (const h of mine) {
      if (h.sameAs != null) continue;
      const others = h.chunk.steps.filter((x) => x !== s);
      const also = others.length ? " (also steps " + others.join(",") + ")" : "";
      out.push("--- " + h.chunk.path + " [" + h.chunk.kind + (h.changed ? ", CHANGED" : "") + ", score " + h.score.toFixed(2) + "]" + also);
      out.push(h.chunk.text);
    }
  }
  return out.join("\n") + "\n";
}

// ---------------------------------------------------------------- PACK.md

export function packMd(idx: SessionIndex): string {
  const pct = idx.stats.rawTokens ? Math.round((1 - idx.stats.compactTokens / idx.stats.rawTokens) * 100) : 0;
  const lines = [
    "# Lean pack",
    "",
    "Token-lean view of this session. Agents: do NOT read every NN_*.yaml.",
    "",
    "Ready-to-paste prompts: lean/AUTOMATE_PROMPT.md (Selenium Java test) and lean/TESTCASES_PROMPT.md (manual cases).",
    "",
    "1. Read SESSION.md, TEST_GUIDE.md and flow.md (small).",
    "2. For each flow step, fetch only the UI you need:",
    "   `npm run pack -- query <this-session-dir> \"<step text>\" [--step=N] [--k=4]`",
    "3. If a query says low-confidence, it returns the whole compact page (lean/NN_*.txt) instead.",
    "4. Use only locators shown after `=>`; never invent selectors.",
    "",
    "## Size (estimated tokens, ~4 chars/token)",
    "",
    "| | tokens |",
    "|---|---|",
    "| raw YAML, all steps | " + idx.stats.rawTokens + " |",
    "| compact lean/*.txt, all steps | " + idx.stats.compactTokens + " (-" + pct + "%) |",
    "| chunks indexed | " + idx.stats.chunkCount + " (embedder " + idx.embedder + ") |",
    "",
    "## Pages",
    "",
    ...idx.pages.map((p) => "- step " + p.step + ": " + p.url + " - raw " + p.rawTokens + " / compact " + p.compactTokens + " tokens (`lean/" + p.file.replace(/\.ya?ml$/i, ".txt") + "`)"),
    "",
  ];
  return lines.join("\n");
}
