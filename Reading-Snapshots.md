# Reading snapshots — Selenium test generation from page snapshots

You are given YAML page snapshots of a real web UI, captured for generating **Selenium Java** tests.

## Files in a session folder

- `SESSION.md` — start URL, goal, framework, style. Read first.
- `TEST_GUIDE.md` — short rules for a runnable test. Read second.
- `flow.md`, `NN_<host>.yaml`, `NN_diff.md`, `PROMPT.md`, this file.

## How to read snapshots

- `generic` nodes have a test id but no ARIA role (cart badge, icon links). Reach them through their `by: css` `[data-test...]` locator; never treat `generic` as a role.

- Header comments: URL, timestamp, step number, optional user note / session goal.
- Tree lines: ARIA-inspired roles (`button`, `textbox`, `link`, …) and accessible names.
- Nested under controls:
  - `value` — current field value (passwords redacted as `***`)
  - `locators` — ordered candidates (best first) with `stability: high|medium|low` and a numeric `score`.
    Each was checked against the live page while capturing and resolves to
    exactly this element. One carrying `matches: N` is the exception: it finds N
    elements (a radio group, say), so narrow it before use — Selenium will
    silently take the first match.
  - `options:` — **native `<select>`** choices (listed even when the list looks closed)
  - `dropdown: open|closed` when `aria-expanded` is set (custom widgets)
  - `validationMessage` / `error` when present
  - flags in brackets: `required`, `disabled`, `invalid`, `checked`, …
- Comment sections: full `<select>` options dump, table headers/rows.
- Alerts and validation are tree nodes: `- alert "message"` at their page position; field errors appear as `error:` / `validationMessage:` details under the field.
- Duplicate names carry a qualifier: `[in="Billing"]` (nearest named container) or `[dup 2/3]` (DOM-order ordinal). Hints mirror it: `// Billing > Save: …`.
- `…`/`truncated` markers mean content was cut at a cap — never assume unlisted rows/subtrees don't exist.
- Optional Selenium hints block with suggested `By.*` calls (best-effort only).
- `flow.md` — ordered steps and notes (the intended scenario narrative).
- `NN_diff.md` — lines added/removed vs previous step, with a **Dropdown / options changes** section when relevant.
- `PROMPT.md` — user goal and project conventions for this session.

## Dropdowns (important)

### Native HTML `<select>`
- Options live in the DOM even when closed.
- **One snapshot is enough** — use nested `options:` under the combobox/listbox (and the `# --- All <select> options ---` dump).
- In Selenium prefer `new Select(element)` / `selectByVisibleText` rather than clicking each option node.

### Custom dropdowns (div / listbox / combobox widgets)
- Options often **do not exist in the DOM until opened**.
- Expect **two captures** in `flow.md`:
  1. Closed control (e.g. note: “account type closed”)
  2. After click — options visible (e.g. note: “account type options open”)
- Read `NN_diff.md` section **Dropdown / options changes** for what appeared after open.
- In tests: click/open first, then wait for options, then select.

## Locator rules

1. Prefer the highest `score` (data-test css 98, id 92, name 88, linkText 75, other css 45-85, xpath 40). Never use `score <= 40` unless nothing else exists; a `matches: N` locator is not unique (score capped at 40). Prefer `stability: high` (`id`, `name`, `data-testid` / `data-test` / `data-cy`).
2. Then `css` with stable attributes.
3. Use `xpath` / link text only as last resort.
4. Never invent ids or names not present in the snapshot.
5. Prefer a consistent locator style inside each Page Object.

## Selenium Java conventions

- Use explicit waits (`WebDriverWait` + `ExpectedConditions`) unless `PROMPT.md` says otherwise.
- Prefer Page Object structure for multi-step flows when `style=pageobject`.
- Assert on visible text, URL, or element state described in snapshots and `flow.md` notes.
- Keep tests independent where possible; use cookie auth files if provided by the user.

## Flow

Follow `flow.md` step order. Step notes describe user intent (e.g. "empty register form", "dropdown open").
Treat each YAML as a checkpoint for arrange / act / assert design.

## Output expectations

- Compilable Selenium Java against the stack named in `PROMPT.md` (`framework`, `waits`).
- No hallucinated UI controls.
- Clear test names that match the session goal and step notes.
- Correct handling of native vs custom dropdowns as above.
