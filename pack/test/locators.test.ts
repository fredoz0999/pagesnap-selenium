import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { lintXpath, lintCss } from "../src/validate.js";
import { bySelector } from "../src/verify.js";
import { locatorHasDynamic } from "../src/dynamic.js";

const CHROME = process.env.PAGESNAP_CHROME || "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";

describe("hand-written locator review", () => {
  it.each([
    "//b[text()='Username']/parent::p/following-sibling::div[1]/input",
    "//td[normalize-space()='Alice']/following-sibling::td//button[normalize-space()='Edit']",
    "//div[@id='loginPanel']//a[contains(text(),'Forgot')]",
    "//h5[normalize-space()='Claw Hammer']/ancestor::div[contains(@class,'card')][1]//button",
    "//ul[@class='leftmenu']/li[a[text()='About Us']]",
    "(//input[@type='checkbox'])[2]",
  ])("accepts anchored XPath %s", (x) => expect(lintXpath(x)).toBeNull());

  it.each([
    ["/html/body/div[1]/div[3]/form/div[1]/input", /absolute/],
    ["//div[3]/div[1]/form/div[2]/input", /index-only/],
    ["//div/span/input", /no text, attribute or axis/],
    ["//table[@id='t']/tbody/tr[3]/td[2]/div[1]/a", /position predicates/],
  ])("flags fragile XPath %s", (x, why) => expect(lintXpath(x as string)).toMatch(why as RegExp));

  it("flags positional css and generated values in single-quoted XPath", () => {
    expect(lintCss("#a > div:nth-child(2) > form > div:nth-child(4) > input")).toMatch(/positional/);
    expect(lintCss("[data-test='email']")).toBeNull();
    expect(locatorHasDynamic("xpath", "//input[@id='mat-input-4']")).toBe(true);
    expect(locatorHasDynamic("xpath", "//td[normalize-space()='Alice']/following-sibling::td//button")).toBe(false);
  });

  it("maps every By kind to a selector", () => {
    expect(bySelector("linkText", "About Us")).toBe("xpath=//a[normalize-space()='About Us']");
    expect(bySelector("partialLinkText", "Forgot")).toBe("xpath=//a[contains(normalize-space(),'Forgot')]");
    expect(bySelector("id", "x")).toBe('[id="x"]');
    expect(bySelector("className", "btn")).toBe(".btn");
  });
});

/** The capture JS lives in a Java text block; undo the text-block escapes to run it as-is. */
function captureJs(): string {
  const src = fs.readFileSync(path.resolve(__dirname, "../../src/main/java/SnapshotCapture.java"), "utf8");
  const a = src.indexOf('CAPTURE_TREE_JS = """') + 'CAPTURE_TREE_JS = """'.length;
  const b = src.indexOf('""";', a);
  const raw = src.slice(src.indexOf("\n", a) + 1, b);
  const lines = raw.split("\n");
  const indent = Math.min(...lines.filter((l) => l.trim()).map((l) => l.match(/^ */)![0].length));
  return lines.map((l) => l.slice(indent)).join("\n")
    .replace(/\\(\n|.)/g, (_m, c: string) => (c === "n" ? "\n" : c === "t" ? "\t" : c === "s" ? " " : c === "\n" ? "" : c));
}

describe.skipIf(!fs.existsSync(CHROME))("capture writes anchored relative XPath (live, needs Chrome)", () => {
  it("uses following-sibling / parent / label / stable-ancestor anchors and never a generated id", async () => {
    const { chromium } = await import("playwright-core");
    const b = await chromium.launch({ executablePath: CHROME });
    try {
      const p = await b.newPage();
      await p.setContent(`<body>
        <table id="users"><tr><th>Name</th><th>Role</th><th></th></tr>
          <tr><td>Alice Smith</td><td>Admin</td><td><button id="btn-a8f3k2m9x1">Edit</button></td></tr>
          <tr><td>Bob Jones</td><td>Viewer</td><td><button id="btn-q7w2e9r4t1">Edit</button></td></tr></table>
        <div class="grid">
          <div class="card css-1x2y3z4"><h5>Claw Hammer</h5><span>$12.01</span><button>Add to cart</button></div>
          <div class="card css-9k8j7h6"><h5>Thor Hammer</h5><span>$11.14</span><button>Add to cart</button></div></div>
        <div><span>Quantity</span><input id="mat-input-7" type="number"></div>
        <form><label for="ember4821">Street</label><input id="ember4821" type="text"></form>
        <div id="filters"><input type="checkbox" id="cb-01M5GND72GRNKJ0VS990Z1N3CF"></div></body>`);
      const js = captureJs();
      const res = await p.evaluate(`(function(){ const a=[{maxTableRows:5,redactPasswords:true,redactEmails:false}]; return (function(){ ${js} }).apply(null,a); })()`);
      const tree: string = typeof res === "string" ? res : (res as { tree: string }).tree;
      expect(tree).toContain("//td[normalize-space()='Alice Smith']/following-sibling::td//button[normalize-space()='Edit']");
      expect(tree).toContain("//h5[normalize-space()='Thor Hammer']/parent::div//button[normalize-space()='Add to cart']");
      expect(tree).toContain("//span[normalize-space()='Quantity']/following-sibling::input");
      expect(tree).toContain("//label[normalize-space()='Street']/following-sibling::input[1]");
      expect(tree).toContain("//div[@id='filters']//input[@type='checkbox']");
      expect(tree).not.toMatch(/a8f3k2m9x1|mat-input-7"|ember4821|01M5GND7|nth-child/);
      const xs = [...tree.matchAll(/by: xpath, value: "((?:[^"\\]|\\.)*)"/g)].map((m) => JSON.parse('"' + m[1] + '"') as string);
      expect(xs.length).toBeGreaterThanOrEqual(7);
      for (const x of xs) expect(await p.evaluate((q) => document.evaluate(q, document, null, 7, null).snapshotLength, x), x).toBe(1);
    } finally {
      await b.close();
    }
  });
});
