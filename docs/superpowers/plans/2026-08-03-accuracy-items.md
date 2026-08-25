# Accuracy Items (In-tree Alerts, Ancestry, Truncation Markers) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make snapshots a more accurate LLM "mental image": alerts/validation as tree nodes bound to fields, `[in="…"]`/`[dup K/N]` qualifiers on duplicate names, explicit markers at every truncation point.

**Architecture:** All capture logic lives in the injected JS text block `SnapshotCapture.CAPTURE_TREE_JS` (a Java 17 text block inside `src/main/java/SnapshotCapture.java`). The walker becomes two-pass (count `(role,name)` pairs, then emit). Java-side changes are limited to the diff classifier and docs. Verification = 20 JUnit tests (no browser) + `LabBugHunt` headless harness against the shared `../test-site` vite lab on :4173.

**Tech Stack:** Java 17, Maven (`mvn -q test`, `mvn -q compile exec:java`), Selenium 4.27 headless Chrome, JUnit 5, React/Vite lab (`../test-site`).

**Spec:** `docs/superpowers/specs/2026-08-03-accuracy-items-design.md` — read it first.

## Global Constraints

- Repo root for all Java work: `C:\Users\bluem\Development\pageSnapShotGenerator\pagesnap-selenium` (branch `main`). Lab: `C:\Users\bluem\Development\pageSnapShotGenerator\test-site`.
- `CAPTURE_TREE_JS` is a **Java text block**: JS regex backslashes are doubled (`\\s+`), quotes `"` are plain. Match the file's existing escaping style exactly.
- `../test-site` is shared with pagesnap-playwright-legacy: **ADD pages/sections/components only — never modify or delete existing ones** (adding entries to `SectionId`/`MENU` is allowed; that is additive).
- No new caps anywhere; markers only annotate existing caps.
- Do not touch the untracked `src/main/java/DiffLabHunt.java`.
- Every commit message ends with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- LabBugHunt exits code 2 if ANY scenario has a bug — after each task, a full run must exit 0.
- Lab server: check `curl -s -o /dev/null -w "%{http_code}" http://localhost:4173` → if not `200`, start background: `npm start` in `../test-site` (vite dev, port 4173), wait for 200.

---

### Task 1: Lab additions — `bench-accuracy` section in test-site

**Files:**
- Create: `../test-site/src/components/BenchAccuracy.tsx`
- Modify: `../test-site/src/pages/HomePage.tsx` (three additive edits: `SectionId` union ~line 47, `MENU` array ~line 79, panel render block ~line 642)

**Interfaces:**
- Produces (used by LabBugHunt scenarios in Tasks 2/4/5): tab id `tab-bench-accuracy`; DOM ids `bench-acc-card` (input), `bench-acc-card-error` (div.error), `bench-acc-zip` (input with `aria-invalid` + `aria-describedby`), `bench-acc-zip-hint` (hint div), `bench-acc-copy-1`/`bench-acc-copy-2` (anonymous duplicate buttons named "Copy link"), `bench-acc-well-bottom` (deepest `li`, text "Bottom of the well").

- [ ] **Step 1: Create the component**

`../test-site/src/components/BenchAccuracy.tsx` (new file, full content):

```tsx
/** Benchmark: accuracy — role-less error banner, describedby binding, anonymous dups, deep well. */
export default function BenchAccuracy() {
  // 17 nested list levels; list+listitem each add a tree depth level (34 > 30 cap).
  const well = (level: number): JSX.Element => (
    <ul data-bench={`well-${level}`}>
      <li>
        {level >= 17 ? (
          <span id="bench-acc-well-bottom">Bottom of the well</span>
        ) : (
          well(level + 1)
        )}
      </li>
    </ul>
  );

  return (
    <div className="card flat" data-bench="accuracy" id="bench-acc-root">
      <p className="sub">
        Role-less <code>.error</code> banner, <code>aria-describedby</code> validation, anonymous
        duplicate buttons, and a 17-level nesting well.
      </p>

      <section aria-label="Payment" className="card flat" id="bench-acc-payment">
        <label className="field" htmlFor="bench-acc-card">
          Card number
        </label>
        <input id="bench-acc-card" name="cardNumber" type="text" defaultValue="4111" />
        <div className="error" id="bench-acc-card-error">
          Card number is invalid — use 16 digits.
        </div>

        <label className="field" htmlFor="bench-acc-zip">
          ZIP code
        </label>
        <input
          id="bench-acc-zip"
          name="zip"
          type="text"
          aria-invalid="true"
          aria-describedby="bench-acc-zip-hint"
        />
        <div id="bench-acc-zip-hint">ZIP code must be 5 digits.</div>
      </section>

      <div className="row" style={{ marginTop: '0.75rem' }}>
        <button type="button" className="btn" id="bench-acc-copy-1">
          Copy link
        </button>
        <button type="button" className="btn" id="bench-acc-copy-2">
          Copy link
        </button>
      </div>

      <div data-bench="deep-well" style={{ display: 'none' }} id="bench-acc-well-hidden-note" />
      {well(1)}
    </div>
  );
}
```

Note: the well is VISIBLE (do not wrap in `display:none` — invisible nodes are excluded from the tree). The stray `bench-acc-well-hidden-note` div is just an id anchor; keep it.

- [ ] **Step 2: Register the section in HomePage.tsx (three additive edits)**

(a) `SectionId` union — after `| 'bench-role-soup';` change `;` to newline and append:

```ts
  | 'bench-role-soup'
  | 'bench-accuracy';
```

(b) `MENU` array — append after the `bench-role-soup` entry:

```ts
  { id: 'bench-accuracy', label: 'Bench: accuracy', hint: 'error banner, dups, deep well' },
```

(c) Import next to the other bench imports at top: `import BenchAccuracy from '../components/BenchAccuracy';` and in the panel body render block (next to `{section === 'bench-dup-names' && <BenchDupNames />}`):

```tsx
          {section === 'bench-accuracy' && <BenchAccuracy />}
```

- [ ] **Step 3: Verify the lab compiles and serves**

Start/restart lab if needed (Global Constraints). Then:

Run: `curl -s http://localhost:4173 | grep -c "root"`
Expected: ≥ 1 (app serves). Vite dev hot-reloads; check the dev server log has no TypeScript/compile error mentioning `BenchAccuracy`.

- [ ] **Step 4: Commit (test-site is part of the parent repo or its own — check `git -C ../test-site rev-parse --show-toplevel` first)**

```bash
cd ../test-site
git add src/components/BenchAccuracy.tsx src/pages/HomePage.tsx
git commit -m "feat(lab): bench-accuracy section (error banner, describedby, anonymous dups, deep well)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

If test-site sits inside a parent repo working tree that is not a git repo of its own, commit wherever its history actually lives (`git -C ../test-site status` first; if untracked-parent, skip commit and note it in the task report).

---

### Task 2: Walker — alerts & validation in-tree, footer removal

**Files:**
- Modify: `src/main/java/SnapshotCapture.java` — inside `CAPTURE_TREE_JS`: `implicitRole` (~line 182), `emitNode` (~lines 578–695), footer block (~lines 792–803)
- Modify: `src/main/java/LabBugHunt.java` — scenario list (~lines 42–76)

**Interfaces:**
- Consumes: Task 1 lab ids.
- Produces: tree emits `- alert "<text>"` nodes (promoted + named role=alert), `error: "<describedby text>"` detail lines, `region` nodes for named `<section>`. Footer `# --- Visible alerts / errors ---` is GONE. `emitNode` signature becomes `emitNode(el, depth, prefix, inAlert)` — Task 4 extends it further with `countOnly`.

- [ ] **Step 1: Add failing LabBugHunt scenarios**

In `LabBugHunt.java` scenario list, append after scenario `19_bench_role_soup_alert`:

```java
                new Scenario("20_bench_acc_alerts", "bench-accuracy", "Bench accuracy: in-tree alerts", null,
                        List.of("- alert \"Card number is invalid — use 16 digits.\"",
                                "error: \"ZIP code must be 5 digits.\"",
                                "region \"Payment\"")),
```

Also add a global regression check inside the scenario loop, right after the `data-snapshot-tool` leak check (~line 170):

```java
                    if (tree.contains("# --- Visible alerts / errors ---")) {
                        findings.add(new Finding(sc.id(), "bug", "Legacy alerts footer still emitted"));
                    }
```

- [ ] **Step 2: Run LabBugHunt to verify the new scenario FAILS**

Run (lab must be serving): `mvn -q compile exec:java -Dexec.mainClass=LabBugHunt`
Expected: exit code 2; report shows `20_bench_acc_alerts` missing all three expected strings. Existing 19 scenarios still OK.

- [ ] **Step 3: Implement in `CAPTURE_TREE_JS`**

(a) `implicitRole` — add before `return null;` (~line 216):

```js
              if (tag === 'section') {
                const sn = (el.getAttribute('aria-label') || '').trim() || el.getAttribute('aria-labelledby');
                return sn ? 'region' : null;
              }
```

(b) Above `emitNode`, add helpers (~line 577):

```js
            const BANNER_SELECTOR = '.error, .errors, .alert-error, .validation-error, .has-error';
            const collapsedText = (el) => (el.innerText || '').replace(/\\s+/g, ' ').trim();
            const capAlertText = (t) => t.length > 300 ? t.slice(0, 300) + '…' : t;
```

(c) `emitNode` — change signature to `(el, depth, prefix, inAlert)` and replace the role/interesting/name computation:

```js
            const emitNode = (el, depth, prefix, inAlert) => {
              if (depth > 30) return;
              if (!el || el.nodeType !== 1) return;
              if (['SCRIPT', 'STYLE', 'NOSCRIPT', 'PATH'].includes(el.tagName)) return;
              if (el.hasAttribute && el.hasAttribute('data-snapshot-tool')) return;
              if (el.closest && el.closest('[data-snapshot-tool]')) return;

              let role = el.getAttribute('role') || implicitRole(el);
              let promoted = false;
              // Role-less error banners become real alert nodes at their DOM position
              if (!role && !inAlert && el.matches && el.matches(BANNER_SELECTOR)) {
                if (collapsedText(el)) { role = 'alert'; promoted = true; }
              }
              const interesting = role && INTERESTING.has(role) && isVisible(el);

              if (interesting) {
                let name = accessibleName(el);
                // role=alert text is the alert; without this the text is invisible in-tree
                if (role === 'alert' && !name) {
                  name = capAlertText(redactText(collapsedText(el)));
                }
```

(rest of the emission body unchanged — `name` now feeds the existing `if (name) line += …` code).

(d) `aria-describedby` binding — in the details section, right after the `aria-errormessage` block (~line 644), add:

```js
                  if (el.getAttribute('aria-invalid') === 'true' && !el.getAttribute('aria-errormessage')) {
                    const dids = (el.getAttribute('aria-describedby') || '').trim().split(/\\s+/).filter(Boolean);
                    for (const did of dids) {
                      const dEl = el.ownerDocument.getElementById(did);
                      const dt = dEl ? (dEl.innerText || '').replace(/\\s+/g, ' ').trim() : '';
                      if (dt) { lines.push(ind + 'error: "' + esc(redactText(dt)) + '"'); break; }
                    }
                  }
```

AND extend the `hasDetails` condition (~line 617) with:

```js
                  || (el.getAttribute('aria-invalid') === 'true' && el.getAttribute('aria-describedby'))
```

(e) Child recursion — thread the alert flag so `.error` descendants of an alert are not re-promoted:

```js
              const nextDepth = interesting ? depth + 1 : depth;
              for (const child of kids) {
                emitNode(child, nextDepth, prefix, inAlert || role === 'alert');
              }
```

(f) Call sites: `walkDocument` body becomes `emitNode(doc.body, depth, prefix, false);`.

(g) DELETE the footer block — the whole `// visible alerts / validation banners` section (`const alerts = …` through its closing `}`; ~lines 792–803).

- [ ] **Step 4: Compile + unit tests still green**

Run: `mvn -q test`
Expected: `Tests run: 20, Failures: 0, Errors: 0`.

- [ ] **Step 5: Run LabBugHunt — all 20 scenarios pass**

Run: `mvn -q compile exec:java -Dexec.mainClass=LabBugHunt`
Expected: exit 0; `20_bench_acc_alerts` OK; scenarios 03/15/19 (which used to rely on footer/alert text) still OK — 15 and 19 now find alert text in-tree via the name fallback. If 15/19 fail with missing text, the fallback (c) is wrong — fix it, do not weaken the scenario.

- [ ] **Step 6: Commit**

```bash
git add src/main/java/SnapshotCapture.java src/main/java/LabBugHunt.java
git commit -m "feat: alerts and validation as in-tree nodes; drop comment footer

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Diff classifier — alert lines are ordinary tree lines

**Files:**
- Modify: `src/main/java/SnapshotCapture.java:1795` (`diffLines`)
- Test: `src/test/java/SnapshotCaptureTest.java`

**Interfaces:**
- Consumes: `static String simpleDiff(String before, String after)` (package-visible, `SnapshotCapture.java:1701`).
- Produces: nothing new — behavior pin only.

- [ ] **Step 1: Write the failing test** (append to `SnapshotCaptureTest.java`):

```java
    @Test
    void alertTreeNodesDiffAsOrdinaryAddedLines() {
        String before = "- textbox \"Email\"";
        String after = "- textbox \"Email\" [invalid]\n- alert \"Email is required.\"";
        String out = SnapshotCapture.simpleDiff(before, after);
        assertTrue(out.contains("## Added"), out);
        assertTrue(out.contains("+ - alert \"Email is required.\""), out);
    }
```

- [ ] **Step 2: Run it**

Run: `mvn -q test -Dtest=SnapshotCaptureTest#alertTreeNodesDiffAsOrdinaryAddedLines`
Expected: PASS already (tree lines don't start with `#`) — this is a pin. If it fails, diagnose before proceeding.

- [ ] **Step 3: Remove the dead `# alert` special-case**

In `diffLines` (~line 1795) delete the line:

```java
                    || t.startsWith("# alert")
```

- [ ] **Step 4: Full unit run**

Run: `mvn -q test`
Expected: `Tests run: 21, Failures: 0, Errors: 0`.

- [ ] **Step 5: Commit**

```bash
git add src/main/java/SnapshotCapture.java src/test/java/SnapshotCaptureTest.java
git commit -m "test: pin alert nodes as ordinary diff lines; drop dead footer special-case

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: Walker — two-pass collision qualifiers

**Files:**
- Modify: `src/main/java/SnapshotCapture.java` (`CAPTURE_TREE_JS`: `emitNode`, `walkDocument`, `walkFrames`, hint label)
- Modify: `src/main/java/LabBugHunt.java` (new scenario)

**Interfaces:**
- Consumes: Task 2's `emitNode(el, depth, prefix, inAlert)`; Task 1's `bench-acc-copy-1/2`; existing `bench-dup-names` regions Alpha/Beta/Gamma.
- Produces: named nodes with `(role,name)` count > 1 gain `[…, in="<container>"]` or `[…, dup K/N]` as the LAST extra; colliding hint labels become `// <container> > <name>: …` or `// <name> (K/N): …`. `emitNode` signature: `(el, depth, prefix, inAlert, countOnly)`; `walkDocument(doc, depth, prefix, countOnly)`; `walkFrames(rootDoc, depth, pathPrefix, countOnly)`.

- [ ] **Step 1: Add failing scenarios**

```java
                new Scenario("21_bench_dup_qualifiers", "bench-dup-names", "Bench dup: ancestry qualifiers", null,
                        List.of("in=\"Region Alpha\"", "in=\"Region Beta\"", "in=\"Region Gamma\"")),
                new Scenario("22_bench_acc_dup_ordinal", "bench-accuracy", "Bench accuracy: ordinal fallback", null,
                        List.of("dup 1/2", "dup 2/2")),
```

**Why no hint-label assertion:** the home page's 27 menu tabs are all actionable with ids and fill the 24-hint cap before any panel content — `// Region Alpha > Save: …` can never appear in lab captures. The hint label is derived from the same `dupExtra`/`hintLabel` computation asserted via the tree, so tree assertions cover the logic; do NOT raise the cap to make it assertable (spec forbids cap changes).

Note for 22: the two `Copy link` buttons sit in plain divs inside the section `aria-label="Payment"`… **wait — they are NOT inside the Payment section** (they are siblings of it, in an anonymous `div.row`), so no named container exists → ordinal fallback. Do not move them into the section.

Also extend the missing-expected check to search `tree` OR the joined hints (needed for Task 5's `more hints truncated` assertion):

```java
                    String hintBlob = String.join("\n", hints);
                    for (String exp : sc.expect()) {
                        if (!tree.contains(exp) && !hintBlob.contains(exp)) {
                            findings.add(new Finding(sc.id(), "bug", "Missing expected: \"" + exp + "\""));
                        }
                    }
```

(replace the existing `for (String exp : sc.expect())` loop.)

- [ ] **Step 2: Run LabBugHunt — expect exit 2 with 21/22 failing, all others OK**

Run: `mvn -q compile exec:java -Dexec.mainClass=LabBugHunt`

- [ ] **Step 3: Implement the two-pass walker**

(a) State + helpers above `emitNode`:

```js
            const CONTAINER_ROLES = new Set(['region','form','dialog','alertdialog','navigation',
              'article','complementary','banner','contentinfo','main','tabpanel']);
            const nameCounts = new Map();      // 'role|name' -> total across capture
            const containersByKey = new Map(); // 'role|name' -> [containerName per node, DOM order]
            const seenCounts = new Map();      // pass 2: 'role|name' -> emitted so far
            const containerNameOf = (el) => {
              let node = el;
              while (node) {
                let parent = node.parentElement;
                if (!parent && node.getRootNode) {
                  const root = node.getRootNode();
                  parent = root && root.host ? root.host : null;
                }
                node = parent;
                if (!node || node.nodeType !== 1) return '';
                const r = node.getAttribute('role') || implicitRole(node);
                if (r && CONTAINER_ROLES.has(r)) {
                  const n = accessibleName(node);
                  if (n) return n;
                }
              }
              return '';
            };
```

(b) `emitNode(el, depth, prefix, inAlert, countOnly)` — after `name` is computed (Task 2 step 3c block), branch:

```js
              if (interesting && countOnly) {
                if (name) {
                  const key = role + '|' + name;
                  nameCounts.set(key, (nameCounts.get(key) || 0) + 1);
                  const arr = containersByKey.get(key) || [];
                  arr.push(containerNameOf(el));
                  containersByKey.set(key, arr);
                }
              } else if (interesting) {
                // …existing emission body…
              }
```

(c) Inside the emission body, compute the qualifier before building `extras` and append it as the LAST extra; derive the hint label pieces:

```js
                let dupExtra = null, hintLabel = name || role;
                if (name) {
                  const key = role + '|' + name;
                  const total = nameCounts.get(key) || 0;
                  if (total > 1) {
                    const k = seenCounts.get(key) || 0;
                    seenCounts.set(key, k + 1);
                    const arr = containersByKey.get(key) || [];
                    const myC = arr[k] || '';
                    const unique = myC && arr.filter(c => c === myC).length === 1;
                    if (unique) {
                      dupExtra = 'in="' + esc(myC) + '"';
                      hintLabel = myC + ' > ' + hintLabel;
                    } else {
                      dupExtra = 'dup ' + (k + 1) + '/' + total;
                      hintLabel = hintLabel + ' (' + (k + 1) + '/' + total + ')';
                    }
                  }
                }
```

then `if (dupExtra) extras.push(dupExtra);` after all existing `extras.push` calls (after the `if (prefix)` push), and in the locator-hints block replace `const label = name || role;` with `const label = hintLabel;`.

(d) Children recursion passes `countOnly` through; frame/document walkers gain the flag with every `lines.push` guarded by `if (!countOnly)`:

```js
            const walkDocument = (doc, depth, prefix, countOnly) => {
              if (!doc || !doc.body) return;
              emitNode(doc.body, depth, prefix, false, countOnly);
            };
```

`walkFrames(rootDoc, depth, pathPrefix, countOnly)` — same recursion, both `lines.push('- iframe …')` calls wrapped in `if (!countOnly)`.

(e) Main flow (replacing the current two calls):

```js
            walkDocument(document, 0, null, true);
            walkFrames(document, 0, null, true);
            walkDocument(document, 0, null, false);
            walkFrames(document, 0, null, false);
```

CRITICAL: pass 1 and pass 2 must traverse in IDENTICAL order (same code path) — the `seenCounts` index aligns positionally with `containersByKey` arrays.

- [ ] **Step 4: Unit tests + LabBugHunt**

Run: `mvn -q test` → 21 green. Then `mvn -q compile exec:java -Dexec.mainClass=LabBugHunt` → exit 0, 22 scenarios OK. Scenario 16 (`bench_dup_names`) must still pass — its expectations are substrings and unaffected.

- [ ] **Step 5: MultiTabBugHunt regression**

Run: `mvn -q compile exec:java -Dexec.mainClass=MultiTabBugHunt`
Expected: exit 0 (walker signature changes must not break it — it calls `CAPTURE_TREE_JS` the same way).

- [ ] **Step 6: Commit**

```bash
git add src/main/java/SnapshotCapture.java src/main/java/LabBugHunt.java
git commit -m "feat: two-pass walker; in=/dup qualifiers for duplicate names in tree and hints

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: Truncation markers

**Files:**
- Modify: `src/main/java/SnapshotCapture.java` (`CAPTURE_TREE_JS`: depth guard, hints slice, table rows marker)
- Modify: `src/main/java/LabBugHunt.java` (new scenario)

**Interfaces:**
- Consumes: Task 4's `emitNode(..., countOnly)`; Task 1's deep well; the lab menu's 27 tabs (already > 24 hints on every capture).
- Produces: `- … (subtree truncated at depth 30)` line; `// … N more hints truncated` final hint; `#   … N more rows (truncated)` wording.

- [ ] **Step 1: Add failing scenario**

```java
                new Scenario("23_bench_acc_truncation", "bench-accuracy", "Bench accuracy: truncation markers", null,
                        List.of("(subtree truncated at depth 30)", "more hints truncated")),
```

The hints marker is asserted via the hint-blob check added in Task 4. Also update scenario 12 (`table`) expected list: replace nothing (it asserts `headers:` only) — instead ADD to its list `"more rows (truncated)"` ONLY IF the static table has more than 5 rows; check `../test-site` table section first (`grep -n "tr" ../test-site/src/pages/HomePage.tsx` around the table markup). If it has ≤ 5 rows, leave scenario 12 alone and rely on the wording change being covered by unit-diff of the emitted string in step 3 verification.

- [ ] **Step 2: Run LabBugHunt — expect exit 2, scenario 23 failing only**

- [ ] **Step 3: Implement**

(a) Depth marker — in `emitNode`, remove the entry check `if (depth > 30) return;` and guard recursion parent-side:

```js
              const nextDepth = interesting ? depth + 1 : depth;
              if (nextDepth > 30) {
                if (!countOnly && kids.length) {
                  lines.push('  '.repeat(31) + '- … (subtree truncated at depth 30)');
                }
              } else {
                for (const child of kids) {
                  emitNode(child, nextDepth, prefix, inAlert || role === 'alert', countOnly);
                }
              }
```

(One marker per truncated parent branch; pass 1 also stops there, keeping both passes aligned.)

(b) Hints marker — replace `const hintsOut = hints.slice(0, 24).map(h => sweepSecrets(h));` with:

```js
            const hintsOut = hints.slice(0, 24).map(h => sweepSecrets(h));
            if (hints.length > 24) {
              hintsOut.push('// … ' + (hints.length - 24) + ' more hints truncated');
            }
```

(c) Table wording (~line 787): replace `lines.push('#   ... ' + (rows.length - maxTableRows) + ' more rows');` with:

```js
                  lines.push('#   … ' + (rows.length - maxTableRows) + ' more rows (truncated)');
```

- [ ] **Step 4: Unit tests + LabBugHunt + MultiTab**

Run: `mvn -q test` (21 green), `LabBugHunt` (exit 0, 23 scenarios), `MultiTabBugHunt` (exit 0).

- [ ] **Step 5: Commit**

```bash
git add src/main/java/SnapshotCapture.java src/main/java/LabBugHunt.java
git commit -m "feat: explicit truncation markers at every capture cap

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: Docs sync + final verification

**Files:**
- Modify: `Reading-Snapshots.md:20` (and scan whole file), `README.md` (scan for footer/alert wording)

**Interfaces:** none — documentation + full-suite gate.

- [ ] **Step 1: Update Reading-Snapshots.md**

Line 20 currently: `- Comment sections: full \`<select>\` options dump, table headers/rows, visible alerts.` → replace with:

```markdown
- Comment sections: full `<select>` options dump, table headers/rows.
- Alerts and validation are tree nodes: `- alert "message"` at their page position; field errors appear as `error:` / `validationMessage:` details under the field.
- Duplicate names carry a qualifier: `[in="Billing"]` (nearest named container) or `[dup 2/3]` (DOM-order ordinal). Hints mirror it: `// Billing > Save: …`.
- `…`/`truncated` markers mean content was cut at a cap — never assume unlisted rows/subtrees don't exist.
```

Scan the rest of the file and README.md for stale mentions of the alerts footer; fix any.

- [ ] **Step 2: Full gate**

Run all three, confirm outputs:

```bash
mvn -q test                                                  # 21 tests, 0 failures
mvn -q compile exec:java -Dexec.mainClass=LabBugHunt          # exit 0, 23 scenarios OK
mvn -q compile exec:java -Dexec.mainClass=MultiTabBugHunt     # exit 0
```

Also open one fresh `pageSnapshots/session-lab-bug-hunt-se-*/20_bench_acc_alerts.yaml` and eyeball: alert node present at correct indent under the Payment region, no footer, describedby `error:` present.

- [ ] **Step 3: Commit**

```bash
git add Reading-Snapshots.md README.md
git commit -m "docs: reading conventions for in-tree alerts, dup qualifiers, truncation markers

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```
