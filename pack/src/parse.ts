/**
 * Parse a PageSnap YAML snapshot (NN_<host>.yaml) into a node tree.
 *
 * The capture format is line-oriented and produced by capture-tree.js:
 *   # URL: …            header comments
 *   - role "name" [flags]:
 *     value: "…"
 *     locators:
 *       - {by: testid, value: "x", attr: data-test, stability: high, score: 98}
 *     options:  # native <select> …
 *       - option "A" [selected]
 *   # --- Tables (headers + first rows) ---   tail comments
 */

export interface Locator {
  by: string;
  value: string;
  name?: string;
  attr?: string;
  stability?: string;
  score?: number;
  matches?: number;
}

export interface SnapNode {
  role: string;
  name: string;
  flags: string[];
  depth: number;
  /** value:, dropdown:, error:, validationMessage: lines (already trimmed) */
  details: string[];
  options: string[];
  locators: Locator[];
  children: SnapNode[];
}

export interface Snapshot {
  file: string;
  step: number;
  url: string;
  title: string;
  note: string;
  header: string[];
  roots: SnapNode[];
  /** tail "# --- Tables / All <select> options" comment block, trimmed */
  tail: string[];
  raw: string;
}

const NODE_RE = /^(\s*)- ([a-zA-Z][\w-]*)(?: "((?:[^"\\]|\\.)*)")?(?: \[([^\]]*)\])?(:)?\s*$/;

export function unesc(s: string): string {
  return s.replace(/\\(.)/g, "$1");
}

/** Parse `{by: testid, value: "x", name: "y", attr: data-test, score: 98}`. */
export function parseLocator(text: string): Locator | null {
  const body = text.trim().replace(/^-\s*/, "");
  if (!body.startsWith("{") || !body.endsWith("}")) return null;
  const inner = body.slice(1, -1);
  const out: Record<string, string> = {};
  const re = /(\w+):\s*(?:"((?:[^"\\]|\\.)*)"|([^,}]+))/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(inner))) {
    out[m[1]] = m[2] != null ? unesc(m[2]) : m[3].trim();
  }
  if (!out.by || out.value == null) return null;
  const loc: Locator = { by: out.by, value: out.value };
  if (out.name) loc.name = out.name;
  if (out.attr) loc.attr = out.attr;
  if (out.stability) loc.stability = out.stability;
  if (out.score) loc.score = Number(out.score);
  if (out.matches) loc.matches = Number(out.matches);
  return loc;
}

function splitFlags(raw?: string): string[] {
  if (!raw) return [];
  const out: string[] = [];
  let cur = "";
  let q = false;
  for (const ch of raw) {
    if (ch === '"') q = !q;
    if (ch === "," && !q) {
      if (cur.trim()) out.push(cur.trim());
      cur = "";
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

export function parseSnapshot(raw: string, file = ""): Snapshot {
  const lines = raw.split(/\r?\n/);
  const header: string[] = [];
  const tail: string[] = [];
  const roots: SnapNode[] = [];
  const stack: SnapNode[] = [];
  let i = 0;
  // Header: leading comment/blank lines until the first tree line.
  while (i < lines.length && !lines[i].trimStart().startsWith("- ")) {
    if (lines[i].trim()) header.push(lines[i]);
    i++;
  }
  let mode: "none" | "locators" | "options" = "none";
  for (; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (line.startsWith("#")) {
      // Tail comment blocks: tables, all <select> options, hint footer.
      tail.push(trimmed);
      continue;
    }
    const cur = stack[stack.length - 1];
    if (mode === "options" && trimmed.startsWith("- option ")) {
      const om = /^- option "((?:[^"\\]|\\.)*)"(?: \[([^\]]*)\])?/.exec(trimmed);
      if (om && cur) cur.options.push(unesc(om[1]) + (om[2] ? " [" + om[2] + "]" : ""));
      continue;
    }
    if (mode === "locators" && trimmed.startsWith("- {")) {
      const loc = parseLocator(trimmed);
      if (loc && cur) cur.locators.push(loc);
      continue;
    }
    const m = NODE_RE.exec(line);
    if (m) {
      const depth = Math.floor(m[1].length / 2);
      const node: SnapNode = {
        role: m[2],
        name: m[3] != null ? unesc(m[3]) : "",
        flags: splitFlags(m[4]),
        depth,
        details: [],
        options: [],
        locators: [],
        children: [],
      };
      while (stack.length && stack[stack.length - 1].depth >= depth) stack.pop();
      if (stack.length) stack[stack.length - 1].children.push(node);
      else roots.push(node);
      stack.push(node);
      mode = "none";
      continue;
    }
    if (!cur) continue;
    if (trimmed === "locators:") { mode = "locators"; continue; }
    if (trimmed.startsWith("options:")) { mode = "options"; continue; }
    mode = "none";
    cur.details.push(trimmed);
  }
  const h = (k: string) => {
    const hit = header.find((l) => l.startsWith("# " + k + ":"));
    return hit ? hit.slice(k.length + 3).trim() : "";
  };
  const stepFromFile = /^(\d+)_/.exec(file.split(/[\\/]/).pop() || "");
  return {
    file,
    step: Number(h("Step")) || (stepFromFile ? Number(stepFromFile[1]) : 0),
    url: h("URL"),
    title: h("Title"),
    note: h("Note"),
    header,
    roots,
    tail,
    raw,
  };
}

/** Depth-first visit with ancestor path. */
export function walk(nodes: SnapNode[], fn: (n: SnapNode, path: SnapNode[]) => void, path: SnapNode[] = []): void {
  for (const n of nodes) {
    fn(n, path);
    walk(n.children, fn, [...path, n]);
  }
}

/** Rough token estimate (~4 chars/token for English + code). */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * CSS selector for an element id. "#customer.firstName" would mean id=customer
 * with class firstName, so ids that are not plain identifiers use [id="..."].
 */
export function idSelector(id: string): string {
  return /^[A-Za-z_][\w-]*$/.test(id) ? "#" + id : '[id="' + id.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"]';
}
