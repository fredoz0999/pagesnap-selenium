/**
 * Self-heal for Selenium Java: for By.* locators in a test/page object that are missing or ambiguous in the
 * snapshots, or that a Selenium/Maven run reported as failing, suggest the closest captured control and
 * its verified locator.
 *
 * `--write` replaces the call only when the best candidate is clearly ahead (confidence >= 0.75 and a 0.15
 * margin over the runner-up) and the finding is a missing locator (never for ambiguous ones).
 */
import { locatorHasDynamic } from "./dynamic.js";
import fs from "node:fs";
import path from "node:path";
import { parseSnapshot, walk } from "./parse.js";
import { snapshotFiles } from "./index.js";
import { extractCalls, validateJava, type Finding } from "./validate.js";
import { byCode, testIdValue } from "./pom.js";
import { tokenize } from "./embed.js";

export interface Candidate {
  step: number;
  role: string;
  name: string;
  by: string;
  value: string;
  code: string;
  score: number;
}

export interface HealSuggestion {
  file: string;
  line: number;
  call: string;
  reason: string;
  candidates: Candidate[];
  applied?: string;
}

export interface HealReport {
  suggestions: HealSuggestion[];
  written: number;
  text: string;
}

type Idf = (t: string) => number;

function makeIdf(docs: string[][]): Idf {
  const df = new Map<string, number>();
  for (const d of docs) for (const t of new Set(d)) df.set(t, (df.get(t) || 0) + 1);
  const n = Math.max(1, docs.length);
  return (t) => Math.log(1 + n / (1 + (df.get(t) || 0)));
}

function sim(a: string, b: string, idf: Idf): number {
  const ta = new Set(tokenize(a));
  const tb = new Set(tokenize(b));
  if (!ta.size || !tb.size) return 0;
  const w = (set: Set<string>) => [...set].reduce((x, t) => x + idf(t), 0);
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter += idf(t);
  const wa = w(ta), wb = w(tb);
  const jacc = inter / (wa + wb - inter);
  const overlap = inter / Math.min(wa, wb);
  const tokenScore = 0.6 * overlap + 0.4 * jacc;
  // character bigrams catch respellings (user_name -> username, loginBtn -> login-button)
  const grams = (x: string) => {
    const y = x.toLowerCase().replace(/[^a-z0-9]/g, "");
    const g = new Set<string>();
    for (let i = 0; i + 2 <= y.length; i++) g.add(y.slice(i, i + 2));
    return g;
  };
  const ga = grams(a), gb = grams(b);
  let gi = 0;
  for (const g of ga) if (gb.has(g)) gi++;
  const dice = ga.size + gb.size ? (2 * gi) / (ga.size + gb.size) : 0;
  return tokenScore > 0 ? Math.max(tokenScore, dice * 0.6) : dice * 0.9;
}

/** The thing the caller was looking for, in words: `By.id("user_name")` -> user_name, `[data-test="login"]` -> login. */
export function wantedText(callText: string): string {
  const arg = /By\.\w+\(\s*"((?:\\.|[^"\\])*)"/.exec(callText)?.[1]?.replace(/\\(.)/g, "$1") ?? "";
  const tid = /^\[data-[\w-]+=["']?([^"'\]]+)["']?\]$/.exec(arg);
  if (tid) return tid[1];
  const nm = /\[(?:name|id)=["']?([^"'\]]+)["']?\]/.exec(arg);
  if (nm) return nm[1];
  return arg.replace(/^[#.]/, "").replace(/^\/\/\*?/, "").trim();
}

interface Pool { ctl: string; step: number; role: string; name: string; by: string; value: string; uScore: number }

function poolFor(sessionDir: string): Pool[] {
  const out: Pool[] = [];
  for (const f of snapshotFiles(sessionDir)) {
    const snap = parseSnapshot(fs.readFileSync(path.join(sessionDir, f), "utf8"), f);
    let nodeNo = 0;
    walk(snap.roots, (n) => {
      nodeNo++;
      for (const l of n.locators) {
        if (l.matches != null || locatorHasDynamic(l.by, l.value)) continue; // never suggest a generated value as the fix
        out.push({ ctl: "n" + nodeNo, step: snap.step, role: n.role, name: n.name, by: l.by, value: l.value, uScore: l.score ?? 60 });
      }
    });
  }
  return out;
}

export function rankCandidates(sessionDir: string, callText: string, max = 3): Candidate[] {
  const want = wantedText(callText);
  if (!want) return [];
  const wantRole = /By\.linkText|By\.partialLinkText/.test(callText) ? "link" : undefined;
  const pool = poolFor(sessionDir);
  const idf = makeIdf(pool.map((p) => tokenize(p.role + " " + p.name + " " + p.value)));
  const byControl = new Map<string, { s: number; best: Pool }>();
  for (const p of pool) {
    const idish = testIdValue({ by: p.by, value: p.value }) ?? p.value;
    let s = Math.max(sim(want, p.name, idf), sim(want, idish, idf) * 0.95);
    if (wantRole && p.role === wantRole) s += 0.1;
    if (wantRole && p.role && p.role !== wantRole) s -= 0.1;
    const key = p.step + "|" + p.ctl;
    const cur = byControl.get(key);
    if (!cur) byControl.set(key, { s, best: p });
    else {
      cur.s = Math.max(cur.s, s);
      if (p.uScore > cur.best.uScore) cur.best = p; // most reliable locator for the control
    }
  }
  const seen = new Set<string>();
  return [...byControl.values()]
    .filter((x) => x.s >= 0.3)
    .sort((a, b) => b.s - a.s || b.best.uScore - a.best.uScore)
    .map((x) => ({ step: x.best.step, role: x.best.role, name: x.best.name, by: x.best.by, value: x.best.value, code: byCode({ by: x.best.by, value: x.best.value }), score: Math.min(1, x.s) }))
    .filter((c) => { if (seen.has(c.code)) return false; seen.add(c.code); return true; })
    .slice(0, max)
    .map((c) => ({ ...c, score: Math.round(c.score * 100) / 100 }));
}

/**
 * Selectors a Selenium failure log names. Selenium 4 reports By.id/By.name as css (`[id="x"]`, `[name="x"]`),
 * By.linkText as `link text`, and older drivers say `Unable to locate element: {"method":"id","selector":"x"}`.
 */
export function failingLocatorsFromLog(log: string): { by: string; value: string }[] {
  const out: { by: string; value: string }[] = [];
  const seen = new Set<string>();
  const add = (by: string, value: string) => { const k = by + "|" + value; if (!seen.has(k)) { seen.add(k); out.push({ by, value }); } };
  const re = /"method"\s*:\s*"([^"]+)"\s*,\s*"selector"\s*:\s*"((?:\\.|[^"\\])*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(log))) {
    const value = m[2].replace(/\\(.)/g, "$1");
    const method = m[1];
    if (method === "css selector") {
      const idm = /^\[id="([^"]+)"\]$/.exec(value);
      const nm = /^\[name="([^"]+)"\]$/.exec(value);
      if (idm) add("id", idm[1]);
      else if (nm) add("name", nm[1]);
      else add("css", value);
    } else if (method === "link text") add("linkText", value);
    else if (method === "partial link text") add("partialLinkText", value);
    else if (method === "xpath") add("xpath", value);
    else if (method === "id") add("id", value);
    else if (method === "name") add("name", value);
  }
  return out;
}

const CALL_FOR: Record<string, string> = { id: "id", name: "name", css: "cssSelector", linkText: "linkText", partialLinkText: "partialLinkText", xpath: "xpath" };

/** Replace `By.<m>("arg")` for a specific literal on one line. */
export function replaceBy(line: string, method: string, arg: string, code: string): string {
  const esc = arg.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const lit = '"' + esc + '"';
  const re = new RegExp("By\\." + method + "\\(\\s*" + lit.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s*\\)");
  return line.replace(re, code);
}

function javaFiles(p: string): string[] {
  const st = fs.statSync(p);
  if (st.isFile()) return [p];
  const out: string[] = [];
  for (const e of fs.readdirSync(p, { withFileTypes: true })) {
    if (e.name.startsWith(".") || e.name === "node_modules") continue;
    const full = path.join(p, e.name);
    if (e.isDirectory()) out.push(...javaFiles(full));
    else if (e.name.endsWith(".java")) out.push(full);
  }
  return out.sort();
}

export function healJava(sessionDir: string, target: string, opts: { log?: string; write?: boolean } = {}): HealReport {
  const rep = validateJava(sessionDir, target);
  const abs = (rel: string) => (fs.statSync(target).isFile() ? target : path.join(path.dirname(target), rel));
  const targets: { file: string; line: number; call: string; reason: string; method: string; arg: string | null }[] = [];
  const methodOf = (call: string) => /By\.(\w+)\(/.exec(call)?.[1] ?? "";
  const argOf = (call: string) => /By\.\w+\(\s*"((?:\\.|[^"\\])*)"\s*\)/.exec(call)?.[1]?.replace(/\\(.)/g, "$1") ?? null;
  for (const f of rep.findings as Finding[]) {
    if (f.status !== "missing" && f.status !== "ambiguous") continue;
    targets.push({ file: f.file, line: f.line, call: f.call, reason: f.status + ": " + f.detail, method: methodOf(f.call), arg: argOf(f.call) });
  }
  if (opts.log) {
    for (const bad of failingLocatorsFromLog(opts.log)) {
      for (const file of javaFiles(target)) {
        const rel = path.relative(path.dirname(target), file) || path.basename(file);
        for (const c of extractCalls(fs.readFileSync(file, "utf8"))) {
          if (c.arg == null || CALL_FOR[bad.by] !== c.kind && !(c.kind === "css" && bad.by === "css")) continue;
          if (c.arg !== bad.value) continue;
          if (targets.some((t) => t.file === rel && t.line === c.line)) continue;
          targets.push({ file: rel, line: c.line, call: c.call, reason: "failed in run", method: c.kind === "css" ? "cssSelector" : c.kind, arg: c.arg });
        }
      }
    }
  }
  const touched = new Map<string, string>();
  let written = 0;
  const suggestions: HealSuggestion[] = targets.map((t) => {
    const candidates = rankCandidates(sessionDir, t.call);
    const s: HealSuggestion = { file: t.file, line: t.line, call: t.call, reason: t.reason, candidates };
    const [a, b] = candidates;
    if (opts.write && a && t.arg != null && a.score >= 0.75 && (!b || a.score - b.score >= 0.15) && !t.reason.startsWith("ambiguous")) {
      const file = abs(t.file);
      const lines = (touched.get(file) ?? fs.readFileSync(file, "utf8")).split("\n");
      const before = lines[t.line - 1];
      const after = replaceBy(before, t.method, t.arg, a.code);
      if (after !== before) {
        lines[t.line - 1] = after;
        touched.set(file, lines.join("\n"));
        s.applied = a.code;
        written++;
      }
    }
    return s;
  });
  for (const [file, body] of touched) fs.writeFileSync(file, body, "utf8");
  const text = [
    "pagesnap heal: " + path.basename(target),
    ...(suggestions.length ? [] : ["Nothing to heal: every locator is in the snapshots."]),
    ...suggestions.flatMap((s) => [
      s.file + ":" + s.line + "  " + s.call + "  (" + s.reason + ")" + (s.applied ? "  -> REPLACED with " + s.applied : ""),
      ...(s.candidates.length
        ? s.candidates.map((c, i) => "   " + (i + 1) + ". " + c.code + "   [" + c.role + (c.name ? ' "' + c.name + '"' : "") + ", step " + c.step + ", confidence " + c.score + "]")
        : ["   no close match in the snapshots - recapture this page"]),
    ]),
  ].join("\n") + "\n";
  return { suggestions, written, text };
}
