import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { isDynamicValue, locatorHasDynamic } from "../src/dynamic.js";

const DYNAMIC = [
  "category-01M5GND72GRNKJ0VS990Z1N3CF", "3f2b8c1e-9a4d-4c7a-8b2e-1f0d5a6c7b8e", "9f86d081884c7d659a2feaa0c55ad015",
  "input-8472", "mat-input-4", "ember1234", "react-select-3-input", "ng-c2621549667", ":r1:", "css-1x2y3z4", "sc-bdVaJa",
  "Button_primary__x7Gh2", "btn-a8f3k2m9x1", "ctl00_ContentPlaceHolder1_row_20231", "headlessui-menu-button-12", "q8472",
];
const STABLE = [
  "search-query", "email", "category_id", "username", "login-button", "add-to-cart", "proceed-1", "step2", "address2", "h1",
  "nav-cart", "payment-method", "credit_card_number", "first-name", "Hammer", "checkout", "customer-login", "rightPanel", "headerPanel",
];

describe("dynamic value detection", () => {
  it.each(DYNAMIC)("flags generated value %s", (v) => expect(isDynamicValue(v)).toBe(true));
  it.each(STABLE)("keeps stable value %s", (v) => expect(isDynamicValue(v)).toBe(false));

  it("checks the identifying value of each locator kind", () => {
    expect(locatorHasDynamic("id", "mat-input-4")).toBe(true);
    expect(locatorHasDynamic("css", '[data-test="category-01M5GND72GRNKJ0VS990Z1N3CF"]')).toBe(true);
    expect(locatorHasDynamic("css", 'a[href*="/product/01M5GND76DX63X0V1S632TWZFC"]')).toBe(true);
    expect(locatorHasDynamic("css", "#headerPanel > ul:nth-child(1) > li:nth-child(2) > a:nth-child(1)")).toBe(false);
    expect(locatorHasDynamic("css", '[data-test="search-query"]')).toBe(false);
    expect(locatorHasDynamic("linkText", "Order 20231 history")).toBe(false);
    expect(locatorHasDynamic("xpath", '//label[normalize-space()="Hammer"]//input')).toBe(false);
  });

  it("agrees with the detector embedded in the capture tool (SnapshotCapture.java)", () => {
    const src = fs.readFileSync(path.resolve(__dirname, "../../src/main/java/SnapshotCapture.java"), "utf8");
    const a = src.indexOf("const isDynamicValue = (v) => {");
    const b = src.indexOf("const locatorHasDynamic", a);
    expect(a).toBeGreaterThan(0);
    // Java text block: "\\" is one backslash and "«" is not a Java escape here (it is preceded by a backslash).
    const js = src.slice(a, b).replace(/\\\\/g, "\\");
    const fn = new Function(js + "; return isDynamicValue;")() as (v: string) => boolean;
    for (const v of [...DYNAMIC, ...STABLE, "", "a", "abc12", "Order-77", "x".repeat(30)]) expect(fn(v), v).toBe(isDynamicValue(v));
  });
});
