/**
 * Compact a parsed snapshot into a token-lean text form.
 *
 * Savings come from (in rough order of impact):
 *  - repeated sibling subtrees (product cards, rows, menu items) collapsed to
 *    two examples + a name list; the rest stay retrievable as item chunks
 *  - one inline locator per control, without stability/score noise, and
 *    implied entirely when it equals the node's own role/name
 *  - nameless generic wrappers flattened, `- ` bullets and 2-space indents dropped
 *  - the duplicate "All <select> options" and hint footer blocks removed
 */
import { idSelector, type Locator, type SnapNode, type Snapshot } from "./parse.js";

export interface CNode {
  /** one compact line, no indentation */
  line: string;
  role: string;
  name: string;
  children: CNode[];
  /** collapsed same-shape siblings (kept for retrieval, not rendered) */
  collapsed?: CNode[];
}

export interface CompactOptions {
  /** collapse runs of at least this many same-shape siblings (default 3) */
  minRun?: number;
  /** examples to keep in full when collapsing (default 2) */
  keep?: number;
  /** max inline options for a native select (default 12) */
  maxOptions?: number;
}

const LANDMARK_LIKE = new Set([
  "banner", "navigation", "main", "contentinfo", "complementary", "form", "dialog",
  "alertdialog", "region", "search", "table", "grid", "list", "listbox", "menu",
  "menubar", "tablist", "tabpanel", "tree", "iframe", "article", "group",
]);

export function isLandmarkLike(role: string): boolean {
  return LANDMARK_LIKE.has(role);
}

function q(s: string): string {
  return '"' + s.replace(/"/g, '\\"') + '"';
}

/** Render one locator; empty string when it is implied by role + name. */
export function fmtLocator(l: Locator, node: { role: string; name: string }): string {
  const dup = l.matches != null ? " (x" + l.matches + " not unique)" : "";
  switch (l.by) {
    case "testid": return "testid=" + l.value + dup;
    case "id": return idSelector(l.value) + dup;
    case "name": return "[name=" + l.value + "]" + dup;
    case "role": {
      const implied = l.value === node.role && (l.name || "") === node.name;
      return implied && !dup ? "role" : "role=" + l.value + (l.name ? " name=" + q(l.name) : "") + dup;
    }
    case "label": return l.value === node.name && !dup ? "label" : "label=" + q(l.value) + dup;
    case "placeholder": return "placeholder=" + q(l.value) + dup;
    case "linkText": return l.value === node.name && !dup ? "link" : "link=" + q(l.value) + dup;
    case "css": return "css=" + l.value + dup;
    case "xpath": return "xpath=" + l.value + dup;
    default: return l.by + "=" + l.value + dup;
  }
}

function nodeLine(n: SnapNode, maxOptions: number): string {
  let s = n.role;
  if (n.name) s += " " + q(n.name);
  const flags = [...n.flags];
  const extras: string[] = [];
  for (const d of n.details) {
    const m = /^(value|error|validationMessage):\s*(.*)$/.exec(d);
    if (m) extras.push((m[1] === "validationMessage" ? "invalid-msg" : m[1]) + "=" + m[2]);
    else if (/^dropdown:\s*(open|closed)/.test(d)) flags.push("dropdown " + d.split(":")[1].trim());
    else extras.push(d);
  }
  if (flags.length) s += " [" + flags.join(", ") + "]";
  if (n.options.length) {
    const shown = n.options.slice(0, maxOptions).map((o) => o.replace(/ \[selected\]$/, "*").replace(/ \[([^\]]*)\]$/, "($1)"));
    s += " options=[" + shown.join("|") + (n.options.length > maxOptions ? "|+" + (n.options.length - maxOptions) : "") + "]";
  }
  if (extras.length) s += " " + extras.join(" ");
  const best = usefulLocators(n)[0];
  if (best) s += " => " + fmtLocator(best, n);
  return s;
}

const ACTIONABLE = new Set([
  "button", "link", "textbox", "searchbox", "combobox", "listbox", "option", "checkbox", "radio",
  "switch", "tab", "menuitem", "slider", "spinbutton", "treeitem", "gridcell",
]);

/** Structural nth-child css on a non-actionable node is noise for test generation. */
function usefulLocators(n: SnapNode): Locator[] {
  if (ACTIONABLE.has(n.role)) return n.locators;
  return n.locators.filter((l) => !(l.by === "css" && l.stability === "low"));
}

const TABLE_PARTS = new Set(["row", "cell", "gridcell", "columnheader", "rowheader", "rowgroup"]);

function isBareWrapper(n: SnapNode): boolean {
  return (n.role === "generic" || n.role === "group" || n.role === "none" || n.role === "presentation")
    && !n.name && !n.flags.length && !usefulLocators(n).length && !n.details.length && !n.options.length;
}

/** Structural signature: roles + locator kinds, names/values ignored. */
function signature(c: CNode): string {
  return c.role + "(" + c.children.map(signature).join(",") + ")";
}

function size(c: CNode): number {
  return 1 + c.children.reduce((a, k) => a + size(k), 0);
}

/** First meaningful name in a subtree, used to list collapsed items. */
export function labelOf(c: CNode): string {
  if (c.name) return c.name;
  for (const k of c.children) {
    const l = labelOf(k);
    if (l) return l;
  }
  return "";
}

function collapseRuns(kids: CNode[], minRun: number, keep: number): CNode[] {
  const out: CNode[] = [];
  let i = 0;
  while (i < kids.length) {
    const sig = signature(kids[i]);
    let j = i + 1;
    while (j < kids.length && signature(kids[j]) === sig) j++;
    const run = kids.slice(i, j);
    if (run.length >= minRun && size(run[0]) >= 2) {
      out.push(...run.slice(0, keep));
      const rest = run.slice(keep);
      const names = rest.map(labelOf).filter(Boolean);
      out.push({
        line: "... +" + rest.length + " more same-shape " + run[0].role + (names.length ? ": " + names.map(q).join(" | ") : "")
          + " (same locator pattern; query by name for exact locators)",
        role: "collapsed",
        name: "",
        children: [],
        collapsed: rest,
      });
    } else {
      out.push(...run);
    }
    i = j;
  }
  return out;
}

export function compactNodes(nodes: SnapNode[], opts: CompactOptions = {}): CNode[] {
  const minRun = opts.minRun ?? 3;
  const keep = opts.keep ?? 2;
  const maxOptions = opts.maxOptions ?? 12;
  const conv = (list: SnapNode[]): CNode[] => {
    const out: CNode[] = [];
    for (const n of list) {
      // A generic child that only repeats its parent's name (link > div text) adds nothing.
      const children = n.children.filter((c) => !(c.role === "generic" && c.name && c.name === n.name && !c.children.length && !usefulLocators(c).length));
      const kids = conv(children);
      // Empty table scaffolding (row / cell with no name): the table text is in the
      // "tables:" block; keep only the controls inside (links, inputs).
      if (TABLE_PARTS.has(n.role) && !n.name && !n.flags.length && !usefulLocators(n).length && !n.details.length) {
        out.push(...kids);
        continue;
      }
      if (isBareWrapper(n)) {
        // Single-child wrappers flatten away. Multi-child ones stay as a bare
        // "generic" line so repeated cards keep their boundaries and collapse.
        if (kids.length <= 1 || kids.every((k) => !k.children.length && kids.length < 3)) {
          out.push(...kids);
          continue;
        }
      }
      out.push({ line: nodeLine(n, maxOptions), role: n.role, name: n.name, children: collapseRuns(kids, minRun, keep) });
    }
    return out;
  };
  return collapseRuns(conv(nodes), minRun, keep);
}

export function renderNodes(nodes: CNode[], depth = 0): string[] {
  const out: string[] = [];
  for (const n of nodes) {
    out.push(" ".repeat(depth) + n.line);
    out.push(...renderNodes(n.children, depth + 1));
  }
  return out;
}

/** Keep table headers/rows; drop the select-options block and hint footer. */
export function compactTail(tail: string[]): string[] {
  const out: string[] = [];
  let section = "";
  for (const raw of tail) {
    const t = raw.replace(/^#\s?/, "");
    if (/^---/.test(t)) { section = t; if (/Tables/i.test(t)) out.push("tables:"); continue; }
    if (/Tables/i.test(section)) out.push(" " + t.trim());
  }
  return out;
}

export function testIdAttrs(snap: Snapshot): string[] {
  const set = new Set<string>();
  const visit = (ns: SnapNode[]) => ns.forEach((n) => {
    n.locators.forEach((l) => { if (l.by === "testid") set.add(l.attr || "data-testid"); });
    visit(n.children);
  });
  visit(snap.roots);
  return [...set];
}

export function snapshotHeaderLine(snap: Snapshot): string {
  const parts = ["step " + snap.step, snap.url];
  if (snap.title) parts.push(q(snap.title));
  if (snap.note) parts.push("note: " + snap.note);
  const attrs = testIdAttrs(snap);
  if (attrs.length && !(attrs.length === 1 && attrs[0] === "data-testid")) parts.push("testIdAttribute: " + attrs.join(","));
  return "@ " + parts.join(" | ");
}

export function compactSnapshot(snap: Snapshot, opts: CompactOptions = {}): string {
  const lines = [snapshotHeaderLine(snap), ...renderNodes(compactNodes(snap.roots, opts)), ...compactTail(snap.tail)];
  return lines.join("\n") + "\n";
}

export const LEGEND =
  "Legend: one node per line, 1-space indent = nesting. `=> x` is the verified locator (Selenium Java): " +
  "#id / id=V -> By.id(\"V\"); [name=V] -> By.name(\"V\"); css=S -> By.cssSelector(S) (a [data-test=\"x\"] css is the test id); " +
  "linkText=T -> By.linkText(T); xpath=X -> By.xpath(X). \"in=\" / \"dup k/n\" flags disambiguate repeats. " +
  "Never invent locators that are not shown.";
