import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildIndex, queryIndex } from "../src/index.js";
import { parseSnapshot } from "../src/parse.js";

const FIXTURE = path.resolve(__dirname, "fixtures/session-shop");

function copyFixture(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ps-pack-"));
  fs.cpSync(FIXTURE, dir, { recursive: true });
  return dir;
}

describe("pack on a Selenium-format session", () => {
  it("parses locators with score and Selenium by values", () => {
    const f = fs.readdirSync(FIXTURE).find((n) => n.startsWith("01_"))!;
    const snap = parseSnapshot(fs.readFileSync(path.join(FIXTURE, f), "utf8"), f);
    const all = JSON.stringify(snap.roots);
    expect(all).toContain("login-button");
    expect(all).toContain('"score":98');
  });

  it("builds a smaller compact pack", async () => {
    const dir = copyFixture();
    const idx = await buildIndex(dir);
    expect(idx.pages.length).toBe(3);
    expect(idx.stats.compactTokens).toBeLessThan(idx.stats.rawTokens);
    expect(fs.existsSync(path.join(dir, "lean", "PACK.md"))).toBe(true);
  });

  it("query returns the verified locator for the step and never the other steps' UI", async () => {
    const dir = copyFixture();
    await buildIndex(dir);
    const r = await queryIndex(dir, "add the Fleece Jacket to the cart", { step: 2 });
    expect(r.text).toContain('add-to-cart-fleece-jacket');
    expect(r.text).not.toContain("login-button");
    expect(r.text).toContain("By.cssSelector");
  });
});

describe("java page objects and validation", () => {
  it("generates page objects with By constants from the best-scored locator", async () => {
    const { buildPom, renderPom } = await import("../src/pom.js");
    const files = renderPom(buildPom(FIXTURE), FIXTURE);
    expect([...files.keys()]).toEqual(expect.arrayContaining(["BasePage.java", "InventoryPage.java", "CartPage.java", "PAGES.md"]));
    const inv = files.get("InventoryPage.java")!;
    expect(inv).toContain("public class InventoryPage extends BasePage");
    expect(inv).toContain('public static final By ADD_TO_CART_FLEECE_JACKET_BUTTON = By.cssSelector("[data-test=\\"add-to-cart-fleece-jacket\\"]");');
    expect(inv).toContain("public WebElement addToCartFleeceJacketButton()");
    expect(files.get("BasePage.java")).toContain("shoppingCartLink()");
  });

  it("validate flags an invented id as MISS and passes captured locators", async () => {
    const { validateJava } = await import("../src/validate.js");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ps-val-"));
    const f = path.join(dir, "T.java");
    fs.writeFileSync(f, [
      'driver.findElement(By.id("user-name"));',
      'driver.findElement(By.cssSelector("[data-test=\\"checkout\\"]"));',
      'driver.findElement(By.id("nope-field"));',
      'driver.findElement(By.id(dyn));',
      '// By.id("commented-out")',
    ].join("\n"));
    const rep = validateJava(FIXTURE, f);
    expect(rep.counts).toEqual({ ok: 2, missing: 1, ambiguous: 0, unverified: 1 });
  });
});

describe("cucumber generation", () => {
  it("writes a feature and step definitions bound to page-object constants, and marks unmatched notes pending", async () => {
    const { generateBdd } = await import("../src/bdd.js");
    const dir = copyFixture();
    // add an assert that matches nothing captured
    const f = fs.readdirSync(dir).find((n) => n.startsWith("03_"))!;
    const p = path.join(dir, f);
    fs.writeFileSync(p, fs.readFileSync(p, "utf8").replace(/# Note: .*/, "# Note: assert: loyalty points are credited"));
    const out = fs.mkdtempSync(path.join(os.tmpdir(), "ps-bdd-"));
    const r = generateBdd(dir, { featuresDir: path.join(out, "features"), stepsDir: path.join(out, "steps"), runner: "testng", driver: "com.acme.DriverManager.getDriver()" });
    expect(r.gherkin).toContain("When I click the add to cart fleece jacket button");
    expect(r.gherkin).toContain("Given I am on the home page");
    const steps = fs.readFileSync(r.steps, "utf8");
    expect(steps).toContain('@When("I click the add to cart fleece jacket button")');
    expect(steps).toContain("clickable(InventoryPage.ADD_TO_CART_FLEECE_JACKET_BUTTON).click();");
    expect(steps).toContain("com.acme.DriverManager.getDriver()");
    expect(r.pending.map((x) => x.text)).toEqual(["loyalty points are credited"]);
    expect(steps).toContain("PendingException");
    expect(fs.readFileSync(r.runner!, "utf8")).toContain("AbstractTestNGCucumberTests");
  });

  it("binds a note to a control that appears twice (header + footer) on a real ParaBank capture", async () => {
    const { generateBdd } = await import("../src/bdd.js");
    const dir = path.join(__dirname, "fixtures", "session-parabank");
    const out = fs.mkdtempSync(path.join(os.tmpdir(), "ps-bdd-pb-"));
    const r = generateBdd(dir, { featuresDir: path.join(out, "features"), stepsDir: path.join(out, "steps"), runner: "testng", driver: "com.acme.DriverManager.getDriver()" });
    expect(r.pending).toEqual([]);
    expect(fs.readFileSync(r.steps, "utf8")).toContain("clickable(BasePage.ABOUT_US_LINK).click();");
  });

  it("names a page after the resource, not a generated id, and never binds a note on one shared word (real Toolshop capture)", async () => {
    const { buildPom } = await import("../src/pom.js");
    const { generateBdd } = await import("../src/bdd.js");
    const dir = path.join(__dirname, "fixtures", "session-toolshop");
    expect(buildPom(dir).pages.map((p) => p.className)).toContain("ProductPage");
    const out = fs.mkdtempSync(path.join(os.tmpdir(), "ps-bdd-ts-"));
    const r = generateBdd(dir, { featuresDir: path.join(out, "features"), stepsDir: path.join(out, "steps"), runner: "testng", driver: "com.acme.DriverManager.getDriver()" });
    expect(r.gherkin).not.toMatch(/register your account/i);
    expect(r.pending.map((x) => x.text)).toContain("log in with the demo customer account");
  });

  it("splits note clauses by prefix", async () => {
    const { parseNote } = await import("../src/bdd.js");
    expect(parseNote("action: enter user data: user=standard_user assert: login ok")).toEqual([
      { kind: "action", text: "enter user" }, { kind: "data", text: "user=standard_user" }, { kind: "assert", text: "login ok" },
    ]);
  });
});

describe("heal", () => {
  it("suggests the captured control for a renamed id and applies only clear winners", async () => {
    const { healJava, failingLocatorsFromLog } = await import("../src/heal.js");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ps-heal-"));
    const f = path.join(dir, "T.java");
    fs.writeFileSync(f, [
      'driver.findElement(By.id("user_name"));',
      'driver.findElement(By.cssSelector("[data-test=\\"login-btn\\"]"));',
    ].join("\n"));
    const dry = healJava(FIXTURE, f);
    expect(dry.suggestions.map((s) => s.candidates[0].code)).toEqual([
      'By.cssSelector("[data-test=\\"username\\"]")', 'By.cssSelector("[data-test=\\"login-button\\"]")',
    ]);
    expect(fs.readFileSync(f, "utf8")).toContain('By.id("user_name")'); // dry run leaves the file alone
    const wrote = healJava(FIXTURE, f, { write: true });
    expect(wrote.written).toBe(1); // user_name -> username is clear; login-btn -> login-button is not
    const after = fs.readFileSync(f, "utf8");
    expect(after).toContain('By.cssSelector("[data-test=\\"username\\"]")');
    expect(after).toContain('login-btn');
    expect(failingLocatorsFromLog('{"method":"css selector","selector":"[id=\\"x\\"]"} {"method":"link text","selector":"Go"}'))
      .toEqual([{ by: "id", value: "x" }, { by: "linkText", value: "Go" }]);
  });
});

const CHROME = process.env.PAGESNAP_CHROME || "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
describe.skipIf(!fs.existsSync(CHROME))("verify (live, needs Chrome)", () => {
  it("reports locators that drifted on the live page", async () => {
    const http = await import("node:http");
    const { verifySession } = await import("../src/verify.js");
    process.env.PAGESNAP_CHROME = CHROME;
    const nav = '<header><a data-test="home" href="/">Home</a><a href="/about">About</a><a href="/help">Help</a><a data-test="shopping-cart-link"><span data-test="shopping-cart-badge">0</span></a></header>';
    const pages: Record<string, string> = {
      "/index.html": '<title>Login</title><body>' + nav + '<main><h1>Login</h1><form><label>Username <input id="user-name" name="user-name" data-test="username"></label><label>Password <input type="password" id="password" name="password" data-test="password"></label><input type="submit" id="login-button" data-test="login-button" value="Login"></form></main></body>',
      "/inventory.html": "<title>Products</title><body>" + nav + "<main><h1>Products</h1></main></body>",
      // the checkout button lost its data-test: drift
      "/cart.html": '<title>Your Cart</title><body>' + nav + '<main><h1>Your Cart</h1><button data-test="remove-fleece-jacket">Remove</button><button data-test="continue-shopping">Continue Shopping</button><button class="co">Checkout</button></main></body>',
    };
    const server = http.createServer((req, res) => { res.setHeader("content-type", "text/html"); res.end(pages[req.url || ""] ?? "<body>404</body>"); });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    try {
      const rep = await verifySession(FIXTURE, { baseUrl: "http://127.0.0.1:" + port, steps: [1, 3] });
      expect(rep.counts.gone).toBe(1);
      expect(rep.items.find((i) => i.status === "gone")!.label).toContain("Checkout");
      expect(rep.items.filter((i) => i.step === 1).every((i) => i.status === "ok")).toBe(true);
    } finally {
      server.close();
    }
  }, 60000);
});
