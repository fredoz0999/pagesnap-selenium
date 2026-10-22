#!/usr/bin/env node
/**
 * npm run pack -- build    <session|latest> [--embedder=hash|minilm] [--max-tokens=200]
 * npm run pack -- query    <session|latest> "<step text>" [--k=4] [--step=N] [--diff] [--url=part] [--no-legend] [--json]
 * npm run pack -- stats    <session|latest>
 * npm run pack -- prompt   <session|latest> [--cases|--cucumber] [--name=x]
 * npm run pack -- install-prompts <test-repo-dir>
 */
import fs from "node:fs";
import path from "node:path";
import { buildIndex, loadIndex, queryIndex, LEAN_DIR } from "./index.js";
import { ensureIndex, resolveSession, userPath } from "./paths.js";
import { validateJava } from "./validate.js";
import { writePom } from "./pom.js";
import { generateBdd } from "./bdd.js";
import { healJava } from "./heal.js";
import { verifySession } from "./verify.js";
import { bench, benchTmpCopy } from "./bench.js";
import { automatePrompt, cucumberPrompt, installPrompts, sessionGoal, slugify, testCasesPrompt, writeSessionPrompts } from "./prompts.js";

const USAGE = `pagesnap lean pack - token-lean snapshots for coding agents

  npm run pack -- build    <session|latest> [--embedder=hash|minilm] [--max-tokens=200]
  npm run pack -- query    <session|latest> "<step text>" [--k=4] [--step=N] [--diff] [--url=part] [--no-legend] [--json]
  npm run pack -- stats    <session|latest>
  npm run pack -- bench    <session|latest> [--md]
  npm run pack -- validate <session|latest> <File.java|folder>
  npm run pack -- heal     <session|latest> <File.java|folder> [--log=maven-output.txt] [--write]
  npm run pack -- verify   <session|latest> [--base-url=https://staging.example.com] [--storage=state.json] [--step=N]
  npm run pack -- bdd      <session|latest> [--features=src/test/resources/features] [--steps=src/test/java/steps] [--package=steps] [--pages-package=pages] [--driver="DriverManager.getDriver()"] [--assertions=testng|junit] [--runner=testng|junit] [--tags=@smoke]
  npm run pack -- pom      <session|latest> [--out=src/test/java/pages] [--package=pages]
  npm run pack -- prompt   <session|latest> [--cases|--cucumber] [--name=checkout-flow]
  npm run pack -- install-prompts <test-repo-dir>

build     compact every NN_*.yaml into lean/NN_*.txt, chunk by UI region, write lean/index.json + lean/PACK.md
query     hybrid search (keyword + vector + exact name) -> page outline + the few chunks that matter
stats     raw vs compact token estimate per page
validate  check every By.* locator in your Java tests/page objects against the snapshots (no LLM tokens). Exit 1 if any is missing.
heal      suggest replacements for missing / ambiguous / failing By.* locators from the snapshots; --write applies clear winners; --log reads a Selenium failure log
verify    reopen each captured page (installed Chrome via playwright-core; PAGESNAP_CHROME=path) and count matches per locator: ok / gone / ambiguous
bdd       generate a Cucumber .feature + step definitions (Cucumber-JVM) bound to the page objects; unmatched notes become Pending steps
pom       generate Selenium Java page objects (BasePage + one class per URL path) from the verified locators (no LLM) + PAGES.md map
bench     tokens an agent reads for the whole flow: raw / compact / query / query+diff / PAGES.md / ariaSnapshot
prompt    print a ready-to-paste agent prompt for this session (--cases: manual test cases)
install-prompts  add /pagesnap-automate and /pagesnap-testcases to a test repo
                 (.github/prompts for Copilot, .claude/commands for Claude Code)

<session> is a session folder, or "latest" for the newest pageSnapshots/session-*.`;

function flag(args: string[], name: string): string | undefined {
  const hit = args.find((a) => a.startsWith("--" + name + "="));
  return hit ? hit.slice(name.length + 3) : undefined;
}

async function main(argv: string[]): Promise<number> {
  const [cmd, sess, ...rest] = argv;
  const pos = rest.filter((a) => !a.startsWith("--"));
  if (!cmd || !sess || cmd === "--help" || cmd === "-h") {
    console.log(USAGE);
    return cmd ? 0 : 1;
  }
  if (cmd === "install-prompts") {
    const files = installPrompts(userPath(sess));
    console.log("Installed:\n" + files.map((f) => "  " + f).join("\n"));
    console.log("Copilot (agent mode): type /pagesnap-automate.  Claude Code: /pagesnap-automate <session-folder> <spec-name>");
    console.log("MCP tools: VS Code reads .vscode/mcp.json (created if absent). Claude Code:");
    console.log('  claude mcp add pagesnap -e PAGESNAP_CWD="$PWD" -- npm --prefix "' + path.resolve(".") + '" run -s mcp');
    return 0;
  }
  const dir = resolveSession(sess);
  switch (cmd) {
    case "bench": {
      const rep = await bench(benchTmpCopy(dir), path.basename(dir));
      process.stdout.write(rest.includes("--md") ? rep.markdown : rep.text);
      return 0;
    }
    case "pom": {
      const out = userPath(flag(rest, "out") || "src/test/java/pages");
      const r = writePom(dir, out, flag(rest, "package") ?? "pages");
      const members = r.base.length + r.pages.reduce((a, p) => a + p.members.length, 0);
      console.log("Wrote " + r.files.length + " files to " + out + ": " + r.pages.length + " page classes + BasePage, " + members + " members");
      return 0;
    }
    case "bdd": {
      const rt = flag(rest, "runner");
      const as = flag(rest, "assertions");
      const r = generateBdd(dir, {
        featuresDir: userPath(flag(rest, "features") || "src/test/resources/features"),
        stepsDir: userPath(flag(rest, "steps") || "src/test/java/steps"),
        stepsPackage: flag(rest, "package"),
        pagesPackage: flag(rest, "pages-package"),
        driver: flag(rest, "driver"),
        assertions: as === "junit" ? "junit" : "testng",
        runner: rt === "testng" || rt === "junit" ? rt : null,
        tags: flag(rest, "tags"),
        baseUrl: flag(rest, "base-url"),
      });
      console.log("Wrote " + r.feature + "\n      " + r.steps + (r.runner ? "\n      " + r.runner : ""));
      console.log(r.generated + " step definition(s), " + r.pending.length + " pending");
      for (const p of r.pending) console.log("  PENDING step " + p.step + ": " + p.text);
      console.log("Needs the page objects from `pack pom` (package " + (flag(rest, "pages-package") || "pages") + ") and a WebDriver at " + (flag(rest, "driver") || "DriverManager.getDriver()") + ".");
      return 0;
    }
    case "heal": {
      const target = pos[0];
      if (!target) { console.error("heal needs a .java file or folder"); return 1; }
      const logFile = flag(rest, "log");
      const rep = healJava(dir, userPath(target), { write: rest.includes("--write"), log: logFile ? fs.readFileSync(userPath(logFile), "utf8") : undefined });
      process.stdout.write(rep.text);
      return 0;
    }
    case "verify": {
      const st = flag(rest, "step");
      const storage = flag(rest, "storage");
      const rep = await verifySession(dir, { baseUrl: flag(rest, "base-url"), storage: storage ? userPath(storage) : undefined, steps: st ? st.split(",").map(Number) : undefined });
      process.stdout.write(rep.text);
      return rep.counts.gone > 0 ? 1 : 0;
    }
    case "validate": {
      const target = pos[0];
      if (!target) { console.error("validate needs a .java file or folder"); return 1; }
      const rep = validateJava(dir, userPath(target));
      process.stdout.write(rep.text);
      return rep.counts.missing > 0 ? 1 : 0;
    }
    case "prompt": {
      const name = flag(rest, "name");
      const goal = sessionGoal(dir);
      const opts = { session: dir, name: name || slugify(goal || path.basename(dir)), goal };
      writeSessionPrompts(dir, name);
      process.stdout.write(rest.includes("--cases") ? testCasesPrompt(opts) : rest.includes("--cucumber") ? cucumberPrompt(opts) : automatePrompt(opts));
      return 0;
    }
    case "build": {
      const mt = flag(rest, "max-tokens");
      const idx = await buildIndex(dir, { embedder: flag(rest, "embedder"), maxTokens: mt ? Number(mt) : undefined, name: flag(rest, "name") });
      const pct = Math.round((1 - idx.stats.compactTokens / idx.stats.rawTokens) * 100);
      console.log("Built " + path.join(dir, LEAN_DIR) + ": " + idx.pages.length + " page(s), " + idx.stats.chunkCount + " chunks, ~" +
        idx.stats.rawTokens + " -> ~" + idx.stats.compactTokens + " tokens (-" + pct + "%), embedder " + idx.embedder);
      return 0;
    }
    case "query": {
      const q = pos.join(" ").trim();
      if (!q) { console.error("query needs step text"); return 1; }
      await ensureIndex(dir);
      const st = flag(rest, "step");
      const k = flag(rest, "k");
      const res = await queryIndex(dir, q, {
        k: k ? Number(k) : undefined,
        step: st ? Number(st) : undefined,
        urlContains: flag(rest, "url"),
        legend: !rest.includes("--no-legend"),
        diff: rest.includes("--diff"),
      });
      if (rest.includes("--json")) {
        console.log(JSON.stringify({ tokens: res.tokens, lowConfidence: res.lowConfidence, hits: res.hits.map((h) => ({ id: h.chunk.id, steps: h.chunk.steps, path: h.chunk.path, score: +h.score.toFixed(3), text: h.chunk.text })) }, null, 2));
      } else {
        process.stdout.write(res.text);
        console.error("(~" + res.tokens + " tokens)");
      }
      return 0;
    }
    case "stats": {
      await ensureIndex(dir);
      const idx = loadIndex(dir);
      for (const p of idx.pages) console.log("step " + p.step + "  raw ~" + p.rawTokens + "  compact ~" + p.compactTokens + "  " + p.url);
      console.log("total raw ~" + idx.stats.rawTokens + "  compact ~" + idx.stats.compactTokens + "  chunks " + idx.stats.chunkCount);
      return 0;
    }
    default:
      console.log(USAGE);
      return 1;
  }
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err: unknown) => { console.error(err instanceof Error ? err.message : err); process.exit(1); }
);
