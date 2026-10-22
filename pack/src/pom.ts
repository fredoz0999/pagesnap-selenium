/**
 * Deterministic Selenium Java page-object generator.
 *
 * Every captured control already has a live-verified locator, so page objects
 * can be written without an LLM. The agent then only writes the test flow
 * against named members, which costs fewer tokens and leaves no room to
 * invent selectors.
 *
 * Output (default src/test/java/pages/):
 *   BasePage.java     controls shared by half or more of the pages (header, nav, footer)
 *   <Name>Page.java   one class per distinct URL path; extends BasePage
 *   PAGES.md          member -> locator map (small, for the agent)
 *
 * Each member is a `public static final By FOO_BUTTON` plus a `fooButton()` method
 * returning the WebElement, so tests can use either WebDriverWait(By) or the element.
 */
import { locatorHasDynamic } from "./dynamic.js";
import fs from "node:fs";
import path from "node:path";
import { parseSnapshot, walk, type Locator, type SnapNode } from "./parse.js";
import { snapshotFiles } from "./index.js";

export interface PomMember {
  prop: string;
  constant: string;
  role: string;
  name: string;
  locator: Locator;
  by: string;
  fragile: boolean;
  dynamic?: boolean;
}

export interface PomPage {
  className: string;
  file: string;
  urlPath: string;
  steps: number[];
  members: PomMember[];
}

export interface PomResult {
  base: PomMember[];
  pages: PomPage[];
  files: string[];
}

const KEEP_ROLES = new Set([
  "button", "link", "textbox", "searchbox", "combobox", "listbox", "checkbox", "radio", "switch",
  "tab", "menuitem", "slider", "spinbutton", "option",
]);
const SUFFIX: Record<string, string> = {
  button: "Button", link: "Link", textbox: "Input", searchbox: "Search", combobox: "Select", listbox: "List",
  checkbox: "Checkbox", radio: "Radio", switch: "Switch", tab: "Tab", menuitem: "MenuItem", slider: "Slider",
  spinbutton: "Input", option: "Option", generic: "", heading: "Heading", alert: "Alert", table: "Table",
};

const TESTID_CSS = /^\[(data-(?:testid|test|test-id|cy|qa))=["']?([^"'\]]+)["']?\]$/;

/** `[data-test="x"]` -> "x" (the test id value), else null. */
export function testIdValue(l: Locator): string | null {
  if (l.by !== "css") return null;
  const m = TESTID_CSS.exec(l.value);
  return m ? m[2] : null;
}

function words(s: string): string[] {
  return s
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[^A-Za-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 8);
}

function camel(parts: string[]): string {
  const w = parts.map((p) => p.toLowerCase());
  const out = w.map((p, i) => (i === 0 ? p : p.charAt(0).toUpperCase() + p.slice(1))).join("");
  return /^[0-9]/.test(out) ? "n" + out : out || "element";
}

function pascal(parts: string[]): string {
  const c = camel(parts);
  return c.charAt(0).toUpperCase() + c.slice(1);
}

const JAVA_KEYWORDS = new Set(["abstract", "assert", "boolean", "break", "byte", "case", "catch", "char", "class", "const", "continue",
  "default", "do", "double", "else", "enum", "extends", "final", "finally", "float", "for", "goto", "if", "implements", "import",
  "instanceof", "int", "interface", "long", "native", "new", "package", "private", "protected", "public", "return", "short", "static",
  "strictfp", "super", "switch", "synchronized", "this", "throw", "throws", "transient", "try", "void", "volatile", "while"]);

function safeIdent(s: string): string {
  return JAVA_KEYWORDS.has(s) ? s + "_" : s;
}

function constantOf(prop: string): string {
  return prop.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toUpperCase();
}

function jstr(s: string): string {
  return '"' + s.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
}

/** Selenium `By` expression for a PageSnap locator. */
export function byCode(l: Locator): string {
  switch (l.by) {
    case "id": return "By.id(" + jstr(l.value) + ")";
    case "name": return "By.name(" + jstr(l.value) + ")";
    case "linkText": return "By.linkText(" + jstr(l.value) + ")";
    case "xpath": return "By.xpath(" + jstr(l.value) + ")";
    case "testid": return "By.cssSelector(" + jstr('[data-testid="' + l.value + '"]') + ")";
    default: return "By.cssSelector(" + jstr(l.value) + ")";
  }
}

function urlPathOf(url: string): string {
  try {
    return new URL(url).pathname.replace(/;jsessionid=[^/]*/i, "") || "/";
  } catch {
    return url;
  }
}

function classNameFor(urlPath: string): string {
  // Skip generated id segments (/product/01M5GND7...): name the page after the resource, not the record.
  const ID_SEG = /^([0-9A-HJKMNP-TV-Z]{26}|[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F-]+|[0-9a-f]{16,}|\d+)$/;
  const segs = urlPath.split("/").filter(Boolean);
  while (segs.length > 1 && ID_SEG.test(segs[segs.length - 1])) segs.pop();
  const last = ID_SEG.test(segs[segs.length - 1] || "") ? "" : segs[segs.length - 1] || "";
  const stem = last.replace(/\.(html?|htm|jsp|php|aspx?)$/i, "");
  const parts = words(stem);
  if (!parts.length || /^(index|home|default)$/i.test(stem)) return "HomePage";
  return pascal(parts) + "Page";
}

function bestLocator(n: SnapNode): Locator | null {
  const unique = n.locators.filter((l) => l.matches == null);
  const stable = unique.filter((l) => !locatorHasDynamic(l.by, l.value));
  const ok = stable.length ? stable : unique; // a generated value is used only when nothing stable exists
  if (!ok.length) return null;
  return ok.reduce((a, b) => ((b.score ?? 0) > (a.score ?? 0) ? b : a));
}

const identityValue = (l: Locator): string | null => testIdValue(l) ?? (l.by === "id" || l.by === "name" || l.by === "testid" ? l.value : null);

function memberBase(n: SnapNode, l: Locator): string[] {
  const idv = identityValue(l);
  // Repeated names (6x "Add to cart") and data text ("$29.99") make bad member names: the id carries the identity there.
  const repeated = n.flags.some((f) => /^dup \d+\/\d+$/.test(f) || f.startsWith("in="));
  const dataText = !KEEP_ROLES.has(n.role) || !/[a-z]{2}/i.test(n.name);
  if (idv && (repeated || dataText)) {
    const w = words(idv);
    if (w.length) return w;
  }
  if (l.by === "id" && n.name && /^[a-z][\w.-]*$/.test(n.name)) {
    const w = words(l.value);
    if (w.length) return w;
  }
  const base = n.name && n.name.length <= 40 ? words(n.name) : [];
  if (base.length) return base;
  if (idv) return words(idv);
  return [n.role];
}

function isDataNamed(n: SnapNode, l: Locator): boolean {
  if (identityValue(l)) return false;
  return !!n.name && !/[a-z]{2}/i.test(n.name);
}

function wanted(n: SnapNode): boolean {
  if (KEEP_ROLES.has(n.role)) return true;
  // test-id'd text the test may assert on (title, badge, error, balance)
  if (["generic", "heading", "alert", "table"].includes(n.role) && n.locators.some((l) => identityValue(l) != null)) return true;
  return false;
}

export function buildPom(sessionDir: string): Omit<PomResult, "files"> {
  const files = snapshotFiles(sessionDir);
  type Raw = { node: SnapNode; loc: Locator; key: string };
  const byPage = new Map<string, { steps: number[]; raws: Map<string, Raw> }>();
  const pagesPerKey = new Map<string, Set<string>>();

  for (const f of files) {
    const snap = parseSnapshot(fs.readFileSync(path.join(sessionDir, f), "utf8"), f);
    const up = urlPathOf(snap.url);
    const entry = byPage.get(up) || { steps: [] as number[], raws: new Map<string, Raw>() };
    entry.steps.push(snap.step);
    walk(snap.roots, (n) => {
      if (!wanted(n)) return;
      const l = bestLocator(n);
      if (!l || isDataNamed(n, l)) return;
      const key = l.by + "|" + l.value;
      if (!entry.raws.has(key)) entry.raws.set(key, { node: n, loc: l, key });
      const set = pagesPerKey.get(key) || new Set<string>();
      set.add(up);
      pagesPerKey.set(key, set);
    });
    byPage.set(up, entry);
  }

  const minPages = Math.max(2, Math.ceil(byPage.size / 2));
  const shared = new Set([...pagesPerKey.entries()].filter(([, s]) => s.size >= minPages).map(([k]) => k));
  const toMembers = (raws: Raw[], taken: Set<string>): PomMember[] => {
    const out: PomMember[] = [];
    for (const r of raws) {
      const suffix = SUFFIX[r.node.role] ?? "";
      const baseWords = memberBase(r.node, r.loc);
      let prop = camel(baseWords) + (suffix && !camel(baseWords).toLowerCase().endsWith(suffix.toLowerCase()) ? suffix : "");
      prop = safeIdent(prop);
      let i = 2;
      while (taken.has(prop)) prop = prop.replace(/\d+$/, "") + i++;
      taken.add(prop);
      out.push({
        prop,
        constant: constantOf(prop),
        role: r.node.role,
        name: r.node.name,
        locator: r.loc,
        by: byCode(r.loc),
        fragile: (r.loc.by === "xpath" && (r.loc.score ?? 0) < 60) || (r.loc.by === "css" && /nth-child/.test(r.loc.value)) || (r.loc.score ?? 100) <= 45 || locatorHasDynamic(r.loc.by, r.loc.value),
        dynamic: locatorHasDynamic(r.loc.by, r.loc.value),
      });
    }
    return out;
  };

  const sharedRaws: Raw[] = [];
  const seenShared = new Set<string>();
  for (const { raws } of byPage.values()) {
    for (const r of raws.values()) {
      if (shared.has(r.key) && !seenShared.has(r.key)) { seenShared.add(r.key); sharedRaws.push(r); }
    }
  }
  const baseTaken = new Set<string>(["driver", "open", "path", "wait"]);
  const base = toMembers(sharedRaws, baseTaken);

  const usedClass = new Set<string>(["BasePage"]);
  const pages: PomPage[] = [];
  for (const [urlPath, e] of byPage) {
    let className = classNameFor(urlPath);
    let i = 2;
    while (usedClass.has(className)) className = className.replace(/Page\d*$/, "") + "Page" + i++;
    usedClass.add(className);
    const own = [...e.raws.values()].filter((r) => !shared.has(r.key));
    const taken = new Set(baseTaken);
    for (const b of base) taken.add(b.prop);
    pages.push({ className, file: className + ".java", urlPath, steps: e.steps, members: toMembers(own, taken) });
  }
  return { base, pages };
}

function memberLines(ms: PomMember[]): string[] {
  const out: string[] = [];
  for (const m of ms) {
    const label = m.name ? m.role + ' "' + m.name.replace(/\*\//g, "") + '"' : m.role;
    out.push("    /** " + label + (m.dynamic ? " - DYNAMIC locator (generated value, will break next run): ask dev for a stable test id" : m.fragile ? " - FRAGILE locator, ask dev for a test id" : "") + " */");
    out.push("    public static final By " + m.constant + " = " + m.by + ";");
    out.push("");
    out.push("    public WebElement " + m.prop + "() {");
    out.push("        return driver.findElement(" + m.constant + ");");
    out.push("    }");
    out.push("");
  }
  if (out.length) out.pop();
  return out;
}

export function renderPom(p: Omit<PomResult, "files">, sessionDir: string, pkg = "pages"): Map<string, string> {
  const files = new Map<string, string>();
  const header = "// Generated by pagesnap pack pom from " + path.basename(sessionDir) + ". Regenerate instead of editing locators by hand.\n";
  const pk = pkg ? "package " + pkg + ";\n\n" : "";
  files.set("BasePage.java", [
    header + pk + "import org.openqa.selenium.By;",
    "import org.openqa.selenium.WebDriver;",
    "import org.openqa.selenium.WebElement;",
    "",
    "/** Controls present on half or more of the captured pages (header, nav, footer). */",
    "public class BasePage {",
    "    protected final WebDriver driver;",
    "",
    "    public BasePage(WebDriver driver) {",
    "        this.driver = driver;",
    "    }",
    ...(p.base.length ? [""] : []),
    ...memberLines(p.base),
    "}",
    "",
  ].join("\n"));
  for (const pg of p.pages) {
    files.set(pg.file, [
      header + pk + "import org.openqa.selenium.By;",
      "import org.openqa.selenium.WebDriver;",
      "import org.openqa.selenium.WebElement;",
      "",
      "/** " + pg.urlPath + " (captured at step " + pg.steps.join(", ") + ") */",
      "public class " + pg.className + " extends BasePage {",
      "    public static final String PATH = " + jstr(pg.urlPath) + ";",
      "",
      "    public " + pg.className + "(WebDriver driver) {",
      "        super(driver);",
      "    }",
      "",
      "    public " + pg.className + " open(String baseUrl) {",
      "        driver.get(baseUrl + PATH);",
      "        return this;",
      "    }",
      ...(pg.members.length ? [""] : []),
      ...memberLines(pg.members),
      "}",
      "",
    ].join("\n"));
  }
  const md: string[] = [
    "# Page objects (generated)",
    "",
    "Use these members in tests instead of raw selectors. Each has a `By` constant (for WebDriverWait) and a method returning the WebElement.",
  ];
  const section = (title: string, ms: PomMember[]) => {
    md.push("", "## " + title);
    for (const m of ms) md.push("- " + m.prop + "() / " + m.constant + " = " + m.role + (m.name ? ' "' + m.name + '"' : "") + (m.fragile ? " (fragile)" : ""));
  };
  section("BasePage (on half or more of the pages; every page class extends it)", p.base);
  for (const pg of p.pages) section(pg.className + " " + pg.urlPath + " (steps " + pg.steps.join(",") + ")", pg.members);
  files.set("PAGES.md", md.join("\n") + "\n");
  return files;
}

export function writePom(sessionDir: string, outDir: string, pkg = "pages"): PomResult {
  const p = buildPom(sessionDir);
  const rendered = renderPom(p, sessionDir, pkg);
  fs.mkdirSync(outDir, { recursive: true });
  const written: string[] = [];
  for (const [f, body] of rendered) {
    const target = path.join(outDir, f);
    fs.writeFileSync(target, body, "utf8");
    written.push(target);
  }
  return { ...p, files: written };
}
