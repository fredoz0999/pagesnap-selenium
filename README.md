# PageSnap Selenium

Manual page snapshot tool using **Java + Selenium WebDriver**.

Captures rich YAML snapshots so an LLM can generate **Selenium Java** tests with better locators and flow context.

Selenium counterpart of [`pagesnap-playwright`](../pagesnap-playwright/) (canonical Playwright capture) and legacy [`pagesnap-playwright-legacy`](../pagesnap-playwright-legacy/).

Unlike auto-nav capture tools, this does **not** auto-capture on navigation.  
You capture only when you press **Ctrl+M** (Cmd+M on Mac).

## Requirements

- Java 17+
- Maven 3.9+
- Chrome (Selenium Manager downloads the matching driver automatically)

## Tutorial

Full command cheatsheet and workflow: **[Tutorial.md](Tutorial.md)**

## Run

```bash
cd pagesnap-selenium
mvn -q exec:java -Dexec.args="https://your-app.com"
```

With a goal and cookie save:

```bash
mvn -q exec:java -Dexec.args="https://parabank.parasoft.com/parabank/index.htm --goal=Register a new user --save-cookies=cookies.json"
```

Local HTML file:

```bash
mvn -q exec:java -Dexec.args="file:///C:/path/to/page.html"
```

## Controls

| Control | Action |
|---------|--------|
| **Toolbar** (primary) | **📸 Capture** · **📝 Note** · **⏹ End** · dock cycle (L/M/R) |
| **Ctrl+M / Cmd+M** | Capture snapshot (no note) |
| **Ctrl+Shift+M / Cmd+Shift+M** | Capture with note form |
| **Ctrl+Q / Cmd+Q** | End session (optional folder name) |
| **Close browser** | Stop capturing |

Use the **on-screen toolbar** if the app swallows hotkeys.  
**Multi-tab:** new tabs are detected, toolbar is injected, capture runs on the tab that signaled.  
Toast **Saved snapshot #N** appears top-right. Injected chrome is hidden during capture (not in YAML).

Snapshots are **never** taken automatically on URL change.

### Dropdowns

| Type | How to capture |
|------|----------------|
| Native `<select>` | **One** snapshot — options are always listed under `options:` |
| Custom menu (options load on click) | Snapshot **closed**, open it, snapshot **open** (use notes). Diff highlights option changes. |

## Options

| Option | Description |
|--------|-------------|
| `--goal=<text>` | Session goal written into `PROMPT.md` and YAML headers |
| `--config=<file>` | Load a properties config (default: `capture.config.properties` if present) |
| `--output=<dir>` | Output root (default: `pageSnapshots`) |
| `--flat` | Write into output root instead of `session-*` subfolder |
| `--load-cookies=<file>` | Load cookies JSON, then refresh |
| `--save-cookies=<file>` | Save cookies JSON on exit |
| `--max-table-rows=<n>` | Table body rows to dump (default: 5) |
| `--framework=junit5` | Copied into agent prompt |
| `--style=pageobject` | Copied into agent prompt |
| `--waits=explicit` | Copied into agent prompt |
| `--no-hints` | Skip Selenium hint comments |
| `--no-redact` | Do not mask passwords/emails |
| `--no-diff` | Skip step-to-step diffs |
| `--chromedriver=<path>` | Optional one-run override of `chromeDriverPath` |
| `--timezone=<zone>` | IANA zone for session folder timestamps (default: `America/New_York`) |
| `--toolbar-position=left\|middle\|right` | Dock floating toolbar (default: `right`) |

### ChromeDriver path (single place)

Edit **only** `capture.config.properties` when the driver binary changes:

```properties
chromeDriverPath=C:\\Drivers\\chromedriver_150.exe
```

Examples after a Chrome update:

```properties
chromeDriverPath=C:\\Drivers\\chromedriver_151.exe
```

- Leave blank / comment out → Selenium Manager tries to download a driver.
- Path must exist or startup fails with a clear error.
- `--chromedriver=` is only for a temporary one-run override (optional).

See `capture.config.properties` for the same knobs as a file.

## Output layout

Each run creates a **new timestamped session folder** under `pageSnapshots/` (prior sessions are kept).  
Timestamps use **America/New_York** (EST/EDT), e.g. `session-2026-07-22T15-30-45`.  
On **End** (Ctrl+Q), you can optionally name the folder → `session-<name>-2026-07-22T15-30-45`.

Each run creates an **agent-ready session folder**:

```text
pageSnapshots/
  session-2026-07-21T12-30-00/
    01_parabank.parasoft.com_parabank_index.htm.yaml
    02_parabank.parasoft.com_parabank_register.htm.yaml
    02_diff.md
    flow.md
    PROMPT.md
    Reading-Snapshots.md
```

### What each file is for

| File | Purpose |
|------|---------|
| `NN_*.yaml` | Page tree, locators, values, selects, tables, alerts |
| `NN_diff.md` | Lines added/removed vs previous step |
| `flow.md` | Ordered steps + your notes (scenario narrative) |
| `PROMPT.md` | Goal + Selenium conventions for the coding agent |
| `Reading-Snapshots.md` | How the LLM should read snapshots and pick locators |

### YAML contents (per step)

- Role/name tree (ARIA-inspired)
- Per-control **locator candidates** with `stability: high|medium|low`
- Field **values** (passwords → `***`), required/disabled/invalid flags
- Validation / alert text when visible
- Same-origin **iframe** contents; open **shadow DOM** children
- Full `<select>` options
- Table headers + first N rows
- Optional Selenium `By.*` hints
- Clean filenames (no `jsessionid` / query / fragment)

## Workflow (Claude Code / LLM)

1. Run the tool and open your app.
2. Navigate to each state you care about; press **Ctrl+M** (or **Ctrl+Shift+M** to add a note).
3. End the session (**Ctrl+Q**).
4. Point the agent at the session folder:

   > Read `PROMPT.md`, `Reading-Snapshots.md`, `flow.md`, and the YAML snapshots.  
   > Generate Selenium Java tests for the goal.

## Cookie auth

```bash
# First time: log in manually, save cookies on exit
mvn -q exec:java -Dexec.args="https://myapp.com --save-cookies=cookies.json"

# Later: restore session
mvn -q exec:java -Dexec.args="https://myapp.com --load-cookies=cookies.json"
```

Cookie files are secrets — do not commit them.

## Notes

- Manual capture is intentional — best for modals, validation errors, and filled forms.
- The tree is ARIA-inspired, not Playwright `ariaSnapshot()`.
- Cross-origin iframes are listed but not inspected.
- No screenshots — YAML tree + locators only.

## Sibling

Playwright / TypeScript capture: https://github.com/fredoz0999/pagesnap-playwright

## Token-lean pack (compact + retrieval)

A Node sidecar in [`pack/`](pack) ported from `pagesnap-playwright`'s `feat/token-lean-retrieval`. It reads the same
YAML session folders and gives an agent only the UI for the step it is on instead of every `NN_*.yaml`.

```
cd pack && npm install
npm run pack -- build latest                    # lean/ : compact snapshots, region chunks, index, PACK.md, prompts
npm run pack -- query latest "add the Fleece Jacket to the cart" --step=2 --diff
npm run pack -- stats latest
npm run pack -- bench latest [--md]             # tokens per approach for the whole flow
npm run pack -- pom latest --out=../src/test/java/pages [--package=pages]   # Java page objects, no LLM
npm run pack -- validate latest ../src/test/java      # check every By.* against the snapshots, exit 1 on MISS
npm run pack -- heal latest ../src/test/java [--log=maven-output.txt] [--write]   # suggest/apply replacements for missing or failing By.*
npm run pack -- verify latest [--base-url=https://staging.example.com]             # live drift check: ok / gone / ambiguous
npm run pack -- bdd latest --features=../src/test/resources/features --steps=../src/test/java/steps \
  --driver="com.acme.DriverManager.getDriver()" [--assertions=testng|junit] [--runner=testng|junit] [--tags=@smoke]
npm run pack -- prompt latest --cucumber          # agent prompt: pom -> bdd draft -> fill pending -> validate
npm run pack -- install-prompts ../my-selenium-tests   # /pagesnap-automate and /pagesnap-testcases
npm run mcp                                     # same query tools as an MCP server (stdio)
```

Run from the repo root where `pageSnapshots/` lives (or set `PAGESNAP_CWD`). Query ranking is hybrid: BM25 keywords +
vector cosine (dependency-free hashing embedder; `--embedder=minilm` after `npm i -D @huggingface/transformers`) +
an exact accessible-name bonus. A weak match falls back to the whole compact page. Locators come back as
`=> css=[data-test="x"]`, `#id`, `[name=V]`, `linkText=`, `xpath=` and map directly to `By.*`.

**pom** writes `BasePage.java` (controls on half or more of the pages) plus one class per URL path. Every member is a
`public static final By FOO_BUTTON` and a `fooButton()` returning the `WebElement`, built from the best-scored verified
locator; fragile ones (xpath, `nth-child`, score <= 45) are marked. `PAGES.md` is the small member map an agent reads.

**validate** scans `.java` files for `By.id/name/cssSelector/linkText/partialLinkText/xpath/className` string literals.
`MISS` = an id or link text that was never captured (invented), `AMBG` = matches several elements, `????` = cannot be
checked (variable argument, xpath, a name the capture dropped because two stronger locators won).

### Cucumber / BDD stacks

`bdd` turns the capture notes into a Cucumber-JVM draft with no LLM: `action:` clauses become `When` steps (click,
`I enter {string} into the ...`, `I select {string} from the ...`), `assert:` clauses become `Then` steps (displayed,
enabled/disabled, shows `{string}`, page shows text), and the first step opens the page. Each clause is matched to the
closest captured control, so a step definition calls the generated page object (`InventoryPage.ADD_TO_CART_FLEECE_JACKET_BUTTON`)
through explicit waits. A clause that matches nothing becomes a `PendingException` step that names what is missing; an
un-prefixed note that names no control is kept as a Gherkin comment. Run `pom` first (same `--pages-package`).

Defaults suit a Cucumber + TestNG project: `--assertions=testng`, no runner file (your project has its own), glue package
`steps`. Point `--driver` at your own accessor (a Serenity or ThreadLocal driver factory). Existing step definitions are
not read, so review the draft for duplicates before merging; `prompt --cucumber` tells an agent to reuse existing steps.

### Heal and verify

`heal` takes the locators `validate` calls `MISS`/`AMBG`, plus any locator a Selenium failure log names
(`NoSuchElementException ... {"method":"css selector","selector":"[id=\"x\"]"}`), and ranks the closest captured control by
name/id similarity (token overlap plus character bigrams, so `user_name` finds `username`). `--write` rewrites a call only when
the best candidate has confidence >= 0.75 and is 0.15 ahead of the runner-up, and never for ambiguous locators.

`verify` reopens every captured page in headless Chrome (via `playwright-core`; set `PAGESNAP_CHROME=/path/to/chrome` or
`PAGESNAP_CHANNEL=msedge`) and counts how many elements each recorded locator matches now: 1 ok, 0 gone, more than 1 ambiguous.
It uses Playwright only as a fast counter for CSS / XPath / link-text; it does not run your Selenium tests. `--base-url` points
the check at another environment; `--storage` takes a Playwright storageState for logged-in pages. Pages that redirected or
whose state differs from the capture are reported as skipped, not as drift. Exit code 1 when anything is gone.
