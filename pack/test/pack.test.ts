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
