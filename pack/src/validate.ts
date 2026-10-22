/**
 * Check a Selenium Java test's (or page object's) locators against the captured snapshots.
 * Pure string matching on files: costs no LLM tokens and catches invented
 * selectors before CI does.
 *
 * Reads `By.id("x")`, `By.name`, `By.cssSelector`, `By.linkText`, `By.partialLinkText`,
 * `By.xpath` and `By.className` string-literal calls. Non-literal arguments (variables,
 * concatenation) are reported as unverified.
 */
import { locatorHasDynamic } from "./dynamic.js";
import fs from "node:fs";
import path from "node:path";
import { parseSnapshot, walk, type Snapshot } from "./parse.js";
import { snapshotFiles } from "./index.js";

export type Status = "ok" | "missing" | "ambiguous" | "unverified" | "dynamic" | "fragile";

export interface Finding {
  file: string;
  line: number;
  call: string;
  status: Status;
  detail: string;
}

export interface Inventory {
  step: number;
  ids: Map<string, number>;
  names: Map<string, number>;
  css: Map<string, number>;
  linkText: Map<string, number>;
  xpath: Set<string>;
  /** all visible names/values/errors on the page, for text-ish checks */
  text: string[];
}

const inc = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) || 0) + 1);

export function inventoryOf(snap: Snapshot): Inventory {
  const inv: Inventory = { step: snap.step, ids: new Map(), names: new Map(), css: new Map(), linkText: new Map(), xpath: new Set(), text: [] };
  walk(snap.roots, (n) => {
    if (n.name) inv.text.push(n.name);
    for (const d of n.details) inv.text.push(d);
    for (const l of n.locators) {
      if (l.matches != null) continue;
      if (l.by === "id") inc(inv.ids, l.value);
      else if (l.by === "name") inc(inv.names, l.value);
      else if (l.by === "css") inc(inv.css, l.value);
      else if (l.by === "linkText") inc(inv.linkText, l.value);
      else if (l.by === "xpath") inv.xpath.add(l.value);
    }
  });
  for (const t of snap.tail) inv.text.push(t);
  return inv;
}

export interface Call {
  line: number;
  call: string;
  kind: "id" | "name" | "css" | "linkText" | "partialLinkText" | "xpath" | "className";
  arg: string | null;
}

const KIND: Record<string, Call["kind"]> = {
  id: "id", name: "name", cssSelector: "css", linkText: "linkText", partialLinkText: "partialLinkText", xpath: "xpath", className: "className",
};

/** `By.id("x")` -> kind + literal; `By.id(someVar)` -> arg null (dynamic). Comment lines are skipped. */
export function extractCalls(src: string): Call[] {
  const calls: Call[] = [];
  const lines = src.split("\n");
  const re = /By\.(id|name|cssSelector|linkText|partialLinkText|xpath|className)\(\s*("(?:\\.|[^"\\])*")?\s*([^)]*)\)/g;
  lines.forEach((text, i) => {
    if (/^\s*(\/\/|\*|\/\*)/.test(text)) return;
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      const literal = m[2] ? m[2].slice(1, -1).replace(/\\(.)/g, "$1") : null;
      const dynamic = !literal || m[3].trim().length > 0; // variable, or "a" + b
      calls.push({ line: i + 1, call: m[0].replace(/\s+/g, " "), kind: KIND[m[1]], arg: dynamic ? null : literal });
    }
  });
  return calls;
}

/**
 * Hand-written XPath / css review. Relative paths anchored on text, a label, a stable attribute or an axis
 * (following-sibling, parent, ancestor, contains) are how SDETs keep locators alive; absolute paths and
 * index-only chains break on the first layout change.
 */
export function lintXpath(x: string): string | null {
  const t = x.trim().replace(/^\(+/, "");
  if (/^\/(?!\/)/.test(t)) return "absolute XPath (/html/...) breaks on any layout change - anchor it: //label[normalize-space()='X']/following-sibling::input";
  const anchored = /@[\w-]+|text\(\)|normalize-space|contains\(|starts-with\(|::/.test(t);
  const indexes = (t.match(/\[\d+\]/g) || []).length;
  if (!anchored && indexes >= 1) return "index-only XPath (" + indexes + " position predicate(s), no text/attribute anchor) breaks when items are added or reordered";
  if (!anchored) return "XPath has no text, attribute or axis anchor - it matches by tag structure only";
  if (indexes >= 3) return "XPath leans on " + indexes + " position predicates - anchor on row/card text instead (//td[normalize-space()='X']/following-sibling::td)";
  return null;
}

export function lintCss(c: string): string | null {
  const nth = (c.match(/:nth-(child|of-type)\(/g) || []).length;
  if (nth >= 2) return "positional css (" + nth + " nth-child steps) breaks when the layout changes - use a stable attribute or an anchored XPath";
  return null;
}

function check(file: string, call: Call, invs: Inventory[]): Finding {
  const f = (status: Status, detail: string): Finding => ({ file, line: call.line, call: call.call, status, detail });
  if (call.arg == null) return f("unverified", "argument is not a plain string literal - checked at runtime only");
  const arg = call.arg;
  if (call.kind !== "linkText" && call.kind !== "partialLinkText" && locatorHasDynamic(call.kind === "className" ? "css" : call.kind, arg)) {
    return f("dynamic", "'" + arg + "' contains a generated value (id/counter/hash) that changes between runs - use a stable attribute: data-test, name, label text, placeholder");
  }
  const steps = (pred: (inv: Inventory) => number) => {
    const counts = invs.map((inv) => ({ step: inv.step, n: pred(inv) })).filter((x) => x.n > 0);
    if (!counts.length) return null;
    const unique = counts.filter((x) => x.n === 1).map((x) => x.step);
    if (unique.length) return f("ok", "steps " + unique.join(","));
    return f("ambiguous", counts.map((x) => "step " + x.step + ": " + x.n + " matches").join("; ") + " - Selenium takes the first match; scope it or use a more specific locator");
  };
  switch (call.kind) {
    case "id":
      return steps((i) => i.ids.get(arg) || 0) || f("missing", "no id '" + arg + "' in any snapshot");
    // Capture keeps at most two locators per control (best score first): an id is always kept when present,
    // but a name or link text can be dropped when a test id / id outranks it, so "not found" is only "unverified".
    case "name":
      return steps((i) => i.names.get(arg) || 0) || f("unverified", "name '" + arg + "' not recorded (capture keeps two locators per control) - prefer the recorded locator");
    case "linkText":
      return steps((i) => i.linkText.get(arg) || 0)
        || (invs.some((i) => i.text.some((t) => t === arg)) ? f("unverified", "link text '" + arg + "' seen as a name but not recorded as a locator") : f("missing", "no link text '" + arg + "' in any snapshot"));
    case "partialLinkText": {
      const hit = invs.filter((i) => [...i.linkText.keys()].some((t) => t.includes(arg))).map((i) => i.step);
      return hit.length ? f("ok", "steps " + hit.join(",")) : f("missing", "no link containing '" + arg + "' in any snapshot");
    }
    case "css": {
      const hit = steps((i) => i.css.get(arg) || 0);
      if (hit) return hit;
      const idm = /^#([\w-]+)$/.exec(arg);
      if (idm) return steps((i) => i.ids.get(idm[1]) || 0) || f("missing", "no id '" + idm[1] + "' in any snapshot");
      // A test id always outranks the other locators, so a data-test css that no snapshot recorded does not exist on a captured page.
      if (/^\[data-(?:testid|test|test-id|cy|qa)=/.test(arg)) return f("missing", "no test id " + arg + " in any snapshot");
      const cl = lintCss(arg);
      if (cl) return f("fragile", cl);
      return f("unverified", "css not recorded in a snapshot - check it live: pack verify <session> --java=<file>");
    }
    case "xpath":
      if (invs.some((i) => i.xpath.has(arg))) return f("ok", "xpath from snapshot");
      { const xl = lintXpath(arg); if (xl) return f("fragile", xl); }
      return f("unverified", "hand-written relative XPath (anchored) - not in a snapshot; check it live: pack verify <session> --java=<file>");
    case "className":
      return f("unverified", "class names are not recorded in snapshots");
  }
}

export function loadInventories(sessionDir: string): Inventory[] {
  return snapshotFiles(sessionDir).map((f) => inventoryOf(parseSnapshot(fs.readFileSync(path.join(sessionDir, f), "utf8"), f)));
}

export function javaFiles(p: string): string[] {
  const st = fs.statSync(p);
  if (st.isFile()) return [p];
  const out: string[] = [];
  for (const e of fs.readdirSync(p, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name.startsWith(".")) continue;
    const full = path.join(p, e.name);
    if (e.isDirectory()) out.push(...javaFiles(full));
    else if (e.name.endsWith(".java")) out.push(full);
  }
  return out.sort();
}

export interface ValidateReport {
  findings: Finding[];
  counts: Record<Status, number>;
  text: string;
}

/** `target` is a .java file or a folder searched recursively (e.g. src/test/java). */
export function validateJava(sessionDir: string, target: string): ValidateReport {
  const invs = loadInventories(sessionDir);
  const files = javaFiles(target);
  const findings = files.flatMap((file) => {
    const rel = path.relative(path.dirname(target), file) || path.basename(file);
    return extractCalls(fs.readFileSync(file, "utf8")).map((c) => check(rel, c, invs));
  });
  const counts: Record<Status, number> = { ok: 0, missing: 0, ambiguous: 0, unverified: 0, dynamic: 0, fragile: 0 };
  findings.forEach((x) => counts[x.status]++);
  const icon: Record<Status, string> = { ok: "OK  ", missing: "MISS", ambiguous: "AMBG", unverified: "????", dynamic: "DYN ", fragile: "FRAG" };
  const lines = [
    "pagesnap validate: " + files.length + " java file(s) vs " + invs.length + " snapshot(s)",
    ...findings.map((x) => icon[x.status] + " " + x.file + ":" + x.line + "  " + x.call + "  - " + x.detail),
    "",
    "ok " + counts.ok + " | missing " + counts.missing + " | ambiguous " + counts.ambiguous + " | unverified " + counts.unverified + " | dynamic " + counts.dynamic + " | fragile " + counts.fragile,
  ];
  return { findings, counts, text: lines.join("\n") + "\n" };
}
