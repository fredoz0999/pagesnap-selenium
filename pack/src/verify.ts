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
        try { count = await page.locator(toSelector(l)!).count(); } catch { /* invalid selector */ }
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
