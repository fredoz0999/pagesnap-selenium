/**
 * Live drift check: reopen each captured page and count how many elements every recorded locator matches now.
 * 1 = ok, 0 = gone, >1 = ambiguous. Uses playwright-core with your installed Chrome (set PAGESNAP_CHROME to a
 * Chrome/Chromium executable, or PAGESNAP_CHANNEL=msedge) purely as a fast way to count CSS / XPath / link-text
 * matches; it does not run Selenium.
 *
 * `--base-url` swaps the captured origin (check staging instead of the captured host). Pages that need app state
 * need --storage (a Playwright storageState JSON). Steps whose URL lands somewhere else are reported, not counted.
 */
import fs from "node:fs";
import path from "node:path";
import { parseSnapshot, walk, type Locator } from "./parse.js";
import { snapshotFiles } from "./index.js";

export interface VerifyItem {
  step: number;
  url: string;
  label: string;
  locator: Locator;
  count: number;
  /** state: the page no longer matches the capture as a whole; data: control named by data (expected to change) */
  status: "ok" | "gone" | "ambiguous" | "error" | "state" | "data";
}

export interface VerifyPage { step: number; url: string; landedOn: string; skipped?: string }

export interface VerifyReport {
  pages: VerifyPage[];
  items: VerifyItem[];
  counts: { ok: number; gone: number; ambiguous: number; error: number; state: number; data: number };
  text: string;
}

const ACTIONABLE = new Set(["button", "link", "textbox", "searchbox", "combobox", "listbox", "checkbox", "radio", "switch", "tab", "menuitem", "slider", "spinbutton"]);

/** Playwright selector string equivalent to the Selenium `By` for a PageSnap locator. */
export function toSelector(l: Locator): string | null {
  const q = (v: string) => v.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  switch (l.by) {
    case "id": return '[id="' + q(l.value) + '"]';
    case "name": return '[name="' + q(l.value) + '"]';
    case "css": return l.value;
    case "linkText": return 'a:text-is("' + q(l.value) + '")';
    case "xpath": return "xpath=" + l.value;
    default: return null;
  }
}

/** Selenium's By.linkText / partialLinkText compare the link's visible text (innerText), not textContent. */
async function countLinks(page: import("playwright-core").Page, text: string, partial: boolean): Promise<number> {
  return page.evaluate(([t, p]) => Array.from(document.querySelectorAll("a")).filter((a) => {
    const v = ((a as HTMLElement).innerText || "").replace(/\s+/g, " ").trim();
    return p ? v.includes(t as string) : v === t;
  }).length, [text, partial] as const);
}

function samePath(a: string, b: string): boolean {
  try {
    const x = new URL(a), y = new URL(b);
    const clean = (p: string) => p.replace(/;jsessionid=[^/]*/i, "");
    return x.host === y.host && clean(x.pathname) === clean(y.pathname);
  } catch {
    return a === b;
  }
}

export interface VerifyOptions {
  storage?: string;
  steps?: number[];
  baseUrl?: string;
  headless?: boolean;
  timeoutMs?: number;
}

export async function verifySession(sessionDir: string, opts: VerifyOptions = {}): Promise<VerifyReport> {
  let chromium: typeof import("playwright-core").chromium;
  try {
    ({ chromium } = await import("playwright-core"));
  } catch {
    throw new Error("verify needs playwright-core: cd pack && npm install");
  }
  const exe = process.env.PAGESNAP_CHROME;
  const browser = await chromium.launch({
    headless: opts.headless !== false,
    ...(exe ? { executablePath: exe } : { channel: process.env.PAGESNAP_CHANNEL || "chrome" }),
  });
  const items: VerifyItem[] = [];
  const pages: VerifyPage[] = [];
  const remap = (url: string): string => {
    if (!opts.baseUrl) return url;
    try { const u = new URL(url); return opts.baseUrl.replace(/\/$/, "") + u.pathname + u.search; } catch { return url; }
  };
  try {
    const hasStorage = !!(opts.storage && fs.existsSync(opts.storage));
    const context = await browser.newContext({ ignoreHTTPSErrors: true, storageState: hasStorage ? opts.storage : undefined });
    const page = await context.newPage();
    page.setDefaultTimeout(opts.timeoutMs ?? 15000);
    for (const f of snapshotFiles(sessionDir)) {
      const snap = parseSnapshot(fs.readFileSync(path.join(sessionDir, f), "utf8"), f);
      if (opts.steps && !opts.steps.includes(snap.step)) continue;
      const locs: { label: string; l: Locator }[] = [];
      walk(snap.roots, (n) => {
        if (!ACTIONABLE.has(n.role)) return;
        const l = n.locators.find((x) => x.matches == null);
        if (l && toSelector(l)) locs.push({ label: n.role + (n.name ? ' "' + n.name + '"' : ""), l });
      });
      const target = remap(snap.url);
      try {
        await page.goto(target, { waitUntil: "domcontentloaded" });
        await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => undefined);
      } catch (e) {
        pages.push({ step: snap.step, url: snap.url, landedOn: "", skipped: "navigation failed: " + (e instanceof Error ? e.message.split("\n")[0] : String(e)) });
        continue;
      }
      if (!samePath(page.url(), target)) {
        pages.push({ step: snap.step, url: snap.url, landedOn: page.url(), skipped: "redirected" + (hasStorage ? "" : " (needs --storage or app state)") });
        continue;
      }
      pages.push({ step: snap.step, url: snap.url, landedOn: page.url() });
      for (const { label, l } of locs) {
        let count = -1;
        try { count = l.by === "linkText" ? await countLinks(page, l.value, false) : await page.locator(toSelector(l)!).count(); } catch { /* invalid selector */ }
        items.push({ step: snap.step, url: snap.url, label, locator: l, count, status: count === 1 ? "ok" : count === 0 ? "gone" : count > 1 ? "ambiguous" : "error" });
      }
    }
  } finally {
    await browser.close();
  }
  // Mostly-missing page = captured in another app state, not locator drift; data-named controls are expected to change.
  for (const p of pages) {
    const mine = items.filter((i) => i.step === p.step);
    if (!mine.length) continue;
    const okShare = mine.filter((i) => i.status === "ok").length / mine.length;
    for (const i of mine) {
      if (i.status !== "gone") continue;
      const nm = /"([^"]*)"/.exec(i.label);
      if (nm && !/[a-z]{2}/i.test(nm[1])) i.status = "data";
      else if (okShare < 0.5) i.status = "state";
    }
    if (okShare < 0.5) p.skipped = "page state differs from the capture (" + Math.round(okShare * 100) + "% of locators found) - not counted as drift";
  }
  const counts = { ok: 0, gone: 0, ambiguous: 0, error: 0, state: 0, data: 0 };
  items.forEach((i) => counts[i.status]++);
  const lines = ["pagesnap verify: " + path.basename(sessionDir)];
  for (const p of pages) {
    const mine = items.filter((i) => i.step === p.step);
    lines.push("step " + p.step + " " + p.url + (p.skipped ? "  SKIPPED: " + p.skipped + (p.landedOn ? " -> " + p.landedOn : "") : "  " + mine.filter((i) => i.status === "ok").length + "/" + mine.length + " ok"));
    for (const i of mine.filter((x) => x.status !== "ok" && x.status !== "state")) {
      lines.push("  " + i.status.toUpperCase() + " " + i.label + "  " + i.locator.by + "=" + i.locator.value + (i.count > 1 ? " (" + i.count + " matches)" : ""));
    }
  }
  lines.push("", "ok " + counts.ok + " | gone " + counts.gone + " | ambiguous " + counts.ambiguous + " | error " + counts.error
    + " | data (expected to change) " + counts.data + " | other page state " + counts.state);
  if (counts.gone) lines.push("Gone locators: recapture the page, then `pack heal` suggests replacements.");
  return { pages, items, counts, text: lines.join("\n") + "\n" };
}

/** Playwright selector for a Selenium `By.<kind>("literal")` call written by hand in a Java test / page object. */
export function bySelector(kind: string, v: string): string | null {
  const q = (x: string) => x.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const xs = (x: string) => (x.includes("'") ? '"' + x + '"' : "'" + x + "'");
  switch (kind) {
    case "id": return '[id="' + q(v) + '"]';
    case "name": return '[name="' + q(v) + '"]';
    case "css": return v;
    case "xpath": return "xpath=" + v;
    case "linkText": return "xpath=//a[normalize-space()=" + xs(v) + "]";
    case "partialLinkText": return "xpath=//a[contains(normalize-space()," + xs(v) + ")]";
    case "className": return "." + v;
    default: return null;
  }
}

export interface JavaVerifyItem { file: string; line: number; call: string; perStep: { step: number; count: number }[]; status: "ok" | "ambiguous" | "gone" | "error" | "skipped" }

/**
 * Live check of the locators in YOUR Java code (custom XPath included): every By.* string literal is counted on
 * every captured page. ok = exactly one match on at least one page; ambiguous = only multi-matches; gone = zero
 * everywhere. Pages captured behind login/cart state need --storage, or they count as gone.
 */
export async function verifyJava(sessionDir: string, target: string, opts: VerifyOptions = {}): Promise<{ items: JavaVerifyItem[]; text: string; counts: Record<JavaVerifyItem["status"], number> }> {
  const { extractCalls, javaFiles } = await import("./validate.js");
  const { chromium } = await import("playwright-core");
  const exe = process.env.PAGESNAP_CHROME;
  const browser = await chromium.launch({ headless: opts.headless !== false, ...(exe ? { executablePath: exe } : { channel: process.env.PAGESNAP_CHANNEL || "chrome" }) });
  const calls = javaFiles(target).flatMap((file) => extractCalls(fs.readFileSync(file, "utf8")).map((c) => ({ file: path.relative(path.dirname(target), file) || path.basename(file), c })));
  const items: JavaVerifyItem[] = calls.map(({ file, c }) => ({ file, line: c.line, call: c.call, perStep: [], status: c.arg == null ? "skipped" : "gone" }));
  const remap = (url: string): string => {
    if (!opts.baseUrl) return url;
    try { const u = new URL(url); return opts.baseUrl.replace(/\/$/, "") + u.pathname + u.search; } catch { return url; }
  };
  try {
    const hasStorage = !!(opts.storage && fs.existsSync(opts.storage));
    const context = await browser.newContext({ ignoreHTTPSErrors: true, storageState: hasStorage ? opts.storage : undefined });
    const page = await context.newPage();
    page.setDefaultTimeout(opts.timeoutMs ?? 15000);
    const seen = new Set<string>();
    for (const f of snapshotFiles(sessionDir)) {
      const snap = parseSnapshot(fs.readFileSync(path.join(sessionDir, f), "utf8"), f);
      if (opts.steps && !opts.steps.includes(snap.step)) continue;
      const target2 = remap(snap.url).replace(/;jsessionid=[^/?#]*/i, "");
      if (seen.has(target2)) continue; // same URL = same fresh page; app state is not replayed
      seen.add(target2);
      try {
        await page.goto(target2, { waitUntil: "domcontentloaded" });
        await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => undefined);
      } catch { continue; }
      calls.forEach(({ c }, i) => { if (c.arg == null) return; items[i].perStep.push({ step: snap.step, count: -1 }); });
      for (let i = 0; i < calls.length; i++) {
        const c = calls[i].c;
        if (c.arg == null) continue;
        const sel = bySelector(c.kind, c.arg);
        let count = -1;
        try {
          if (c.kind === "linkText" || c.kind === "partialLinkText") count = await countLinks(page, c.arg, c.kind === "partialLinkText");
          else if (sel) count = await page.locator(sel).count();
        } catch { /* invalid */ }
        items[i].perStep[items[i].perStep.length - 1].count = count;
      }
    }
  } finally {
    await browser.close();
  }
  for (const it of items) {
    if (it.status === "skipped") continue;
    if (it.perStep.some((p) => p.count === 1)) it.status = "ok";
    else if (it.perStep.some((p) => p.count > 1)) it.status = "ambiguous";
    else if (it.perStep.length && it.perStep.every((p) => p.count < 0)) it.status = "error";
    else it.status = "gone";
  }
  const counts = { ok: 0, ambiguous: 0, gone: 0, error: 0, skipped: 0 };
  items.forEach((i) => counts[i.status]++);
  const icon = { ok: "OK  ", ambiguous: "AMBG", gone: "GONE", error: "ERR ", skipped: "SKIP" };
  const where = (it: JavaVerifyItem) => {
    const one = it.perStep.filter((p) => p.count === 1).map((p) => p.step);
    if (one.length) return "unique on step " + one.join(",");
    const many = it.perStep.filter((p) => p.count > 1);
    if (many.length) return many.map((p) => p.count + " matches on step " + p.step).join("; ") + " - Selenium takes the first";
    if (it.status === "error") return "invalid selector";
    if (it.status === "skipped") return "not a string literal";
    return "0 matches on every captured page (or the page needs app state: --storage)";
  };
  const text = ["pagesnap verify --java: " + items.length + " locator call(s), checked live",
    ...items.map((it) => icon[it.status] + " " + it.file + ":" + it.line + "  " + it.call + "  - " + where(it)),
    "", "ok " + counts.ok + " | ambiguous " + counts.ambiguous + " | gone " + counts.gone + " | error " + counts.error + " | skipped " + counts.skipped].join("\n") + "\n";
  return { items, text, counts };
}
