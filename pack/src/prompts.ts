/**
 * Ready-to-use agent prompts.
 *
 * Per session (written at build time, also printed by `pack prompt`):
 *   lean/AUTOMATE_PROMPT.md    paste into Copilot agent mode / Claude Code
 *   lean/TESTCASES_PROMPT.md   manual test cases instead of code
 *
 * Per test repo (`pack install-prompts <repo>`), reusable slash commands:
 *   .github/prompts/pagesnap-automate.prompt.md   Copilot: /pagesnap-automate
 *   .github/prompts/pagesnap-testcases.prompt.md  Copilot: /pagesnap-testcases
 *   .claude/commands/pagesnap-automate.md         Claude Code: /pagesnap-automate <session>
 *   .claude/commands/pagesnap-testcases.md        Claude Code: /pagesnap-testcases <session>
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { snapshotFiles } from "./index.js";

/** Root of the pagesnap-selenium checkout (pack/src -> pack). */
export function toolDir(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
}

export function slugify(s: string, max = 40): string {
  const slug = s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return (slug.slice(0, max).replace(/-+$/, "") || "captured-flow");
}

/** Session goal from SESSION.md, else from the first snapshot header. */
export function sessionGoal(sessionDir: string): string {
  const sm = path.join(sessionDir, "SESSION.md");
  if (fs.existsSync(sm)) {
    const m = /^- Goal: (.+)$/m.exec(fs.readFileSync(sm, "utf8"));
    if (m) return m[1].trim();
  }
  const first = snapshotFiles(sessionDir)[0];
  if (first) {
    const m = /^# Session goal: (.+)$/m.exec(fs.readFileSync(path.join(sessionDir, first), "utf8"));
    if (m) return m[1].trim();
  }
  return "";
}

export interface PromptOpts {
  /** absolute session folder, or a placeholder like ${input:session} / $ARGUMENTS */
  session: string;
  /** spec / flow file name stem */
  name: string;
  tool?: string;
  goal?: string;
}

function packCmd(tool: string): string {
  return 'npm --prefix "' + tool + '" run -s pack --';
}

export function automatePrompt(o: PromptOpts): string {
  const tool = o.tool ?? toolDir();
  const PACK = packCmd(tool);
  const S = o.session;
  return [
    "Automate the flow captured in the PageSnap session below as ONE Selenium Java (JUnit 5) test.",
    "",
    "Session: " + S,
    o.goal ? "Goal: " + o.goal : "",
    "Test: src/test/java/" + o.name.replace(/(^|-)([a-z0-9])/g, (_m, _d, c) => c.toUpperCase()) + "Test.java (Page Objects under src/test/java/pages/)",
    "PACK means: " + PACK,
    "",
    "Read ONLY these for context (do NOT open the NN_*.yaml files):",
    "- " + S + "/SESSION.md, TEST_GUIDE.md, flow.md, lean/PACK.md",
    "",
    "First generate the page objects (no LLM needed, locators are already verified):",
    "   PACK pom \"" + S + "\" --out=src/test/java/pages",
    "   Then read src/test/java/pages/PAGES.md (member names per page). Do not edit the generated locators.",
    "",
    "For EACH step in flow.md, in order:",
    "1. Run: PACK query \"" + S + "\" \"<step note text>\" --step=<N> --diff",
    "2. Use the page-object members from PAGES.md. If something is not there, use ONLY a locator shown after `=>` in the query result. Never invent selectors.",
    "3. `action:` notes -> actions, `assert:` notes -> assertions, `data:` notes -> input values.",
    "4. If the query says low-confidence, read only that lean/NN_*.txt page.",
    "",
    "Rules:",
    "- #id / id=V -> By.id; [name=V] -> By.name; css= -> By.cssSelector; linkText= -> By.linkText; xpath= -> By.xpath.",
    "- Highest score first; never use a locator with score <= 40 or `matches: N` unless nothing else exists.",
    "- Explicit waits (WebDriverWait + ExpectedConditions); never Thread.sleep.",
    "- Native <select> -> new Select(...). Frames -> switchTo().frame(...).",
    "- Do not driver.get(...) a URL to skip a step that has a control in the snapshots.",
    "- The test must end with an assertion on a business outcome, not just \"page loaded\".",
    "- Credentials and test data come from flow.md notes or env vars; never hard-code real secrets.",
    "",
    "When the test is written:",
    "1. Run: PACK validate \"" + S + "\" src/test/java",
    "   Fix every MISS / AMBG using a locator from PACK query. Re-run until missing 0.",
    "2. Run: mvn -q test -Dtest=<Class>. On a locator failure re-run PACK query for that step and fix the locator from the result.",
    "   Max 3 attempts, then stop and report.",
    "3. Reply with: files changed, the validate summary line, the test result. No code recap.",
    "",
  ].filter((l, i, a) => !(l === "" && a[i - 1] === "")).join("\n");
}

export function testCasesPrompt(o: PromptOpts): string {
  const tool = o.tool ?? toolDir();
  const PACK = packCmd(tool);
  const S = o.session;
  return [
    "Write manual test cases for the flow captured in the PageSnap session below.",
    "",
    "Session: " + S,
    o.goal ? "Goal: " + o.goal : "",
    "Output: tests/cases/" + o.name + ".md",
    "PACK means: " + PACK,
    "",
    "Read " + S + "/flow.md and lean/PACK.md. For the UI on each step run:",
    "PACK query \"" + S + "\" \"<step note text>\" --step=<N>",
    "Do NOT open the NN_*.yaml files.",
    "",
    "Write a markdown table: ID | Title | Preconditions | Steps | Expected result | Priority (P1-P3) | Automate? (Y/N)",
    "Cover:",
    "- the happy path exactly as flow.md describes it",
    "- negative cases visible in the snapshots (validation errors, required fields, invalid input)",
    "- edge cases visible in the snapshots (disabled controls, empty states, sort/filter options, counts and totals)",
    "Only use screens, fields and messages that appear in the query results. Do not invent screens that were not captured;",
    "list anything you think is missing under \"Gaps to capture\" at the end.",
    "Reply with the file path and the number of cases by priority.",
    "",
  ].filter((l, i, a) => !(l === "" && a[i - 1] === "")).join("\n");
}

export function writeSessionPrompts(sessionDir: string, name?: string): { automate: string; cases: string } {
  const goal = sessionGoal(sessionDir);
  const opts: PromptOpts = { session: path.resolve(sessionDir), name: name || slugify(goal || path.basename(sessionDir)), goal };
  const leanDir = path.join(sessionDir, "lean");
  fs.mkdirSync(leanDir, { recursive: true });
  const automate = path.join(leanDir, "AUTOMATE_PROMPT.md");
  const cases = path.join(leanDir, "TESTCASES_PROMPT.md");
  fs.writeFileSync(automate, automatePrompt(opts), "utf8");
  fs.writeFileSync(cases, testCasesPrompt(opts), "utf8");
  return { automate, cases };
}

/** Write reusable slash-command prompt files into a test repo. */
export function installPrompts(repoDir: string, tool = toolDir()): string[] {
  const written: string[] = [];
  const put = (rel: string, body: string) => {
    const p = path.join(repoDir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, body, "utf8");
    written.push(p);
  };
  // Copilot prompt files: ${input:...} asks the user when the prompt runs.
  const copilotSession = "${input:session:PageSnap session folder (absolute path)}";
  const copilotName = "${input:name:test name, e.g. checkout-flow}";
  put(".github/prompts/pagesnap-automate.prompt.md",
    "---\nmode: agent\ndescription: Automate a PageSnap capture session as one Selenium Java test (token-lean)\n---\n" +
    automatePrompt({ session: copilotSession, name: copilotName, tool }));
  put(".github/prompts/pagesnap-testcases.prompt.md",
    "---\nmode: agent\ndescription: Write manual test cases from a PageSnap capture session\n---\n" +
    testCasesPrompt({ session: copilotSession, name: copilotName, tool }));
  // Claude Code slash commands: $1 = session folder, $2 = spec name.
  put(".claude/commands/pagesnap-automate.md",
    "---\ndescription: Automate a PageSnap capture session as one Selenium Java test (token-lean)\nargument-hint: <session-folder> <test-name>\n---\n" +
    automatePrompt({ session: "$1", name: "$2", tool }));
  // MCP server for VS Code (Copilot agent mode). Never overwrite an existing config.
  const vscode = path.join(repoDir, ".vscode", "mcp.json");
  if (!fs.existsSync(vscode)) {
    put(".vscode/mcp.json", JSON.stringify({
      servers: {
        pagesnap: {
          type: "stdio",
          command: "npm",
          args: ["--prefix", tool, "run", "-s", "mcp"],
          env: { PAGESNAP_CWD: "${workspaceFolder}" },
        },
      },
    }, null, 2) + "\n");
  }
  put(".claude/commands/pagesnap-testcases.md",
    "---\ndescription: Write manual test cases from a PageSnap capture session\nargument-hint: <session-folder> <name>\n---\n" +
    testCasesPrompt({ session: "$1", name: "$2", tool }));
  return written;
}
