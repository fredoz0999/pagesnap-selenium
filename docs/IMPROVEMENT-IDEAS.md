# Selenium-snapshots — improvement ideas (parking lot)

**Status:** Not scheduled. Captured 2026-08-03 after lab testing, token lean-up, and Playwright comparison.  
**Context:** Tool is good enough for LLM Selenium Java generation for now; these are optional next steps.

---

## Already done (baseline)

- Lab benches (redact, dup names, nest frames, role soup)
- Password free-text sweep + nested iframe walk
- Token-lean multi-locators (max 2, drop redundant twins, actionable-only)
- UI: Phosphor fill icons, shadcn-ish dark chrome, note Cancel + resizable textarea, minimize bar with full actions

---

## P0 — Highest impact for LLM success

1. **Notes as first-class intent** — conventions or fields: `action:`, `assert:`, `data:` so models treat notes as structured scenario, not free prose only.
2. **Light per-step deltas** — short “what changed” appendix (not full Playwright lean); reduce re-reading SPA chrome every step.
3. **Default one best locator** — emit second only when needed (even leaner than max 2).
4. **Ready-to-paste Java** — optional `By.id("…")` one-liners or `locators.java` sidecar next to YAML.
5. **Wait hints at capture** — record DOM-ready / busy / target for explicit waits in generated tests.

---

## P1 — Accuracy / hard UI

6. **Named alerts in the tree** — `alert "message…"` not only `# alert:` comments (models skip comments). — DONE 2026-08-03 (in-tree alert nodes, accuracy items)
7. **Document frame paths** — always guide `switchTo` for nested `outer/inner` in PROMPT / Reading-Snapshots.
8. **Shadow piercing** — explicit host → open shadow → control chain.
9. **Virtual / windowed lists** — capture policy + note scroll position; don’t invent off-screen rows.
10. **Duplicate names** — region ancestry or testid preference (`Region Alpha > Save`).

---

## P2 — Tokens / pack shape

11. **Chrome dictionary** — hoist repeated shell/tablist once per session; steps reference it.
12. **`--lean` / `--full` modes** — lean for LLM; full for debugging.
13. **Shrink or drop hints footer** when tree already has locators (duplication).
14. **Harder table caps** — 2–3 rows default; full table only on note request.

---

## P3 — Product / DX

15. **Auto-capture-and-exit / headless lab mode** for CI (like snapgen smoke).
16. **Console banner sync** — still prints Ctrl+K in places; UI is Ctrl+M.
17. **Session quality score on End** — steps, empty trees, secret leaks, est. tokens.
18. **Auth / cookies / storageState** robustness for behind-login apps.
19. **Shared multi-metric harness** with pagesnap-playwright-legacy / snapgen scorecards.
20. **PROMPT templates by goal** — login, CRUD, modal validation, etc.

---

## P4 — Longer term

21. **Stable cross-step element ids** (`eN`) for flow language.
22. **Action recording** (click/type) → graph edges / flows.
23. **MCP** — only if org standardizes; files-first remains preferred.

---

## If only three next

| # | Idea | Why |
|---|---|---|
| 1 | Chrome hoist / light step deltas | Biggest remaining token + attention win |
| 2 | Named alerts + Java `By` one-liners | Better asserts, less conversion error |
| 3 | Wait hints + note conventions | Fewer flaky generated tests |

---

## Related artifacts

- Lab scorecards: `../pagesnap-playwright/test-result/` (`TOKEN-COMPARISON-LAB.md`, `PLAYWRIGHT-VS-SELENIUM.md`, `SELENIUM-FEEDBACK.md`)
- Lab bug-hunt: `pageSnapshots/session-lab-bug-hunt-se-*`
