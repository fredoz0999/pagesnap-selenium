# Design — Accuracy items: in-tree alerts, ancestry disambiguation, truncation markers

**Date:** 2026-08-03
**Status:** Approved by user (conversation), implementation pending
**Scope:** `SnapshotCapture.CAPTURE_TREE_JS` (injected walker), diff classifier, LabBugHunt scenarios, shared `../test-site` lab additions.
**Goal:** Improve *accuracy* of snapshots as an LLM "mental image" of the app. Token cost is secondary; no new caps are introduced.

## Background (current behavior)

- `role="alert"` elements are already tree nodes (`INTERESTING` includes `alert`). Role-less error banners (`.error`, `.errors`, `.alert-error`, `.validation-error`, `.has-error`) appear only in a `# --- Visible alerts / errors ---` comment footer, which scans the top document only, dedupes, drops texts ≥ 300 chars, and caps at 10 — and models skim `#` comments.
- Field error binding exists via `validationMessage:` and `aria-errormessage` → `error:` detail lines. `aria-describedby` is not consulted.
- The tree nests under named containers, but the flat Selenium hints label elements by accessible name alone; duplicate `(role, name)` pairs are indistinguishable line-to-line.
- Silent truncations: depth > 30 subtree drop, hints capped at 24, alert footer caps. Tables already emit `# ... N more rows`.

## Decisions (user-approved)

1. **Alert footer is deleted** — alerts live only in the tree (single source of truth; tree also covers iframes, footer did not).
2. **Ancestry qualifiers appear in tree AND hints, only on collision** — untouched lines when unambiguous.
3. Approach: extend `CAPTURE_TREE_JS` in place (two-pass walk). No Java-side post-processing of tree text; no lean-style structured collection rewrite (that is the separate lean-port effort).

## Section 1 — Alerts & validation in-tree

**Promotion rule.** During the walk, a visible element is treated as `role=alert` when ALL hold:

- it matches `.error, .errors, .alert-error, .validation-error, .has-error`;
- it has no explicit `role` attribute and no implicit interesting role (elements that already have a role are untouched);
- its collapsed `innerText` is non-empty.

The promoted node is emitted at its real DOM position (naturally adjacent to the field it describes). Name = collapsed `innerText`, redacted, capped at 300 chars with a trailing `…` (today ≥300-char alerts are dropped entirely; capping is strictly more accurate). Children are still walked, so e.g. a "Dismiss" button inside a banner remains actionable; nested `.error` descendants of a promoted banner are NOT re-promoted (avoid double-reporting the same text).

**Alert name fallback (added during planning).** `accessibleName()` returns `''` for typical `role="alert"` elements (no aria-label / labelledby), so today their text appears ONLY in the footer being deleted. New rule: any node whose computed role is `alert` (explicit or promoted) and whose accessible name is empty takes its collapsed `innerText` (redacted, capped at 300 chars with `…`) as its name. Without this, deleting the footer silently erases alert text from snapshots (and lab scenarios 15/19 regress). `alertdialog` is excluded — its children are walked and using full innerText as its name would duplicate them.

**Implicit `region` role (added during planning).** `implicitRole()` returns `null` for `<section>`; per ARIA, `<section>` with an accessible name is `role=region`. Fix: `section` with `aria-label`/`aria-labelledby` → `'region'`. Without this, the ancestry qualifier can never see the lab's (and most real apps') named `<section>` containers.

**Field binding.** Existing `validationMessage:` and `aria-errormessage` → `error:` details stay. New rule: when an element has `aria-invalid="true"` and no `aria-errormessage`, resolve `aria-describedby` (first id that resolves to an element with non-empty text) and emit its collapsed text as `error:`.

**Footer removal.** The `# --- Visible alerts / errors ---` block is removed from `CAPTURE_TREE_JS`. The diff classifier special-case for `# alert` lines (`looksLikeOptionLine` / dropdown-section logic around `SnapshotCapture.java:1795`) is updated: alert lines are now ordinary tree lines and must diff as such.

## Section 2 — Collision qualifiers (duplicate names)

The walker becomes **two-pass**:

- **Pass 1 (count):** walk all documents/frames with the same visibility/role logic and count `(role, name)` occurrences across the entire capture (all frames — the existing `in-iframe=` extra already distinguishes frames when that is the differentiator). Record each element's DOM-order index within its collision group and its nearest named container.
Collision qualifiers apply only to nodes with a **non-empty accessible name** — unnamed structural nodes (bare `listitem`, `row`, `cell`…) never receive qualifiers, however many there are.

- **Pass 2 (emit):** identical to today's emission, plus for named nodes whose `(role, name)` count > 1:
  - Tree line gains `[in="<container name>"]` — nearest ancestor having a container role in `{region, form, dialog, alertdialog, navigation, article, complementary, banner, contentinfo, main, tabpanel}` AND a non-empty accessible name. The qualifier joins the existing extras bracket (e.g. `- button "Save" [disabled, in="Billing"]`).
  - Hint label becomes `// <container> > <name>: driver.findElement(...)`.
  - **Fallback:** if no named ancestor exists, or the colliding elements resolve to the *same* container name, emit an ordinal `[dup K/N]` (DOM order across the capture) in the extras bracket instead, and label the hint `// <name> (K/N): driver.findElement(...)` — the model at least knows duplicates exist and which one this line is.
- Non-colliding nodes are byte-identical to today's output.

Pass 1 must reuse the same promotion rule from Section 1 so promoted alerts participate in counting (identical alert texts get `[dup K/N]`).

## Section 3 — Truncation markers

No new caps. Every existing silent cap gains an explicit in-place marker:

| Cap | Today | New |
|---|---|---|
| Depth > 30 | subtree silently dropped | one `- … (subtree truncated at depth 30)` line at the cut point, at the capped indent, once per truncated branch |
| Hints > 24 | silently sliced | final hint line `// … N more hints truncated` |
| Alert text ≥ 300 chars | dropped from footer | in-tree name capped at 300 with `…` (Section 1) |
| Table rows > maxTableRows | `# ... N more rows` | kept, wording `# … N more rows (truncated)` |
| Field value > 80 chars | `…` suffix | unchanged (already marked) |
| In-tree `<select>` options | uncapped | stays uncapped (accuracy first) |

## Testing

**Lab additions (`../test-site`, shared with pagesnap-playwright-legacy — ADD pages/sections only, never modify existing ones):** a new lab page/section providing:

1. a role-less `.error` banner bound to an invalid field (plus an `aria-invalid` + `aria-describedby` field with no `aria-errormessage`);
2. duplicate `button "Save"` in two *named* regions AND a duplicate pair inside anonymous containers;
3. a > 30-deep nesting well and enough actionable elements (> 24 hints) to trip the hint cap.

**LabBugHunt scenarios (new, appended):** assert the promoted `alert "…"` node text, the `error:` binding from describedby, `[in="…"]` on both Saves, `[dup 1/2]`/`[dup 2/2]` on the anonymous pair, the depth marker line, and the hints-truncated line. Also assert the footer header string no longer appears in any scenario output.

**Java unit tests (`SnapshotCaptureTest`):** diff-classifier behavior with alert lines as ordinary tree lines (added/removed alert nodes appear under `## Added` / `## Removed`, not the dropdown section).

**Regression bar:** all 20 existing unit tests pass; existing LabBugHunt scenarios pass unchanged except where they asserted the footer (update those assertions to the in-tree form).

## Out of scope

- Virtualized/windowed list policy (parking-lot #9), wait hints (#5), frame-path documentation (#7), shadow chains (#8).
- The lean pack format port (`../pagesnap-playwright-legacy/docs/HANDOFF.md`).
- The untracked work-in-progress `src/main/java/DiffLabHunt.java` is left untouched.

## Risks

- **Banner class list is heuristic** — promotion is limited to the five existing selectors already trusted by the footer; no new selectors, so no new false-positive surface.
- **Two-pass walk cost** — pass 1 is DOM-read-only and skips line building; capture is user-triggered (not per-frame), so latency impact is negligible.
- **Shared lab site** — additions only; pagesnap-playwright-legacy' existing scenario assertions cannot break from added pages/sections.
