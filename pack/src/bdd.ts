/**
 * Cucumber (Gherkin + step definitions) generator for Selenium Java.
 *
 * Deterministic, no LLM: each captured step note (`action:` / `assert:` / `data:`) is split into clauses, each
 * clause is matched to the closest captured control (the page-object members from `pom`), and a Gherkin step plus
 * a Cucumber-JVM step definition bound to that member is written. Clauses that match nothing become `Pending`
 * steps that say exactly what is missing, so nothing is invented.
 *
 * Output:
 *   <features>/<slug>.feature
 *   <steps>/<Slug>Steps.java        step definitions using the generated page objects (run `pom` first/with it)
 *   <steps>/RunCucumberTest.java    only with --runner=testng|junit (your project probably has its own runner)
 */
import fs from "node:fs";
import path from "node:path";
import { parseSnapshot } from "./parse.js";
import { snapshotFiles } from "./index.js";
import { tokenize } from "./embed.js";
import { buildPom, type PomMember, type PomPage } from "./pom.js";
import { inventoryOf } from "./validate.js";
import { sessionGoal, slugify } from "./prompts.js";

export interface BddOptions {
  featuresDir: string;
  stepsDir: string;
  /** Java package of the step definitions (glue) */
  stepsPackage?: string;
  /** Java package of the generated page objects */
  pagesPackage?: string;
  /** Java expression returning the WebDriver, e.g. "DriverManager.getDriver()" */
  driver?: string;
  assertions?: "testng" | "junit";
  runner?: "testng" | "junit" | null;
  tags?: string;
  baseUrl?: string;
}

export interface BddResult {
  feature: string;
  steps: string;
  runner?: string;
  generated: number;
  pending: { step: number; text: string; reason: string }[];
  gherkin: string;
}

type Kind = "action" | "assert" | "data" | "plain";
interface Clause { kind: Kind; text: string }

export function parseNote(note: string): Clause[] {
  const out: Clause[] = [];
  const parts = note.split(/(?=\b(?:action|assert|data):)/i).map((p) => p.trim()).filter(Boolean);
  for (const p of parts) {
    const m = /^(action|assert|data):\s*(.*)$/is.exec(p);
    if (m) out.push({ kind: m[1].toLowerCase() as Kind, text: m[2].trim() });
    else out.push({ kind: "plain", text: p });
  }
  return out;
}

const jstr = (s: string) => '"' + s.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
/** Escape Cucumber-expression metacharacters in literal step text. */
const cx = (s: string) => s.replace(/[\\(){}/]/g, (c) => "\\" + c);
const pascal = (s: string) => s.split(/[^A-Za-z0-9]+/).filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join("");
const humanize = (prop: string) => prop.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase();
const quoted = (s: string): string[] => [...s.matchAll(/"([^"]+)"|'([^']+)'|“([^”]+)”/g)].map((m) => m[1] ?? m[2] ?? m[3]);

interface Cand { m: PomMember; owner: string; doc: string[] }
const STOPWORDS = new Set(["click", "press", "tap", "enter", "type", "fill", "select", "choose", "check", "see", "the", "a", "an", "to", "on", "in", "into", "from", "of", "is", "are", "and", "page", "button", "link", "field", "input"]);

function rank(text: string, cands: Cand[], idf: (t: string) => number): { best: Cand; score: number; margin: number } | null {
  const want = [...new Set(tokenize(text))].filter((t) => !STOPWORDS.has(t));
  if (!want.length || !cands.length) return null;
  const wsum = want.reduce((a, t) => a + idf(t), 0);
  const scored = cands.map((c) => {
    const have = new Set(c.doc);
    const hit = want.filter((t) => have.has(t)).reduce((a, t) => a + idf(t), 0);
    const extra = [...have].filter((t) => !want.includes(t) && !STOPWORDS.has(t)).reduce((a, t) => a + idf(t), 0);
    return { c, score: hit / wsum - 0.05 * (extra / Math.max(1, wsum)) };
  }).sort((a, b) => b.score - a.score);
  const [a, b] = scored;
  return { best: a.c, score: a.score, margin: a.score - (b ? b.score : 0) };
}

export function generateBdd(sessionDir: string, o: BddOptions): BddResult {
  const pkg = o.stepsPackage ?? "steps";
  const pagesPkg = o.pagesPackage ?? "pages";
  const driverExpr = o.driver ?? "DriverManager.getDriver()";
  const lib = o.assertions ?? "testng";
  const pom = buildPom(sessionDir);
  const files = snapshotFiles(sessionDir);
  const snaps = files.map((f) => parseSnapshot(fs.readFileSync(path.join(sessionDir, f), "utf8"), f));
  const goal = sessionGoal(sessionDir) || snaps[0]?.title || "Captured flow";
  const slug = slugify(goal);
  const className = pascal(slug) + "Steps";
  const origin = (() => { try { return new URL(snaps[0].url).origin; } catch { return ""; } })();
  const baseUrl = o.baseUrl ?? origin;

  const pageOf = (step: number): PomPage | undefined => pom.pages.find((p) => p.steps.includes(step));
  const ownerOf = (m: PomMember): string => (pom.base.includes(m) ? "BasePage" : pom.pages.find((p) => p.members.includes(m))!.className);
  const candsFor = (pg: PomPage | undefined): Cand[] =>
    [...(pg ? pg.members : []), ...pom.base].map((m) => ({
      m, owner: ownerOf(m),
      doc: [...new Set(tokenize([humanize(m.prop), m.name, m.role].join(" ")))],
    }));
  const allDocs = [...pom.base, ...pom.pages.flatMap((p) => p.members)].map((m) => tokenize(humanize(m.prop) + " " + m.name));
  const df = new Map<string, number>();
  for (const d of allDocs) for (const t of new Set(d)) df.set(t, (df.get(t) || 0) + 1);
  const idf = (t: string) => Math.log(1 + Math.max(1, allDocs.length) / (1 + (df.get(t) || 0)));

  const defs = new Map<string, { annotation: string; expr: string; params: string[]; body: string[]; method: string }>();
  const gherkin: string[] = [];
  const pending: BddResult["pending"] = [];
  let n = 0;
  const addStep = (kw: "Given" | "When" | "Then", expr: string, params: string[], body: string[], line: string) => {
    gherkin.push("    " + kw + " " + line);
    const key = kw + "|" + expr;
    if (!defs.has(key)) {
      const method = (kw.toLowerCase() + pascal(expr.replace(/\{\w+\}/g, " ")).slice(0, 60)) || "step" + ++n;
      let name = method, i = 2;
      while ([...defs.values()].some((d) => d.method === name)) name = method + i++;
      defs.set(key, { annotation: kw, expr, params, body, method: name });
    }
  };
  const pend = (kw: "Given" | "When" | "Then", step: number, text: string, reason: string) => {
    pending.push({ step, text, reason });
    addStep(kw, cx(text), [], ['throw new PendingException(' + jstr(reason) + ');'], text);
  };
  const owned = (c: Cand) => c.owner + "." + c.m.constant;

  let prevPath = "";
  for (const snap of snaps) {
    const pg = pageOf(snap.step);
    const label = pg ? humanize(pg.className.replace(/Page\d*$/, "")) : "";
    const cands = candsFor(pg);
    const inv = inventoryOf(snap);
    const texts = [...new Set(inv.text.filter((t) => t.length >= 3 && !/^[\d\s$.,-]+$/.test(t)))].sort((a, b) => b.length - a.length);
    const urlPath = pg ? pg.urlPath : "";

    if (snap.step === snaps[0].step && pg) {
      addStep("Given", "I am on the " + label + " page", [],
        ["driver().get(BASE_URL + " + pg.className + ".PATH);"], "I am on the " + label + " page");
    } else if (pg && urlPath !== prevPath) {
      addStep("Then", "I should be on the " + label + " page", [],
        [assertTrue(lib, "driver().getCurrentUrl().contains(" + pg.className + ".PATH)", "Expected to be on " + pg.className + " (" + "\" + driver().getCurrentUrl() + \"" + ")")],
        "I should be on the " + label + " page");
    }
    prevPath = urlPath;

    const clauses = parseNote(snap.note || "");
    const data = clauses.filter((c) => c.kind === "data").flatMap((c) => quoted(c.text).length ? quoted(c.text) : [c.text.replace(/^.*?[=:]\s*/, "").trim()]).filter(Boolean);
    let dataIdx = 0;
    for (const c of clauses) {
      if (c.kind === "data") continue;
      if (c.kind === "action" || c.kind === "plain") {
        const typing = /\b(enter|type|fill|input|set)\b/i.test(c.text);
        const choosing = /\b(select|choose|pick)\b/i.test(c.text);
        const value = quoted(c.text)[0] ?? ((typing || choosing) ? data[dataIdx++] : undefined);
        const text = c.text.replace(/"[^"]*"/g, " ");
        const hit = rank(text, cands, idf);
        if ((!hit || hit.score < 0.6 || hit.margin < 0.1) && c.kind === "plain") {
          gherkin.push("    # " + c.text); // un-prefixed note that names no control: keep as a comment, not a step
          continue;
        }
        if (!hit || hit.score < 0.6 || hit.margin < 0.1) {
          pend("When", snap.step, c.text, "No captured control matches '" + c.text + "' on step " + snap.step + ". Recapture that UI state or write this step by hand.");
          continue;
        }
        const lbl = humanize(hit.best.m.prop);
        const by = owned(hit.best);
        const m = hit.best.m;
        if ((typing || m.role === "textbox" || m.role === "searchbox") && value != null) {
          addStep("When", "I enter {string} into the " + cx(lbl), ["String value"],
            ["WebElement el = visible(" + by + ");", "el.clear();", "el.sendKeys(value);"], 'I enter "' + value + '" into the ' + lbl);
        } else if ((choosing || m.role === "combobox") && value != null) {
          addStep("When", "I select {string} from the " + cx(lbl), ["String value"],
            ["new Select(visible(" + by + ")).selectByVisibleText(value);"], 'I select "' + value + '" from the ' + lbl);
        } else {
          addStep("When", "I click the " + cx(lbl), [], ["clickable(" + by + ").click();"], "I click the " + lbl);
        }
      } else {
        // assert: split "a and b" into separate checks
        for (const sub of c.text.split(/\s+(?:and|&)\s+/i).map((s) => s.trim()).filter(Boolean)) {
          const state = /\b(disabled|not enabled)\b/i.test(sub) ? "disabled" : /\benabled\b/i.test(sub) ? "enabled" : "displayed";
          const q = quoted(sub)[0];
          const hit = rank(sub.replace(/"[^"]*"/g, " ").replace(/\b(is|are|enabled|disabled|displayed|visible|shown)\b/gi, " "), cands, idf);
          if (hit && hit.score >= 0.6 && hit.margin >= 0.1) {
            const lbl = humanize(hit.best.m.prop);
            const by = owned(hit.best);
            if (q) {
              addStep("Then", "the " + cx(lbl) + " shows {string}", ["String expected"],
                [assertTrue(lib, "visible(" + by + ").getText().contains(expected)", "Expected " + lbl + " to show '\" + expected + \"'")], 'the ' + lbl + ' shows "' + q + '"');
            } else if (state === "displayed") {
              addStep("Then", "the " + cx(lbl) + " is displayed", [], ["visible(" + by + ");"], "the " + lbl + " is displayed");
            } else {
              addStep("Then", "the " + cx(lbl) + " is " + state, [],
                [assertTrue(lib, (state === "enabled" ? "" : "!") + "visible(" + by + ").isEnabled()", lbl + " should be " + state)], "the " + lbl + " is " + state);
            }
            continue;
          }
          const shown = q ?? texts.find((t) => sub.toLowerCase().includes(t.toLowerCase()));
          if (shown) {
            addStep("Then", "the page shows {string}", ["String expected"],
              [assertTrue(lib, "driver().findElement(By.tagName(\"body\")).getText().contains(expected)", "Expected page to show '\" + expected + \"'")], 'the page shows "' + shown + '"');
          } else {
            pend("Then", snap.step, sub, "No captured control or text matches '" + sub + "' on step " + snap.step + ".");
          }
        }
      }
    }
  }

  // ---- feature text
  const title = goal.charAt(0).toUpperCase() + goal.slice(1);
  const feature = [
    ...(o.tags ? [o.tags] : []),
    "Feature: " + title,
    "",
    "  Scenario: " + title,
    ...dedupeAdjacent(gherkin),
    "",
  ].join("\n");

  // ---- step definitions
  const imports = [
    "import io.cucumber.java.PendingException;",
    "import io.cucumber.java.en.Given;",
    "import io.cucumber.java.en.Then;",
    "import io.cucumber.java.en.When;",
    "import org.openqa.selenium.By;",
    "import org.openqa.selenium.WebDriver;",
    "import org.openqa.selenium.WebElement;",
    "import org.openqa.selenium.support.ui.ExpectedConditions;",
    "import org.openqa.selenium.support.ui.Select;",
    "import org.openqa.selenium.support.ui.WebDriverWait;",
    lib === "testng" ? "import static org.testng.Assert.assertTrue;" : "import static org.junit.jupiter.api.Assertions.assertTrue;",
    "",
    "import java.time.Duration;",
  ];
  const usedPages = [...new Set(["BasePage", ...pom.pages.map((p) => p.className)])];
  const stepsJava = [
    "// Generated by pagesnap pack bdd from " + path.basename(sessionDir) + ". Pending steps need a captured control or a hand-written body.",
    "package " + pkg + ";",
    "",
    ...imports,
    ...usedPages.map((p) => "import " + pagesPkg + "." + p + ";"),
    "",
    "public class " + className + " {",
    "    private static final String BASE_URL = System.getProperty(\"baseUrl\", " + jstr(baseUrl) + ");",
    "",
    "    private WebDriver driver() {",
    "        return " + driverExpr + ";",
    "    }",
    "",
    "    private WebElement visible(By by) {",
    "        return new WebDriverWait(driver(), Duration.ofSeconds(10)).until(ExpectedConditions.visibilityOfElementLocated(by));",
    "    }",
    "",
    "    private WebElement clickable(By by) {",
    "        return new WebDriverWait(driver(), Duration.ofSeconds(10)).until(ExpectedConditions.elementToBeClickable(by));",
    "    }",
    ...[...defs.values()].flatMap((d) => [
      "",
      "    @" + d.annotation + "(" + jstr(d.expr) + ")",
      "    public void " + d.method + "(" + d.params.join(", ") + ") {",
      ...d.body.map((b) => "        " + b),
      "    }",
    ]),
    "}",
    "",
  ].join("\n");

  fs.mkdirSync(o.featuresDir, { recursive: true });
  fs.mkdirSync(o.stepsDir, { recursive: true });
  const featureFile = path.join(o.featuresDir, slug + ".feature");
  const stepsFile = path.join(o.stepsDir, className + ".java");
  fs.writeFileSync(featureFile, feature, "utf8");
  fs.writeFileSync(stepsFile, stepsJava, "utf8");
  let runnerFile: string | undefined;
  if (o.runner) {
    runnerFile = path.join(o.stepsDir, "RunCucumberTest.java");
    fs.writeFileSync(runnerFile, runnerJava(pkg, o.runner, o.tags), "utf8");
  }
  return { feature: featureFile, steps: stepsFile, runner: runnerFile, generated: defs.size, pending, gherkin: feature };
}

function assertTrue(lib: string, cond: string, msg: string): string {
  return "assertTrue(" + cond + ", \"" + msg + "\");";
}

function dedupeAdjacent(lines: string[]): string[] {
  return lines.filter((l, i) => l !== lines[i - 1]);
}

function runnerJava(pkg: string, kind: "testng" | "junit", tags?: string): string {
  const tagOpt = tags ? tags.replace(/^@/, "") : "";
  if (kind === "testng") {
    return [
      "package " + pkg + ";",
      "",
      "import io.cucumber.testng.AbstractTestNGCucumberTests;",
      "import io.cucumber.testng.CucumberOptions;",
      "",
      "@CucumberOptions(",
      "        features = \"src/test/resources/features\",",
      "        glue = {\"" + pkg + "\"},",
      ...(tagOpt ? ["        tags = \"@" + tagOpt + "\","] : []),
      "        plugin = {\"pretty\", \"html:target/cucumber.html\"})",
      "public class RunCucumberTest extends AbstractTestNGCucumberTests {",
      "}",
      "",
    ].join("\n");
  }
  return [
    "package " + pkg + ";",
    "",
    "import org.junit.platform.suite.api.ConfigurationParameter;",
    "import org.junit.platform.suite.api.IncludeEngines;",
    "import org.junit.platform.suite.api.SelectClasspathResource;",
    "import org.junit.platform.suite.api.Suite;",
    "",
    "import static io.cucumber.junit.platform.engine.Constants.GLUE_PROPERTY_NAME;",
    "",
    "@Suite",
    "@IncludeEngines(\"cucumber\")",
    "@SelectClasspathResource(\"features\")",
    "@ConfigurationParameter(key = GLUE_PROPERTY_NAME, value = \"" + pkg + "\")",
    "public class RunCucumberTest {",
    "}",
    "",
  ].join("\n");
}
