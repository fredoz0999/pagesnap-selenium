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

## Locator rules

What the capture records for each control, best first (`score`):

| Locator | Score | Notes |
|---|---|---|
| `data-test` / `data-testid` / `data-cy` / `data-qa` css | 98 | only if the value is stable |
| `By.id` | 92 | only if the value is stable |
| `By.name` | 88 | only if the value is stable |
| `By.linkText` | 75 | visible text |
| css (aria-label, placeholder, href, prefix) | 45-85 | by stability |
| anchored relative xpath | 60 | used when id, name and test id are missing, generated or repeated (see below) |
| positional css (`nth-child`) | 45 | last resort, controls only; dropped once anything scores 60+ |
| other xpath | 40 | last resort |
| generated value (see below) | 20 | listed only when nothing stable exists |

**A value that changes between runs is never a valid locator**, in any attribute: ULIDs and UUIDs, long hex hashes, 3+ digit runs
(`input-8472`), framework counters (`mat-input-4`, `ember1234`, `react-select-3-input`, `:r1:`), and hashed CSS classes (`css-1x2y3z`,
`Button_primary__x7Gh2`). The capture drops such a locator whenever a stable one exists and falls back to label text, placeholder,
button text, or a unique stable prefix (`[data-test^="category-"]`). `pack validate` fails (`DYN`) on tests that use one, `pack pom`
marks it `DYNAMIC`, and `pack heal` never suggests one. The rule lives in `isDynamicValue` (capture JS) and `pack/src/dynamic.ts`;
a test keeps the two identical.

**Anchored relative XPath** - written the way SDETs hand-write it, and only kept if it matches exactly one element:

| Pattern | Example |
|---|---|
| visible text | `//button[normalize-space()='Pay now']` |
| label -> control | `//label[normalize-space()='Street']/following-sibling::input[1]` (or `//label[...]//input` when wrapped) |
| caption sibling | `//span[normalize-space()='Quantity']/following-sibling::input[@type='number'][1]` |
| table row | `//td[normalize-space()='Alice Smith']/following-sibling::td//button[normalize-space()='Edit']` |
| repeated card | `//h5[normalize-space()='Claw Hammer']/ancestor::a[contains(@class,'card')][1]//button[@data-test='compare-btn']` |
| parent | `//h5[normalize-space()='Thor Hammer']/parent::div//button[normalize-space()='Add to cart']` |
| stable ancestor | `//div[@id='filters']//input[@type='checkbox']` |
| stable prefix (weakest) | `//input[starts-with(@id,'mat-input-')]` |

Prices, counts and record numbers are never used as anchors (they are data).

**Your own hand-written locators**
- `pack validate <session> <src/test/java>` reviews them without a browser: `FRAG` for absolute XPath (`/html/body/...`), index-only
  chains (`//div[3]/div[1]/...`), XPath with no text/attribute/axis anchor, and positional css; `DYN` for generated values (also in
  single-quoted XPath like `@id='mat-input-4'`). Anchored relative XPath (text, `@attr`, `contains()`, `following-sibling::`,
  `parent::`, `ancestor::`) passes the review.
- `pack verify <session> --java=<src/test/java>` proves them live: every `By.*` literal is counted on each captured page -
  `OK` (exactly one match), `AMBG` (several: Selenium silently takes the first), `GONE` (typo or the element changed). Link text is
  matched on visible text, as Selenium does. Pages behind login need `--storage`.

## Sibling

Playwright / TypeScript capture: https://github.com/fredoz0999/pagesnap-playwright
