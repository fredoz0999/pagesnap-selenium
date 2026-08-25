# Snapshot tool — Tutorial & command cheatsheet

Always run from the project folder:

```bash
cd pagesnap-selenium
```

---

## Requirements

- **Java 17+** (`java -version`)
- **Maven 3.9+** (`mvn -version`)
- **Chrome** installed
- Optional: local ChromeDriver path in `capture.config.properties` if Selenium Manager cannot download a driver

---

## Maven commands

| Command | What it does |
|---------|----------------|
| `mvn -q compile` | Compile only |
| `mvn -q exec:java -Dexec.args="URL"` | Start capture (main command) |
| `mvn -q exec:java` | No URL → prints usage/help |

**Correct spelling:** `-Dexec.args=` (not `-Dexe.args=`)

`-q` = quiet Maven (optional — less console noise).

### Examples

```bash
# Basic
mvn -q exec:java -Dexec.args="https://parabank.parasoft.com/parabank/index.htm"

# Goal for the AI prompt pack (quote the whole value if it has spaces)
mvn -q exec:java "-Dexec.args=https://parabank.parasoft.com/parabank/index.htm --goal=Register a new user"

# Local HTML file
mvn -q exec:java -Dexec.args="file:///C:/path/to/page.html"

# Save cookies after you log in
mvn -q exec:java -Dexec.args="https://myapp.com --save-cookies=cookies.json"

# Reuse cookies next time
mvn -q exec:java -Dexec.args="https://myapp.com --load-cookies=cookies.json"

# Custom output dir + table depth
mvn -q exec:java -Dexec.args="https://myapp.com --output=mySnaps --max-table-rows=10"

# One-off ChromeDriver override (prefer property file day-to-day)
mvn -q exec:java -Dexec.args="https://myapp.com --chromedriver=C:/Drivers/chromedriver_150.exe"
```

---

## CLI options (after the URL)

| Option | Description |
|--------|-------------|
| `--goal=<text>` | Written into `PROMPT.md` + YAML headers |
| `--config=<file>` | Extra properties file (default auto-loads `capture.config.properties`) |
| `--output=<dir>` | Output root (default: `pageSnapshots`) |
| `--flat` | No `session-*` subfolder; write into output root |
| `--load-cookies=<file>` | Load cookies JSON, then refresh |
| `--save-cookies=<file>` | Save cookies JSON on exit |
| `--max-table-rows=<n>` | Table rows to dump (default: 5) |
| `--framework=<name>` | e.g. `junit5`, `testng` → into agent prompt |
| `--style=<name>` | e.g. `pageobject`, `linear` |
| `--waits=<name>` | e.g. `explicit`, `fluent` |
| `--no-hints` | Skip Selenium `By.*` hint comments |
| `--no-redact` | Don’t mask passwords/emails |
| `--no-diff` | Skip `NN_diff.md` between steps |
| `--chromedriver=<path>` | One-run override of driver path |
| `--timezone=<zone>` | IANA zone for session folder timestamps (default: `America/New_York`) |

CLI flags **override** `capture.config.properties`.

---

## Keyboard (in the Chrome window — focus the page)

| Shortcut | Action |
|----------|--------|
| **Toolbar** (primary) | **📸 Capture** · **📝 Note** · **⏹ End** · dock L/M/R |
| **Ctrl+M / Cmd+M** | Capture now (no note) |
| **Ctrl+Shift+M / Cmd+Shift+M** | Capture with note form |
| **Ctrl+Q** | End session (optional folder name) |
| Close browser | End session |
| **New tabs** | Auto-detected; toolbar injected; capture that tab |

Prefer the **toolbar** if hotkeys are swallowed. No auto-capture on navigation.

---

## Config file (`capture.config.properties`)

Edit once; no need to pass flags every run:

| Property | Meaning |
|----------|---------|
| `outputDir` | Snapshot root (`pageSnapshots`) |
| `sessionSubdir` | `true` → `session-<timestamp>/` |
| `includeHints` | Selenium hint comments |
| `redactPasswords` / `redactEmails` | Mask secrets |
| `writeDiff` | Write step diffs |
| `maxTableRows` | Table dump size |
| `framework` / `style` / `waits` | Agent prompt conventions |
| `goal` | Default session goal |
| `loadCookies` / `saveCookies` | Cookie file paths |
| `chromeDriverPath` | **Preferred single place** for local driver path |
| `toolbarPosition` | `left` \| `middle` \| `right` (default `right`) |

Example driver line:

```properties
chromeDriverPath=C:\\Drivers\\chromedriver_150.exe
```

Comment it out (or leave blank) to use Selenium Manager auto-download.

---

## What each run does

1. Creates a **new** `session-YYYY-MM-DDTHH-mm-ss/` under `pageSnapshots/` (America/New_York; keeps older sessions)  
2. Opens Chrome to your URL  
3. On each capture → YAML (+ optional note)  
4. On **End** (Ctrl+Q), optional folder name → `session-<name>-YYYY-MM-DDTHH-mm-ss/`  
5. Writes a session pack:

```text
pageSnapshots/session-.../
  01_....yaml
  02_....yaml
  02_diff.md
  flow.md
  PROMPT.md
  Reading-Snapshots.md
```

---

## Dropdowns

| Type | How to capture |
|------|----------------|
| Native `<select>` | **One** snapshot — options are always listed under `options:` |
| Custom menu (options load on click) | Snapshot **closed**, open it, snapshot **open** (use notes). Diff highlights option changes. |

---

## Tips

| Goal | Do this |
|------|---------|
| Quick smoke test | Ctrl+M / Cmd+M only |
| Step notes for Claude / LLM | Ctrl+Shift+M / Cmd+Shift+M |
| Custom dropdown options | Capture closed → open menu → capture open |
| Native `<select>` | One capture is enough (`options:` always listed) |
| Feed LLM | Point it at the session folder + `PROMPT.md` + `Reading-Snapshots.md` |

---

## Typical workflow

1. `mvn -q compile` (optional)  
2. `mvn -q exec:java -Dexec.args="https://your-app.com --goal=Your goal"`  
3. Log in / navigate to the states you care about  
4. **Ctrl+M** or **Ctrl+Shift+M** on each important UI state  
5. **Ctrl+Q** when finished  
6. Open `pageSnapshots/session-.../` and hand it to your coding agent  

Cookie files (`cookies.json`) are secrets — do not commit them.
