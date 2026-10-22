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
