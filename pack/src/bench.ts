/**
 * Context-size benchmark: how many tokens an agent reads to cover the whole
 * captured flow under each approach. Estimates (~4 chars/token), not billed
 * usage, but every approach is measured the same way on the same pages.
 *
 *   raw        every NN_*.yaml (classic PageSnap prompt)
 *   compact    every lean/NN_*.txt
 *   query      one pagesnap query per flow step (note text, --step=N)
 *   query+diff same, with --diff
 *   aria       Playwright ariaSnapshot per step (what a live MCP browser tool
 *              returns at least once per step); only when NN_*.aria.txt exist
 *              (ScriptedSession { saveAria: true })
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { estimateTokens, parseSnapshot } from "./parse.js";
import { renderPom, buildPom } from "./pom.js";
import { buildIndex, LEAN_DIR, queryIndex, snapshotFiles } from "./index.js";

export interface BenchRow {
  approach: string;
  tokens: number;
  perStep: number[];
  note?: string;
}

export interface BenchReport {
  steps: number;
  rows: BenchRow[];
  text: string;
  markdown: string;
}

export async function bench(sessionDir: string, label = path.basename(sessionDir)): Promise<BenchReport> {
  await buildIndex(sessionDir);
  const files = snapshotFiles(sessionDir);
  const snaps = files.map((f) => parseSnapshot(fs.readFileSync(path.join(sessionDir, f), "utf8"), f));
  const raw = snaps.map((s) => estimateTokens(s.raw));
  const compact = files.map((f) => estimateTokens(fs.readFileSync(path.join(sessionDir, LEAN_DIR, f.replace(/\.ya?ml$/i, ".txt")), "utf8")));
  const q: number[] = [];
  const qd: number[] = [];
  for (const s of snaps) {
    const text = s.note || s.title || "page";
    // Legend once per session is enough for an agent; count it on step 1 only.
    q.push((await queryIndex(sessionDir, text, { step: s.step, legend: s === snaps[0] })).tokens);
    qd.push((await queryIndex(sessionDir, text, { step: s.step, diff: true, legend: s === snaps[0] })).tokens);
  }
  const pomMd = renderPom(buildPom(sessionDir), sessionDir).get("PAGES.md") || "";
  const pomTokens = estimateTokens(pomMd);
  const sum = (a: number[]) => a.reduce((x, y) => x + y, 0);
  const rows: BenchRow[] = [
    { approach: "raw YAML (all steps)", tokens: sum(raw), perStep: raw },
    { approach: "compact lean (all steps)", tokens: sum(compact), perStep: compact },
    { approach: "query per step", tokens: sum(q), perStep: q },
    { approach: "query --diff per step", tokens: sum(qd), perStep: qd },
    { approach: "PAGES.md + query --diff", tokens: pomTokens + sum(qd), perStep: qd, note: "PAGES.md " + pomTokens + " once" },
  ];
  const aria = files.map((f) => path.join(sessionDir, f.replace(/\.ya?ml$/i, ".aria.txt")));
  if (aria.every((p) => fs.existsSync(p))) {
    const a = aria.map((p) => estimateTokens(fs.readFileSync(p, "utf8")));
    rows.push({ approach: "Playwright ariaSnapshot per step (MCP-style)", tokens: sum(a), perStep: a, note: "minimum: one snapshot per step" });
  }
  const base = rows[0].tokens || 1;
  const pct = (t: number) => (t === base ? "baseline" : (t < base ? "-" : "+") + Math.round(Math.abs(1 - t / base) * 100) + "%");
  const text = [
    "pagesnap bench: " + label + " (" + snaps.length + " steps, ~4 chars/token)",
    ...rows.map((r) => r.approach.padEnd(46) + String(r.tokens).padStart(7) + "  " + pct(r.tokens).padStart(9) + (r.note ? "  (" + r.note + ")" : "")),
  ].join("\n") + "\n";
  const markdown = [
    "| Approach | Tokens for the whole flow | vs raw | Per step |",
    "|---|---|---|---|",
    ...rows.map((r) => "| " + r.approach + (r.note ? " (" + r.note + ")" : "") + " | " + r.tokens + " | " + pct(r.tokens) + " | " + r.perStep.join(" / ") + " |"),
  ].join("\n") + "\n";
  return { steps: snaps.length, rows, text, markdown };
}

export function benchTmpCopy(sessionDir: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ps-bench-"));
  fs.cpSync(sessionDir, dir, { recursive: true });
  return dir;
}
