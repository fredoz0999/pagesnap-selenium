import org.openqa.selenium.Cookie;
import org.openqa.selenium.JavascriptExecutor;
import org.openqa.selenium.WebDriver;
import org.openqa.selenium.chrome.ChromeDriver;
import org.openqa.selenium.chrome.ChromeOptions;
import org.openqa.selenium.json.Json;

import java.io.FileDescriptor;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.PrintStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import java.time.ZoneId;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Properties;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;


/**
 * Interactive page snapshot capture for feeding LLMs (Claude Code, etc.)
 * when generating Selenium Java automated tests.
 *
 * Manual capture only - press Ctrl+K on each UI state you care about.
 *
 * Usage:
 *   mvn -q exec:java -Dexec.args="https://example.com"
 *   mvn -q exec:java -Dexec.args="https://example.com --load-cookies=cookies.json --goal=Login and transfer funds"
 */
public class SnapshotCapture {

    private static final String DEFAULT_TIMEZONE = "America/New_York";
    private static final DateTimeFormatter SESSION_TS_PATTERN =
            DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH-mm-ss");

    /**
     * Session folder timestamp, e.g. 2026-07-22T15-30-45.
     * Defaults to America/New_York; an unknown zone falls back to it.
     */
    static String sessionFolderTs(Instant instant, String timezone) {
        ZoneId zone;
        try {
            zone = ZoneId.of(timezone == null || timezone.isBlank() ? DEFAULT_TIMEZONE : timezone.trim());
        } catch (Exception e) {
            zone = ZoneId.of(DEFAULT_TIMEZONE);
        }
        return SESSION_TS_PATTERN.withZone(zone).format(instant);
    }
    private static final DateTimeFormatter ISO_TS = DateTimeFormatter.ISO_INSTANT;
    private static final Pattern EMAIL = Pattern.compile(
            "[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\\.[a-zA-Z]{2,}");

    /** How long to wait before re-checking whether another window has the user. */
    private static final long MIN_IDLE_SWEEP_MS = 1_500;
    /** Ceiling for that backoff while the browser sits in the background. */
    private static final long MAX_IDLE_SWEEP_MS = 30_000;

    /**
     * Toolbar, toast, hardened note/end UI, hotkeys. Loaded from classpath resource.
     * Primary trigger: on-page toolbar (same idea as pagesnap-playwright-legacy).
     * Hotkeys: Ctrl+K capture, Ctrl+Shift+K note, Ctrl+Q end (optional folder name).
     */
    private static final String INSTALL_UI_JS = loadResource("/snapshot-chrome.js");

    private static String loadResource(String name) {
        try (InputStream in = SnapshotCapture.class.getResourceAsStream(name)) {
            if (in == null) {
                throw new ExceptionInInitializerError("Missing classpath resource: " + name);
            }
            return new String(in.readAllBytes(), StandardCharsets.UTF_8);
        } catch (IOException e) {
            throw new ExceptionInInitializerError(e);
        }
    }

    /**
     * Builds a rich accessibility-oriented tree for AI / Selenium locator work.
     * Selenium wraps scripts as function bodies - must top-level return.
     * Options: arguments[0] = { maxTableRows, redactPasswords, redactEmails }
     */
    /** Package-visible for LabBugHunt automation (same tree builder as interactive capture). */
    static final String CAPTURE_TREE_JS = """
            const opts = arguments[0] || {};
            const maxTableRows = opts.maxTableRows || 5;
            const redactPasswords = opts.redactPasswords !== false;
            const redactEmails = opts.redactEmails !== false;

            const INTERESTING = new Set([
              'button', 'link', 'textbox', 'searchbox', 'combobox', 'listbox', 'option',
              'checkbox', 'radio', 'switch', 'tab', 'tablist', 'tabpanel',
              'menuitem', 'menu', 'menubar', 'dialog', 'alertdialog', 'alert',
              'heading', 'img', 'table', 'row', 'cell', 'columnheader', 'rowheader',
              'list', 'listitem', 'navigation', 'main', 'banner', 'contentinfo',
              'form', 'region', 'article', 'complementary', 'toolbar', 'progressbar',
              'slider', 'spinbutton', 'tree', 'treeitem', 'grid', 'gridcell',
              'generic'
            ]);

            // Visible data-test* nodes with no ARIA role (cart badge, href-less cart link)
            // are kept as `generic` so a test can reach them by their test id.
            const hasTestIdAttr = (el) => !!(el.getAttribute && (el.getAttribute('data-testid')
              || el.getAttribute('data-test') || el.getAttribute('data-test-id')
              || el.getAttribute('data-cy') || el.getAttribute('data-qa')));

            const esc = (s) => String(s == null ? '' : s)
              .replace(/\\\\/g, '\\\\\\\\')
              .replace(/"/g, '\\\\"')
              .replace(/\\n/g, ' ')
              .replace(/\\r/g, '');

            // Collect real password field values from every frame + open shadow root
            // so free-text (alerts, toast, names) can be swept too — not only input values.
            // Literal split/join (no regex) so hostile secrets cannot inject patterns.
            const MIN_SECRET_LEN = 4;
            const collectPasswordSecrets = () => {
              const secrets = new Set();
              const visit = (root) => {
                if (!root) return;
                try {
                  const stack = [root];
                  while (stack.length) {
                    const node = stack.pop();
                    const list = node.querySelectorAll
                      ? node.querySelectorAll('input[type="password"]')
                      : [];
                    for (const el of list) {
                      const v = el && el.value != null ? String(el.value) : '';
                      if (v.length >= MIN_SECRET_LEN) secrets.add(v);
                    }
                    if (node.querySelectorAll) {
                      for (const el of node.querySelectorAll('*')) {
                        if (el.shadowRoot) stack.push(el.shadowRoot);
                      }
                      for (const f of node.querySelectorAll('iframe, frame')) {
                        try {
                          if (f.contentDocument) stack.push(f.contentDocument);
                        } catch (e) { /* cross-origin */ }
                      }
                    }
                  }
                } catch (e) { /* ignore */ }
              };
              visit(document);
              return Array.from(secrets);
            };
            const passwordSecrets = redactPasswords ? collectPasswordSecrets() : [];

            const redactText = (s) => {
              if (s == null) return '';
              let t = String(s);
              if (redactPasswords && passwordSecrets.length) {
                for (const secret of passwordSecrets) {
                  if (secret.length < MIN_SECRET_LEN) continue;
                  t = t.split(secret).join('***');
                }
              }
              if (redactEmails) {
                t = t.replace(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\\.[a-zA-Z]{2,}/g, '***@***.***');
              }
              return t;
            };

            /** Final gate: sweep secrets through any string (tree + hints). */
            const sweepSecrets = (text) => {
              if (!text) return text;
              let t = String(text);
              if (redactPasswords && passwordSecrets.length) {
                for (const secret of passwordSecrets) {
                  if (secret.length < MIN_SECRET_LEN) continue;
                  t = t.split(secret).join('***');
                }
              }
              if (redactEmails) {
                t = t.replace(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\\.[a-zA-Z]{2,}/g, '***@***.***');
              }
              return t;
            };

            const implicitRole = (el) => {
              const tag = el.tagName.toLowerCase();
              const type = (el.getAttribute('type') || '').toLowerCase();
              if (tag === 'a' && (el.hasAttribute('href') || hasTestIdAttr(el))) return 'link';
              if (tag === 'button') return 'button';
              if (tag === 'input') {
                if (type === 'checkbox') return 'checkbox';
                if (type === 'radio') return 'radio';
                if (type === 'submit' || type === 'button' || type === 'reset' || type === 'image') return 'button';
                if (type === 'search') return 'searchbox';
                if (type === 'range') return 'slider';
                if (type === 'number') return 'spinbutton';
                if (type === 'hidden') return null;
                return 'textbox';
              }
              if (tag === 'textarea') return 'textbox';
              if (tag === 'select') return el.multiple ? 'listbox' : 'combobox';
              if (tag === 'option') return 'option';
              if (tag === 'progress') return 'progressbar';
              if (tag === 'meter') return 'meter';
              if (/^h[1-6]$/.test(tag)) return 'heading';
              if (tag === 'img') return 'img';
              if (tag === 'nav') return 'navigation';
              if (tag === 'main') return 'main';
              if (tag === 'header') return 'banner';
              if (tag === 'footer') return 'contentinfo';
              if (tag === 'form') return 'form';
              if (tag === 'table') return 'table';
              if (tag === 'tr') return 'row';
              if (tag === 'th') return el.scope === 'row' ? 'rowheader' : 'columnheader';
              if (tag === 'td') return 'cell';
              if (tag === 'ul' || tag === 'ol') return 'list';
              if (tag === 'li') return 'listitem';
              if (tag === 'dialog') return 'dialog';
              if (tag === 'section') {
                const sn = (el.getAttribute('aria-label') || '').trim() || el.getAttribute('aria-labelledby');
                return sn ? 'region' : null;
              }
              return null;
            };

            const accessibleName = (el) => {
              const aria = el.getAttribute('aria-label');
              if (aria && aria.trim()) return redactText(aria.trim());

              const labelledBy = el.getAttribute('aria-labelledby');
              if (labelledBy) {
                const text = labelledBy.split(/\\s+/)
                  .map(id => el.ownerDocument.getElementById(id))
                  .filter(Boolean)
                  .map(n => (n.innerText || n.textContent || '').trim())
                  .filter(Boolean)
                  .join(' ');
                if (text) return redactText(text);
              }

              if (el.tagName === 'IMG') {
                const alt = el.getAttribute('alt');
                if (alt != null) return redactText(alt.trim());
              }

              if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') {
                if (el.labels && el.labels.length) {
                  const lt = Array.from(el.labels).map(l => (l.innerText || '').trim()).filter(Boolean).join(' ');
                  if (lt) return redactText(lt);
                }
                const ph = el.getAttribute('placeholder');
                if (ph && ph.trim()) return redactText(ph.trim());
                const name = el.getAttribute('name');
                if (name && name.trim() && !isDynamicValue(name)) return name.trim();
                const id = el.getAttribute('id');
                if (id && id.trim() && !isDynamicValue(id)) return id.trim();
              }

              if (el.tagName === 'BUTTON' || el.tagName === 'A' || el.getAttribute('role') === 'button') {
                const t = (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim();
                if (t) return redactText(t.slice(0, 120));
              }

              // Native <option> and ARIA options (custom listboxes) - text content is the name
              if (
                el.tagName === 'OPTION' ||
                el.getAttribute('role') === 'option' ||
                el.getAttribute('role') === 'menuitem' ||
                el.getAttribute('role') === 'treeitem' ||
                el.getAttribute('role') === 'tab'
              ) {
                const t = (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim();
                if (t) return redactText(t.slice(0, 120));
              }

              if (/^H[1-6]$/.test(el.tagName)) {
                return redactText((el.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 120));
              }

              const title = el.getAttribute('title');
              if (title && title.trim()) return redactText(title.trim());
              return '';
            };

            const isVisible = (el) => {
              try {
                if (el.hidden || el.getAttribute('aria-hidden') === 'true') return false;
                const style = (el.ownerDocument.defaultView || window).getComputedStyle(el);
                if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
                const rect = el.getBoundingClientRect();
                return rect.width > 0 || rect.height > 0 || style.position === 'fixed';
              } catch (e) {
                return true;
              }
            };

            const cssEscape = (s) => {
              if (typeof CSS !== 'undefined' && CSS.escape) return CSS.escape(s);
              return String(s).replace(/([ !"#$%&'()*+,./:;<=>?@[\\\\\\]^`{|}~])/g, '\\\\$1');
            };

            const BS = String.fromCharCode(92);
            const attrSel = (attr, value) =>
              '[' + attr + '="' + String(value).split('"').join(BS + '"') + '"]';

            // Shadow-hosted elements are unique within their root, not the document.
            const scopeOf = (el) => {
              try {
                const root = el.getRootNode ? el.getRootNode() : null;
                if (root && typeof root.querySelectorAll === 'function' && root !== el.ownerDocument) {
                  return root;
                }
              } catch (e) { /* ignore */ }
              return el.ownerDocument;
            };

            // What a locator really finds, so nothing unverified is written down.
            const resolveLocator = (el, cand) => {
              const scope = scopeOf(el);
              const doc = el.ownerDocument;
              try {
                if (cand.by === 'xpath') {
                  const res = doc.evaluate(cand.value, doc, null, 7, null);
                  const out = [];
                  for (let i = 0; i < res.snapshotLength; i++) {
                    const n = res.snapshotItem(i);
                    if (n && n.nodeType === 1) out.push(n);
                  }
                  return out;
                }
                if (cand.by === 'linkText') {
                  return Array.from(scope.querySelectorAll('a')).filter(a =>
                    (a.innerText || a.textContent || '').replace(/\\s+/g, ' ').trim() === cand.value);
                }
                let sel = null;
                if (cand.by === 'id') sel = attrSel('id', cand.value);
                else if (cand.by === 'name') sel = attrSel('name', cand.value);
                else if (cand.by === 'css') sel = cand.value;
                if (!sel) return null;
                return Array.from(scope.querySelectorAll(sel));
              } catch (e) {
                return [];
              }
            };

            const isUniqueLocator = (el, cand) => {
              const found = resolveLocator(el, cand);
              return !!found && found.length === 1 && found[0] === el;
            };

            // Plain-CSS path from the nearest unique id: last resort so an element
            // with identical siblings still has one locator that works.
            const structuralPath = (el) => {
              const scope = scopeOf(el);
              const parts = [];
              let node = el;
              while (node && node.nodeType === 1 && parts.length < 8) {
                const id = node.getAttribute('id');
                if (id && !/^[0-9]/.test(id) && !isDynamicValue(id) && scope.querySelectorAll(attrSel('id', id)).length === 1) {
                  parts.unshift('#' + cssEscape(id));
                  return parts.join(' > ');
                }
                const parent = node.parentElement;
                let idx = 1;
                for (let sib = node.previousElementSibling; sib; sib = sib.previousElementSibling) idx++;
                parts.unshift(node.tagName.toLowerCase() + ':nth-child(' + idx + ')');
                if (!parent) break;
                node = parent;
              }
              return parts.length ? parts.join(' > ') : null;
            };

            // Narrow a locator that matched several elements (radio groups above all).
            const repairLocator = (el, cand) => {
              const nameAttr = el.getAttribute('name');
              const valueAttr = el.getAttribute('value');
              if (nameAttr && valueAttr != null && valueAttr !== '') {
                const narrowed = stampScore({
                  by: 'css',
                  value: el.tagName.toLowerCase() + attrSel('name', nameAttr) + attrSel('value', valueAttr),
                  stability: cand.stability
                });
                if (isUniqueLocator(el, narrowed)) return narrowed;
              }
              const path = structuralPath(el);
              if (path) {
                const structural = stampScore({ by: 'css', value: path, stability: 'low' });
                if (isUniqueLocator(el, structural)) return structural;
              }
              return null;
            };

            // Roles that need Selenium locators for test generation. Structural
            // roles (heading, list, banner, …) stay in the tree without locator
            // blocks — that alone removes most multi-locator bloat on chrome-heavy pages.
            const ACTIONABLE = new Set([
              'button', 'link', 'textbox', 'searchbox', 'combobox', 'listbox', 'option',
              'checkbox', 'radio', 'switch', 'tab', 'menuitem', 'slider', 'spinbutton',
              'form', 'generic'
            ]);

            // Token-lean multi-locator: keep the classic by/value/stability shape,
            // but emit at most two verified strategies and skip redundant twins
            // (id vs #id, name vs tag[name=…]).
            const MAX_LOCATORS = 2;

            // Numeric reliability score (higher is better), mapped to Selenium `by` values.
            // data-test* css 98, id 92, name 88, linkText 75, other css 45-70, xpath 40.
            // A non-unique locator (`matches`) is capped at 40 so the LLM never prefers it.
            const TESTID_CSS = /^\\[data-(testid|test|test-id|cy|qa)=/;
            const locatorScore = (loc) => {
              if (loc.matches != null) return 40;
              if (loc.by === 'css' && TESTID_CSS.test(loc.value)) return 98;
              if (loc.by === 'id') return 92;
              if (loc.by === 'name') return 88;
              if (loc.by === 'linkText') return 75;
              if (loc.by === 'css') return loc.stability === 'low' ? 45 : loc.stability === 'medium' ? 65 : 85;
              if (loc.by === 'xpath' && loc.stability === 'medium') return 60;
              return 40;
            };
            // A value that changes between runs (generated ids, counters, hashed class names) is never a
            // valid locator, whatever attribute it sits in. Mirrored in pack/src/dynamic.ts (parity-tested).
            const isDynamicValue = (v) => {
              const t = String(v == null ? '' : v);
              if (!t) return false;
              if (/[0-9A-HJKMNP-TV-Z]{26}/.test(t)) return true;                       // ULID
              if (/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}/.test(t)) return true; // UUID
              if (/(?=[0-9a-f]*\\d)[0-9a-f]{12,}/i.test(t)) return true;                 // long hex / hash
              if (/\\d{3,}/.test(t)) return true;                                       // 3+ digit run: counters, timestamps, row ids
              if (/^(mat|ng|ember|react|rc|ui|mui|radix|headlessui|downshift|select2|gwt|yui|ext)[-_a-z]*\\d+/i.test(t)) return true; // framework counters
              if (/^:r[0-9a-z]*:$/.test(t) || /\u00ab[a-z0-9]+\u00bb/.test(t)) return true;  // React useId
              if (/^(css|sc|jss|emotion|styled)-[a-z0-9]{5,}$/i.test(t)) return true;        // CSS-in-JS classes
              if (/_[A-Za-z]+__[A-Za-z0-9_-]{5}$/.test(t)) return true;                       // CSS-modules localIdent
              const flat = t.replace(/[-_.:\\s]/g, '');
              if (flat.length >= 8 && /\\d/.test(flat) && /[a-z]/i.test(flat) && /^[a-z0-9]+$/i.test(flat)) {
                let flips = 0;
                for (let i = 1; i < flat.length; i++) if (/\\d/.test(flat[i]) !== /\\d/.test(flat[i - 1])) flips++;
                if (flips >= 4) return true;                                                // random-looking token
              }
              return false;
            };
            const locatorHasDynamic = (loc) => {
              if (loc.by === 'id' || loc.by === 'name') return isDynamicValue(loc.value);
              if (loc.by === 'linkText') return false; // visible text is user-facing, not generated
              const parts = [];
              String(loc.value).replace(/"([^"]*)"/g, (m, g) => { parts.push(g); return m; });
              String(loc.value).replace(/[#.]([A-Za-z_][-\\w]*)/g, (m, g) => { parts.push(g); return m; });
              return parts.some(isDynamicValue);
            };
            const stampScore = (loc) => {
              if (loc.by !== 'linkText' && locatorHasDynamic(loc)) { loc.stability = 'low'; loc.dynamic = true; }
              loc.score = locatorScore(loc);
              if (loc.dynamic && loc.matches == null) loc.score = Math.min(loc.score, 20);
              return loc;
            };

            const buildLocators = (el) => {
              const locators = [];
              let hasId = false;
              let hasName = false;
              let hasTestId = false;
              const push = (by, value, stability) => {
                if (value == null || String(value).trim() === '') return;
                locators.push(stampScore({ by: by, value: String(value), stability: stability }));
              };

              // Stable prefix of a generated value ("category-01M5..." -> "category-"): only kept if it is unique.
              const prefixCands = [];
              const stablePrefix = (v) => {
                const m = String(v).match(/^([A-Za-z][A-Za-z_-]*[-_])/);
                return m && m[1].length >= 4 && !isDynamicValue(m[1]) ? m[1] : null;
              };
              const testId = el.getAttribute('data-testid') || el.getAttribute('data-test')
                || el.getAttribute('data-test-id') || el.getAttribute('data-cy')
                || el.getAttribute('data-qa');
              if (testId && isDynamicValue(testId)) {
                const attr0 = el.hasAttribute('data-testid') ? 'data-testid'
                  : el.hasAttribute('data-test') ? 'data-test'
                  : el.hasAttribute('data-test-id') ? 'data-test-id'
                  : el.hasAttribute('data-cy') ? 'data-cy' : 'data-qa';
                const pf = stablePrefix(testId);
                if (pf) prefixCands.push('[' + attr0 + '^="' + pf + '"]');
              } else if (testId) {
                const attr = el.hasAttribute('data-testid') ? 'data-testid'
                  : el.hasAttribute('data-test') ? 'data-test'
                  : el.hasAttribute('data-test-id') ? 'data-test-id'
                  : el.hasAttribute('data-cy') ? 'data-cy' : 'data-qa';
                push('css', '[' + attr + '="' + testId.replace(/"/g, '\\\\"') + '"]', 'high');
                hasTestId = true;
              }

              const id = el.getAttribute('id');
              if (id && isDynamicValue(id)) {
                const pf = stablePrefix(id);
                if (pf) prefixCands.push('[id^="' + pf + '"]');
              } else if (id && !/^[0-9]/.test(id) && id.length < 80) {
                push('id', id, 'high');
                hasId = true;
                // Do NOT also emit css #id — By.id is the Selenium-native twin.
              }

              const name = el.getAttribute('name');
              if (name && !isDynamicValue(name)) {
                push('name', name, 'high');
                hasName = true;
                // Skip tag[name=…] css twin of By.name unless we have no id/testId.
                if (!hasId && !hasTestId) {
                  push('css', el.tagName.toLowerCase() + '[name="' + name.replace(/"/g, '\\\\"') + '"]', 'medium');
                }
              }

              const aria = el.getAttribute('aria-label');
              if (aria && aria.trim() && !isDynamicValue(aria) && !hasId && !hasTestId) {
                push('css', '[aria-label="' + aria.trim().replace(/"/g, '\\\\"') + '"]', 'medium');
              }

              const type = (el.getAttribute('type') || '').toLowerCase();
              if (el.tagName === 'INPUT' && type === 'submit' && el.value && !hasId && !hasTestId) {
                push('css', 'input[type="submit"][value="' + String(el.value).replace(/"/g, '\\\\"') + '"]', 'medium');
              }

              if (el.tagName === 'A') {
                let href = el.getAttribute('href');
                if (href && !href.startsWith('javascript:')) {
                  href = href.replace(/;jsessionid=[^?#]*/i, '');
                  if (href.length < 120) {
                    // *= is more stable when servers rewrite session ids into paths
                    const bare = href.split('?')[0].split('#')[0];
                    if (bare && !isDynamicValue(bare)) push('css', 'a[href*="' + bare.replace(/"/g, '\\\\"') + '"]', 'medium');
                  }
                }
                // Prefer href css over linkText when both exist; keep linkText only as
                // backup when no high id/testId.
                if (!hasId && !hasTestId) {
                  const linkName = accessibleName(el);
                  if (linkName && linkName.length < 60) {
                    push('linkText', linkName, 'medium');
                  }
                }
              }

              // Text/xpath buttons: only if we lack a strong id/name/testId.
              if (!hasId && !hasName && !hasTestId) {
                if (el.tagName === 'BUTTON' || (el.tagName === 'INPUT' && /^(submit|button|reset)$/i.test(type))) {
                  const btnName = accessibleName(el) || (el.value || '');
                  if (btnName && btnName.length < 60) {
                    push('xpath',
                      '//button[normalize-space()="' + btnName.replace(/"/g, '') + '"] | //input[@type="'
                        + (type || 'button') + '" and @value="' + btnName.replace(/"/g, '') + '"]',
                      'medium');
                  }
                }
                // Last-resort role+name xpath — expensive tokens; only when nothing better.
                const role = el.getAttribute('role') || implicitRole(el);
                const aname = accessibleName(el);
                if (role && aname && aname.length < 60 && locators.length === 0) {
                  push('xpath',
                    '//*[@role="' + role + '" or self::' + el.tagName.toLowerCase() + '][contains(normalize-space(.), "'
                      + aname.replace(/"/g, '') + '")]',
                    'low');
                }
              }

              // Stable-text fallbacks for form controls whose id/name/test id is missing or generated.
              if (!hasId && !hasTestId && /^(INPUT|SELECT|TEXTAREA)$/.test(el.tagName)) {
                const ph = el.getAttribute('placeholder');
                if (ph && ph.trim() && !isDynamicValue(ph)) {
                  push('css', el.tagName.toLowerCase() + '[placeholder="' + ph.trim().replace(/"/g, '\\\\"') + '"]', 'medium');
                }
                const lbl = el.labels && el.labels.length ? (el.labels[0].innerText || '').replace(/\\s+/g, ' ').trim() : '';
                if (lbl && lbl.length < 60 && lbl.indexOf('"') < 0) {
                  const tag = el.tagName.toLowerCase();
                  const wrapped = el.labels[0].contains(el);
                  push('xpath', '//label[normalize-space()="' + lbl + '"]' + (wrapped ? '//' + tag : '/following::' + tag + '[1]'), 'medium');
                }
              }
              for (const pc of prefixCands) push('css', pc, 'low'); // unique today, but any new sibling with the prefix breaks it

              // de-dupe by by+value
              const seen = new Set();
              const candidates = locators.filter(l => {
                const k = l.by + '|' + l.value;
                if (seen.has(k)) return false;
                seen.add(k);
                return true;
              });

              // Verify each candidate against the live page: a locator that does not
              // resolve to this element is a lie the test author cannot detect, and
              // Selenium silently takes the first match when one is ambiguous.
              const verified = [];
              const ambiguous = [];
              for (const cand of candidates) {
                const found = resolveLocator(el, cand);
                if (!found) continue;
                if (found.length === 1 && found[0] === el) {
                  verified.push(cand);
                  continue;
                }
                if (prefixCands.indexOf(cand.value) >= 0) continue; // a non-unique prefix is noise, not a locator
                if (found.length > 1 && found.indexOf(el) >= 0) {
                  const narrowed = repairLocator(el, cand);
                  if (narrowed && !verified.some(v => v.by === narrowed.by && v.value === narrowed.value)) {
                    verified.push(narrowed);
                  } else if (ambiguous.length < 1) {
                    ambiguous.push(stampScore({ by: cand.by, value: cand.value, stability: cand.stability, matches: found.length }));
                  }
                }
              }

              if (!verified.length) {
                const path = structuralPath(el);
                if (path) {
                  const structural = stampScore({ by: 'css', value: path, stability: 'low' });
                  if (isUniqueLocator(el, structural)) verified.push(structural);
                }
              }

              // Drop redundant css twins of id/name that survived repair paths.
              const cleaned = verified.filter(l => {
                if (l.by === 'css' && l.value.charAt(0) === '#' && verified.some(v => v.by === 'id' && ('#' + cssEscape(v.value)) === l.value)) {
                  return false;
                }
                if (l.by === 'css' && /\\[name=/.test(l.value) && verified.some(v => v.by === 'name')) {
                  return false;
                }
                return true;
              });

              // A locator built on a generated value is dropped whenever any stable one exists.
              if (cleaned.some(l => !l.dynamic)) {
                for (let i = cleaned.length - 1; i >= 0; i--) if (cleaned[i].dynamic) cleaned.splice(i, 1);
              }

              // Rank by numeric score (best first); ties fall back to `by` for stable output.
              cleaned.sort((a, b) => (b.score - a.score) || a.by.localeCompare(b.by));

              // Prefer diverse strategies (id + name, not id + id).
              const picked = [];
              const bySeen = new Set();
              for (const l of cleaned) {
                if (picked.length >= MAX_LOCATORS) break;
                // Allow second locator only if different `by` strategy.
                if (bySeen.has(l.by) && picked.length > 0) continue;
                picked.push(l);
                bySeen.add(l.by);
              }
              // If we only got one unique strategy but more cleaned exist with same by, still max 1 of that by.

              // Ambiguous fallback only when nothing unique verified.
              if (!picked.length && ambiguous.length) {
                return ambiguous.slice(0, 1);
              }
              return picked;
            };

            const readValue = (el) => {
              const tag = el.tagName;
              const type = (el.getAttribute('type') || '').toLowerCase();
              if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
                if (redactPasswords && type === 'password') return '***';
                let v = el.value != null ? String(el.value) : '';
                if (v.length > 80) v = v.slice(0, 80) + '…';
                return redactText(v);
              }
              return null;
            };

            const lines = [];
            const hints = [];

            const BANNER_SELECTOR = '.error, .errors, .alert-error, .validation-error, .has-error';
            const collapsedText = (el) => (el.innerText || '').replace(/\\s+/g, ' ').trim();
            const capAlertText = (t) => t.length > 300 ? t.slice(0, 300) + '…' : t;

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

            const emitNode = (el, depth, prefix, inAlert, countOnly) => {
              if (!el || el.nodeType !== 1) return;
              if (['SCRIPT', 'STYLE', 'NOSCRIPT', 'PATH'].includes(el.tagName)) return;
              // Never include injected toolbar / toast / note UI
              if (el.hasAttribute && el.hasAttribute('data-snapshot-tool')) return;
              if (el.closest && el.closest('[data-snapshot-tool]')) return;

              let role = el.getAttribute('role') || implicitRole(el);
              // Role-less error banners become real alert nodes at their DOM position
              if (!role && !inAlert && el.matches && el.matches(BANNER_SELECTOR) && isVisible(el)) {
                if (collapsedText(el)) { role = 'alert'; }
              }
              if (!role && hasTestIdAttr(el) && isVisible(el)) role = 'generic';
              const interesting = role && INTERESTING.has(role) && isVisible(el);

              if (interesting) {
                let name = accessibleName(el);
                // role=alert text is the alert; without this the text is invisible in-tree
                if (role === 'alert' && !name) {
                  name = capAlertText(redactText(collapsedText(el)));
                }

                if (countOnly) {
                if (name) {
                  const key = role + '|' + name;
                  nameCounts.set(key, (nameCounts.get(key) || 0) + 1);
                  const arr = containersByKey.get(key) || [];
                  arr.push(containerNameOf(el));
                  containersByKey.set(key, arr);
                }
                } else {
                let line = '  '.repeat(depth) + '- ' + role;
                if (name) line += ' "' + esc(name) + '"';

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

                const extras = [];
                if (role === 'heading') {
                  const level = el.getAttribute('aria-level') || (el.tagName.match(/^H(\\d)$/) || [])[1];
                  if (level) extras.push('level=' + level);
                }
                if (el.disabled || el.getAttribute('aria-disabled') === 'true') extras.push('disabled');
                if (el.readOnly || el.getAttribute('aria-readonly') === 'true') extras.push('readonly');
                if (el.required || el.getAttribute('aria-required') === 'true') extras.push('required');
                if (el.checked || el.getAttribute('aria-checked') === 'true') extras.push('checked');
                if (el.selected || el.getAttribute('aria-selected') === 'true') extras.push('selected');
                if (el.getAttribute('aria-expanded') === 'true') extras.push('expanded');
                if (el.getAttribute('aria-expanded') === 'false') extras.push('collapsed');
                if (el.getAttribute('aria-invalid') === 'true') extras.push('invalid');
                if (el.getAttribute('aria-current')) extras.push('current');
                if (prefix) extras.push(prefix);
                if (dupExtra) extras.push(dupExtra);
                if (extras.length) line += ' [' + extras.join(', ') + ']';

                const roleForLoc = role;
                const locators = ACTIONABLE.has(roleForLoc) ? buildLocators(el) : [];
                const value = readValue(el);
                // Native <select> options exist in DOM even when the list is closed
                const isNativeSelect = el.tagName === 'SELECT';
                const nativeOptions = isNativeSelect ? Array.from(el.options || []) : [];
                const hasDetails = locators.length > 0 || value != null
                  || el.getAttribute('aria-errormessage') || el.validationMessage
                  || nativeOptions.length > 0
                  || el.getAttribute('aria-expanded') != null
                  || (el.getAttribute('aria-invalid') === 'true' && el.getAttribute('aria-describedby'));

                if (hasDetails) {
                  line += ':';
                  lines.push(line);
                  const ind = '  '.repeat(depth + 1);
                  if (value != null) lines.push(ind + 'value: "' + esc(value) + '"');
                  if (el.getAttribute('aria-expanded') === 'true') {
                    lines.push(ind + 'dropdown: open');
                  } else if (el.getAttribute('aria-expanded') === 'false') {
                    lines.push(ind + 'dropdown: closed');
                  }
                  try {
                    if (el.validationMessage) {
                      lines.push(ind + 'validationMessage: "' + esc(redactText(el.validationMessage)) + '"');
                    }
                  } catch (e) { /* ignore */ }
                  const errId = el.getAttribute('aria-errormessage');
                  if (errId) {
                    const errEl = el.ownerDocument.getElementById(errId);
                    if (errEl) {
                      const et = (errEl.innerText || '').replace(/\\s+/g, ' ').trim();
                      if (et) lines.push(ind + 'error: "' + esc(redactText(et)) + '"');
                    }
                  }
                  if (el.getAttribute('aria-invalid') === 'true' && !el.getAttribute('aria-errormessage')) {
                    const dids = (el.getAttribute('aria-describedby') || '').trim().split(/\\s+/).filter(Boolean);
                    for (const did of dids) {
                      const dEl = el.ownerDocument.getElementById(did);
                      const dt = dEl ? (dEl.innerText || '').replace(/\\s+/g, ' ').trim() : '';
                      if (dt) { lines.push(ind + 'error: "' + esc(redactText(dt)) + '"'); break; }
                    }
                  }
                  if (locators.length) {
                    lines.push(ind + 'locators:');
                    for (const l of locators) {
                      lines.push(ind + '  - {by: ' + l.by + ', value: "' + esc(l.value)
                        + '", stability: ' + l.stability
                        + ', score: ' + (l.score != null ? l.score : locatorScore(l))
                        + (l.matches != null ? ', matches: ' + l.matches : '') + '}');
                    }
                    // Selenium hint from a locator verified unique, never an ambiguous one
                    const best = locators.filter(l => l.matches == null)[0];
                    const label = hintLabel;
                    if (!best) {
                      /* no verified locator for this element */
                    } else if (best.by === 'id') {
                      hints.push('// ' + label + ': driver.findElement(By.id("' + best.value.replace(/"/g, '\\\\"') + '"))');
                    } else if (best.by === 'name') {
                      hints.push('// ' + label + ': driver.findElement(By.name("' + best.value.replace(/"/g, '\\\\"') + '"))');
                    } else if (best.by === 'css') {
                      hints.push('// ' + label + ': driver.findElement(By.cssSelector("' + best.value.replace(/"/g, '\\\\"') + '"))');
                    } else if (best.by === 'linkText') {
                      hints.push('// ' + label + ': driver.findElement(By.linkText("' + best.value.replace(/"/g, '\\\\"') + '"))');
                    } else if (best.by === 'xpath') {
                      hints.push('// ' + label + ': driver.findElement(By.xpath("' + best.value.replace(/"/g, '\\\\"') + '"))');
                    }
                  }
                  // Inline native <select> options so one snapshot is enough for closed lists
                  if (nativeOptions.length) {
                    lines.push(ind + 'options:  # native <select> - available without opening UI');
                    for (const opt of nativeOptions) {
                      const flags = [];
                      if (opt.disabled) flags.push('disabled');
                      if (opt.selected) flags.push('selected');
                      const suffix = flags.length ? ' [' + flags.join(', ') + ']' : '';
                      lines.push(ind + '  - option "' + esc(redactText((opt.text || '').trim())) + '"' + suffix);
                    }
                  }
                } else {
                  lines.push(line);
                }
                }
              }

              // children: light DOM + open shadow root
              const kids = [];
              if (el.shadowRoot) {
                for (const c of el.shadowRoot.children) kids.push(c);
              }
              for (const c of el.children) kids.push(c);
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
            };

            const walkDocument = (doc, depth, prefix, countOnly) => {
              if (!doc || !doc.body) return;
              emitNode(doc.body, depth, prefix, false, countOnly);
            };

            // same-origin iframes (recursive: outer → nested inner, any depth)
            // Parent document only lists direct-document iframes; nested frames live
            // inside the outer frame's contentDocument, so we recurse per frame doc.
            const walkFrames = (rootDoc, depth, pathPrefix, countOnly) => {
              if (!rootDoc) return;
              let frames;
              try {
                frames = Array.from(rootDoc.querySelectorAll('iframe, frame'));
              } catch (e) {
                return;
              }
              frames.forEach((frame, i) => {
                const fname = frame.getAttribute('name') || frame.getAttribute('id') || ('frame-' + i);
                const framePath = pathPrefix ? (pathPrefix + '/' + fname) : fname;
                const ind = '  '.repeat(Math.max(0, depth));
                try {
                  const doc = frame.contentDocument;
                  if (!doc) {
                    if (!countOnly) lines.push(ind + '- iframe "' + esc(fname) + '" [cross-origin or empty]');
                    return;
                  }
                  if (!countOnly) lines.push(ind + '- iframe "' + esc(fname) + '":');
                  walkDocument(doc, depth + 1, 'in-iframe=' + framePath, countOnly);
                  // Nested iframes inside this frame document
                  walkFrames(doc, depth + 1, framePath, countOnly);
                } catch (e) {
                  if (!countOnly) lines.push(ind + '- iframe "' + esc(fname) + '" [cross-origin]');
                }
              });
            };

            walkDocument(document, 0, null, true);
            walkFrames(document, 0, null, true);
            walkDocument(document, 0, null, false);
            walkFrames(document, 0, null, false);

            // <select> full options
            const allSelects = [];
            const collectSelects = (doc) => {
              if (!doc) return;
              try {
                doc.querySelectorAll('select').forEach(s => allSelects.push(s));
                doc.querySelectorAll('iframe, frame').forEach(f => {
                  try { if (f.contentDocument) collectSelects(f.contentDocument); } catch (e) {}
                });
              } catch (e) {}
            };
            collectSelects(document);
            if (allSelects.length) {
              lines.push('');
              lines.push('# --- All <select> options ---');
              for (const sel of allSelects) {
                const label = sel.id || sel.name || accessibleName(sel) || 'unnamed';
                lines.push('# <select> "' + esc(label) + '":');
                for (const opt of Array.from(sel.options)) {
                  const flags = [];
                  if (opt.disabled) flags.push('disabled');
                  if (opt.selected) flags.push('selected');
                  const suffix = flags.length ? ' (' + flags.join(', ') + ')' : '';
                  lines.push('#   - ' + redactText((opt.text || '').trim()) + suffix);
                }
              }
            }

            // tables: headers + first N data rows
            const tables = Array.from(document.querySelectorAll('table')).filter(isVisible);
            if (tables.length) {
              lines.push('');
              lines.push('# --- Tables (headers + first rows) ---');
              tables.forEach((table, ti) => {
                const caption = table.querySelector('caption');
                const tname = (caption && caption.innerText.trim()) || table.getAttribute('aria-label')
                  || table.id || ('table-' + ti);
                lines.push('# table "' + esc(redactText(tname)) + '":');
                const headers = Array.from(table.querySelectorAll('thead th, tr th')).map(th =>
                  (th.innerText || '').replace(/\\s+/g, ' ').trim()).filter(Boolean);
                if (headers.length) {
                  lines.push('#   headers: ' + headers.map(h => redactText(h)).join(' | '));
                }
                const bodyRows = Array.from(table.querySelectorAll('tbody tr'));
                const rows = bodyRows.length ? bodyRows : Array.from(table.querySelectorAll('tr')).filter(tr => !tr.querySelector('th'));
                rows.slice(0, maxTableRows).forEach((tr, ri) => {
                  const cells = Array.from(tr.querySelectorAll('td, th')).map(c =>
                    redactText((c.innerText || '').replace(/\\s+/g, ' ').trim()));
                  lines.push('#   row ' + (ri + 1) + ': ' + cells.join(' | '));
                });
                if (rows.length > maxTableRows) {
                  lines.push('#   … ' + (rows.length - maxTableRows) + ' more rows (truncated)');
                }
              });
            }

            // Final secret sweep on full tree + hints (catches free-text leaks in
            // alerts, toasts, names — field values already mask type=password)
            const treeOut = sweepSecrets(lines.join('\\n'));
            // Fewer hints: one per actionable, already high-stability first; cap list.
            const hintsOut = hints.slice(0, 24).map(h => sweepSecrets(h));
            if (hints.length > 24) {
              hintsOut.push('// … ' + (hints.length - 24) + ' more hints truncated');
            }

            return {
              tree: treeOut,
              hints: hintsOut
            };
            """;

    private static final String WAIT_READY_JS = """
            const stable = arguments[0];
            const max = arguments[1];
            const callback = arguments[arguments.length - 1];
            const start = Date.now();
            const finish = () => { try { observer.disconnect(); } catch (e) {} callback(); };

            const maxTimer = setTimeout(finish, max);
            let timer;
            const bump = () => {
              clearTimeout(timer);
              timer = setTimeout(() => {
                if (document.readyState === 'complete' || document.readyState === 'interactive') {
                  clearTimeout(maxTimer);
                  finish();
                } else {
                  bump();
                }
              }, stable);
            };
            const observer = new MutationObserver(bump);
            if (document.body) {
              observer.observe(document.body, { childList: true, subtree: true, attributes: true });
            }
            if (document.readyState === 'complete') {
              bump();
            } else {
              window.addEventListener('load', bump, { once: true });
              bump();
            }
            """;

    // --- runtime config ---
    private Path outputRoot = Path.of("pageSnapshots");
    private Path sessionDir;
    private boolean sessionSubdir = true;
    private boolean includeHints = true;
    private boolean redactPasswords = true;
    private boolean redactEmails = true;
    private boolean writeDiff = true;
    int maxTableRows = 5;
    private String framework = "junit5";
    private String style = "pageobject";
    private String waits = "explicit";
    String goal = "";
    private String loadCookiesPath;
    private String saveCookiesPath;
    /** Absolute path to chromedriver executable; null = Selenium Manager default. */
    private String chromeDriverPath;
    /** Toolbar dock: left | middle | right (default right). */
    private String toolbarPosition = "right";
    /** IANA zone used for session folder timestamps. */
    String timezone = DEFAULT_TIMEZONE;
    private int step = 0;
    private String lastTreeBody = "";
    private String lastCaptureUrl = "";
    private String sessionStartUrl = "";
    private final List<StepRecord> steps = new ArrayList<>();
    private final Set<String> knownWindowHandles = new java.util.LinkedHashSet<>();

    private record StepRecord(int n, String file, String url, String note, String capturedAt) {}

    public static void main(String[] args) throws Exception {
        useUtf8Console();
        new SnapshotCapture().run(args);
    }

    /**
     * Windows consoles default to a legacy code page, so anything outside it -
     * an accented character in a note or session name - reaches the terminal as
     * '?'. Writing UTF-8 keeps redirected output and UTF-8 terminals correct;
     * the tool's own messages are ASCII so they render everywhere regardless.
     */
    static void useUtf8Console() {
        try {
            System.setOut(new PrintStream(new FileOutputStream(FileDescriptor.out), true, StandardCharsets.UTF_8));
            System.setErr(new PrintStream(new FileOutputStream(FileDescriptor.err), true, StandardCharsets.UTF_8));
        } catch (Exception ignored) {
            // keep the default streams
        }
    }

    private void run(String[] args) throws Exception {
        if (args.length == 0 || args[0].isBlank() || args[0].startsWith("--")) {
            printUsage();
            System.exit(1);
        }

        loadConfigFile(Path.of("capture.config.properties"));
        String startUrl = parseArgs(args);
        sessionStartUrl = startUrl;

        // Keep prior sessions; each run gets a new timestamped folder
        Instant sessionStart = Instant.now();
        String sessionId = "session-" + sessionFolderTs(sessionStart, timezone);
        Files.createDirectories(outputRoot);
        if (sessionSubdir) {
            sessionDir = outputRoot.resolve(sessionId);
        } else {
            sessionDir = outputRoot;
        }
        Files.createDirectories(sessionDir);

        writePromptPack(sessionStart);

        System.out.println("Launching Chrome (Selenium)...");
        System.out.println("Session dir: " + sessionDir.toAbsolutePath());
        System.out.println("Controls (PRIMARY = on-page toolbar):");
        System.out.println("  Toolbar dock: " + toolbarPosition + " (click L/M/R on panel to cycle)");
        System.out.println("  Toolbar buttons: Capture | Note | End (optional folder name on End)");
        System.out.println("  Ctrl+K / Cmd+K             - capture snapshot");
        System.out.println("  Ctrl+Shift+K / Cmd+Shift+K - capture with note");
        System.out.println("  Ctrl+Q / Cmd+Q             - end session (optional folder name)");
        System.out.println("  Multi-tab: new tabs are detected; capture uses the tab that signaled");
        System.out.println("  Toast (Saved snapshot #N) appears top-right");
        System.out.println();
        System.out.println("Sessions use America/New_York time; prior session folders are kept.");
        System.out.println("No auto-capture on navigation. Capture is manual only.");
        if (goal != null && !goal.isBlank()) {
            System.out.println("Goal: " + goal);
        }
        System.out.println();

        configureChromeDriver();
        ChromeOptions options = new ChromeOptions();
        WebDriver driver = new ChromeDriver(options);
        JavascriptExecutor js = (JavascriptExecutor) driver;

        int captureCount = 0;
        try {
            driver.get(startUrl);
            if (loadCookiesPath != null) {
                // Cookies can only be set while on the domain, so loadCookies parks
                // the browser on the origin. Go back to the URL that was asked for
                // instead of merely refreshing the origin.
                loadCookies(driver, Path.of(loadCookiesPath), startUrl);
                driver.get(startUrl);
            }
            knownWindowHandles.clear();
            knownWindowHandles.add(driver.getWindowHandle());
            injectUi(driver, js);

            long nextIdleSweepMs = 0;
            long idleSweepBackoffMs = MIN_IDLE_SWEEP_MS;

            while (true) {
                try {
                    Set<String> handles = driver.getWindowHandles();
                    if (handles == null || handles.isEmpty()) {
                        System.out.println("\nBrowser closed (no windows).");
                        break;
                    }

                    // Detect new / closed tabs. A new tab is the one Chrome just put
                    // in front of the user, so following it here is also what keeps
                    // the poll on the tab they are looking at.
                    for (String h : handles) {
                        if (!knownWindowHandles.contains(h)) {
                            knownWindowHandles.add(h);
                            System.out.println("[new tab] handle=" + shortHandle(h));
                            try {
                                driver.switchTo().window(h);
                                injectUi(driver, (JavascriptExecutor) driver);
                            } catch (Exception e) {
                                System.err.println("  Could not init new tab: " + e.getMessage());
                            }
                        }
                    }
                    knownWindowHandles.retainAll(handles);

                    // Ensure current handle is still valid
                    String current;
                    try {
                        current = driver.getWindowHandle();
                        if (!handles.contains(current)) {
                            current = handles.iterator().next();
                            driver.switchTo().window(current);
                        }
                    } catch (Exception e) {
                        current = handles.iterator().next();
                        driver.switchTo().window(current);
                    }

                    // Poll ONLY the tab we are on. switchTo() activates a tab, so
                    // sweeping every handle each tick made the browser strobe between
                    // tabs (~10 visibilitychange events per second per tab).
                    js = (JavascriptExecutor) driver;
                    Map<String, Object> state = readTabState(js);

                    if (Boolean.TRUE.equals(state.get("needsInject"))) {
                        injectUi(driver, js);
                    }

                    if (Boolean.TRUE.equals(state.get("end"))) {
                        Object nameObj = state.get("name");
                        applySessionFolderName(nameObj != null ? nameObj.toString() : "");
                        System.out.println("\nSession ended (toolbar / Ctrl+Q)");
                        break;
                    }

                    if (Boolean.TRUE.equals(state.get("capture"))) {
                        Object noteObj = state.get("note");
                        String captureNote = noteObj != null ? noteObj.toString() : "";
                        System.out.println("[manual] Capturing snapshot on tab "
                                + shortHandle(current)
                                + (captureNote.isBlank() ? "" : " note=\"" + captureNote + "\""));
                        if (saveSnapshot(driver, js, captureNote)) {
                            captureCount++;
                        }
                        nextIdleSweepMs = 0;
                        idleSweepBackoffMs = MIN_IDLE_SWEEP_MS;
                    } else if (handles.size() > 1) {
                        boolean visible = Boolean.TRUE.equals(state.get("visible"));
                        boolean focused = Boolean.TRUE.equals(state.get("focused"));
                        long now = System.currentTimeMillis();
                        if (!visible) {
                            // User moved to another tab in this window - follow once.
                            if (followActiveTab(driver, handles, current)) {
                                idleSweepBackoffMs = MIN_IDLE_SWEEP_MS;
                            }
                            nextIdleSweepMs = now + idleSweepBackoffMs;
                        } else if (!focused && now >= nextIdleSweepMs) {
                            // Still visible but unfocused: either a second browser
                            // window has the user, or the browser is in the
                            // background. Only the first case needs a sweep, and the
                            // two are indistinguishable from here, so back off
                            // whenever the sweep finds nothing.
                            if (followActiveTab(driver, handles, current)) {
                                idleSweepBackoffMs = MIN_IDLE_SWEEP_MS;
                            } else {
                                idleSweepBackoffMs = Math.min(idleSweepBackoffMs * 2, MAX_IDLE_SWEEP_MS);
                            }
                            nextIdleSweepMs = System.currentTimeMillis() + idleSweepBackoffMs;
                        }
                    }

                    Thread.sleep(200);
                } catch (org.openqa.selenium.WebDriverException e) {
                    String msg = e.getMessage() != null ? e.getMessage().toLowerCase(Locale.ROOT) : "";
                    if (msg.contains("target window already closed")
                            || msg.contains("no such window")
                            || msg.contains("web view not found")
                            || msg.contains("chrome not reachable")) {
                        // If any windows remain, continue; else exit
                        try {
                            if (driver.getWindowHandles().isEmpty()) {
                                System.out.println("\nBrowser closed.");
                                break;
                            }
                        } catch (Exception e2) {
                            System.out.println("\nBrowser closed.");
                            break;
                        }
                    }
                }
            }
        } finally {
            if (saveCookiesPath != null) {
                try {
                    saveCookies(driver, Path.of(saveCookiesPath));
                } catch (Exception e) {
                    System.err.println("Failed to save cookies: " + e.getMessage());
                }
            }
            try {
                driver.quit();
            } catch (Exception ignored) {
                // already closed
            }
        }

        refreshFlowFromSteps();
        System.out.printf("%nDone! %d capture(s) this session in %s%n",
                captureCount, sessionDir.toAbsolutePath());
        System.out.println("Feed this folder (YAML + flow.md + PROMPT.md) to Claude Code / your LLM.");
    }

    /**
     * Optional rename: session-&lt;timestamp&gt; → session-&lt;name&gt;-&lt;timestamp&gt;
     * e.g. session-login-flow-2026-07-22T15-30-45 (America/New_York)
     */
    private void applySessionFolderName(String optionalName) {
        if (!sessionSubdir || optionalName == null || optionalName.isBlank()) {
            return;
        }
        String safe = optionalName.trim()
                .replaceAll("[<>:\"/\\\\|?*\\x00-\\x1f]", "")
                .replaceAll("\\s+", "-")
                .replaceAll("-+", "-")
                .replaceAll("^\\.+|\\.+$", "");
        if (safe.length() > 80) {
            safe = safe.substring(0, 80);
        }
        if (safe.isBlank()) {
            return;
        }
        Path parent = sessionDir.getParent();
        if (parent == null) {
            return;
        }
        String base = sessionDir.getFileName().toString();
        String timestamp = base.startsWith("session-") ? base.substring("session-".length()) : base;
        Path target = parent.resolve("session-" + safe + "-" + timestamp);
        int n = 2;
        while (Files.exists(target)) {
            target = parent.resolve("session-" + safe + "-" + n + "-" + timestamp);
            n++;
        }
        try {
            Files.move(sessionDir, target);
            sessionDir = target;
            System.out.println("Session folder renamed to: " + sessionDir.toAbsolutePath());
        } catch (IOException e) {
            System.err.println("Could not rename session folder: " + e.getMessage());
        }
    }

    String parseArgs(String[] args) {
        String startUrl = args[0];
        // Config files load first, whatever their position, so an explicit flag
        // always wins over the file it shares a command line with.
        for (int i = 1; i < args.length; i++) {
            if (args[i].startsWith("--config=")) {
                loadConfigFile(Path.of(args[i].substring("--config=".length())));
            }
        }
        for (int i = 1; i < args.length; i++) {
            String a = args[i];
            if (a.startsWith("--config=")) {
                continue;
            } else if (a.startsWith("--load-cookies=")) {
                loadCookiesPath = a.substring("--load-cookies=".length());
            } else if (a.startsWith("--save-cookies=")) {
                saveCookiesPath = a.substring("--save-cookies=".length());
            } else if (a.startsWith("--goal=")) {
                goal = a.substring("--goal=".length());
            } else if (a.startsWith("--max-table-rows=")) {
                maxTableRows = parseIntOr(a.substring("--max-table-rows=".length()), maxTableRows,
                        "--max-table-rows");
            } else if (a.startsWith("--timezone=")) {
                setTimezone(a.substring("--timezone=".length()));
            } else if (a.equals("--no-hints")) {
                includeHints = false;
            } else if (a.equals("--no-redact")) {
                redactPasswords = false;
                redactEmails = false;
            } else if (a.equals("--no-diff")) {
                writeDiff = false;
            } else if (a.equals("--flat")) {
                sessionSubdir = false;
            } else if (a.startsWith("--output=")) {
                outputRoot = Path.of(a.substring("--output=".length()));
            } else if (a.startsWith("--framework=")) {
                framework = a.substring("--framework=".length());
            } else if (a.startsWith("--style=")) {
                style = a.substring("--style=".length());
            } else if (a.startsWith("--waits=")) {
                waits = a.substring("--waits=".length());
            } else if (a.startsWith("--chromedriver=")) {
                chromeDriverPath = a.substring("--chromedriver=".length());
            } else if (a.startsWith("--toolbar-position=")) {
                toolbarPosition = normalizeToolbarPosition(a.substring("--toolbar-position=".length()));
            } else if (a.equals("--toolbar-left")) {
                toolbarPosition = "left";
            } else if (a.equals("--toolbar-middle") || a.equals("--toolbar-center")) {
                toolbarPosition = "middle";
            } else if (a.equals("--toolbar-right")) {
                toolbarPosition = "right";
            } else {
                System.err.println("Unknown option: " + a);
            }
        }
        return startUrl;
    }

    /** Keeps a typo in a number from taking the whole session down. */
    private static int parseIntOr(String raw, int fallback, String label) {
        try {
            return Integer.parseInt(raw.trim());
        } catch (RuntimeException e) {
            System.err.println("Ignoring invalid " + label + "=" + raw + " (using " + fallback + ")");
            return fallback;
        }
    }

    private void setTimezone(String value) {
        String tz = value == null ? "" : value.trim();
        if (tz.isEmpty()) {
            System.err.println("Ignoring empty timezone");
            return;
        }
        try {
            ZoneId.of(tz);
            timezone = tz;
        } catch (Exception e) {
            System.err.println("Unknown timezone \"" + tz + "\" - using " + timezone);
        }
    }

    void loadConfigFile(Path path) {
        if (!Files.isRegularFile(path)) {
            return;
        }
        Properties p = new Properties();
        try (InputStream in = Files.newInputStream(path)) {
            p.load(in);
        } catch (IOException e) {
            System.err.println("Could not read config " + path + ": " + e.getMessage());
            return;
        }
        System.out.println("Loaded config: " + path.toAbsolutePath());
        if (p.containsKey("outputDir")) {
            outputRoot = Path.of(p.getProperty("outputDir"));
        }
        if (p.containsKey("sessionSubdir")) {
            sessionSubdir = Boolean.parseBoolean(p.getProperty("sessionSubdir"));
        }
        if (p.containsKey("includeHints")) {
            includeHints = Boolean.parseBoolean(p.getProperty("includeHints"));
        }
        if (p.containsKey("redactPasswords")) {
            redactPasswords = Boolean.parseBoolean(p.getProperty("redactPasswords"));
        }
        if (p.containsKey("redactEmails")) {
            redactEmails = Boolean.parseBoolean(p.getProperty("redactEmails"));
        }
        if (p.containsKey("writeDiff")) {
            writeDiff = Boolean.parseBoolean(p.getProperty("writeDiff"));
        }
        if (p.containsKey("maxTableRows")) {
            maxTableRows = parseIntOr(p.getProperty("maxTableRows"), maxTableRows, "maxTableRows");
        }
        if (p.containsKey("framework")) {
            framework = p.getProperty("framework").trim();
        }
        if (p.containsKey("style")) {
            style = p.getProperty("style").trim();
        }
        if (p.containsKey("waits")) {
            waits = p.getProperty("waits").trim();
        }
        if (p.containsKey("goal")) {
            goal = p.getProperty("goal");
        }
        if (p.containsKey("loadCookies")) {
            loadCookiesPath = emptyToNull(p.getProperty("loadCookies"));
        }
        if (p.containsKey("saveCookies")) {
            saveCookiesPath = emptyToNull(p.getProperty("saveCookies"));
        }
        if (p.containsKey("chromeDriverPath")) {
            chromeDriverPath = emptyToNull(p.getProperty("chromeDriverPath"));
        }
        if (p.containsKey("toolbarPosition")) {
            toolbarPosition = normalizeToolbarPosition(p.getProperty("toolbarPosition"));
        }
        if (p.containsKey("timezone")) {
            setTimezone(p.getProperty("timezone"));
        }
    }

    private static String normalizeToolbarPosition(String v) {
        if (v == null) {
            return "right";
        }
        String s = v.trim().toLowerCase(Locale.ROOT);
        if (s.equals("left") || s.equals("l")) {
            return "left";
        }
        if (s.equals("middle") || s.equals("center") || s.equals("c") || s.equals("m")) {
            return "middle";
        }
        return "right";
    }

    /**
     * ChromeDriver path comes from capture.config.properties ({@code chromeDriverPath}) only.
     * Optional one-off override: {@code --chromedriver=...} (same field, CLI wins if set after config load).
     * Leave blank / unset to use Selenium Manager.
     */
    private void configureChromeDriver() {
        if (chromeDriverPath == null || chromeDriverPath.isBlank()) {
            System.out.println("Using Selenium Manager for ChromeDriver "
                    + "(set chromeDriverPath in capture.config.properties to use a local driver).");
            return;
        }

        Path driver = Path.of(chromeDriverPath.trim());
        if (!Files.isRegularFile(driver)) {
            throw new IllegalStateException(
                    "chromeDriverPath does not exist: " + driver.toAbsolutePath()
                            + "\nUpdate chromeDriverPath in capture.config.properties "
                            + "(or pass --chromedriver=).");
        }

        String absolute = driver.toAbsolutePath().toString();
        System.setProperty("webdriver.chrome.driver", absolute);
        System.out.println("Using ChromeDriver: " + absolute);
    }

    private static String emptyToNull(String s) {
        if (s == null || s.isBlank()) {
            return null;
        }
        return s.trim();
    }

    private void writePromptPack(Instant sessionStart) throws IOException {
        Path agentSrc = Path.of("Reading-Snapshots.md");
        String agentBody;
        if (Files.isRegularFile(agentSrc)) {
            agentBody = Files.readString(agentSrc, StandardCharsets.UTF_8);
        } else {
            agentBody = defaultAgentInstructions();
        }
        Files.writeString(sessionDir.resolve("Reading-Snapshots.md"), agentBody, StandardCharsets.UTF_8);

        StringBuilder prompt = new StringBuilder();
        prompt.append("# Test generation prompt\n\n");
        prompt.append("Generated: ").append(ISO_TS.format(sessionStart)).append('\n');
        prompt.append("Start URL: ").append(sessionStartUrl).append('\n');
        prompt.append("Framework: ").append(framework).append('\n');
        prompt.append("Style: ").append(style).append('\n');
        prompt.append("Waits: ").append(waits).append('\n');
        if (goal != null && !goal.isBlank()) {
            prompt.append("Goal: ").append(goal).append('\n');
        }
        prompt.append('\n');
        prompt.append("## Task for the coding agent\n\n");
        prompt.append("Using the YAML page snapshots and `flow.md` in this folder, generate ");
        prompt.append("**Selenium Java** automated tests.\n\n");
        prompt.append("Requirements:\n");
        prompt.append("- Read `SESSION.md`, then `TEST_GUIDE.md`, then `flow.md`, then the YAML snapshots.\n");
        prompt.append("- Prefer the highest `score` locator. Never use `score <= 40` unless nothing else exists; a `matches: N` locator is not unique.\n");
        prompt.append("- Prefer locators marked `stability: high` (id, name, data-testid) from the YAML. Never use `stability: low` unless nothing else exists.\n");
        prompt.append("- Never use a locator containing a generated value (ULID/UUID, counters like mat-input-4 or input-8472, hashed classes like css-1x2y3z): it changes next run. Such locators are scored 20 and are only listed when nothing stable exists; then ask the developer for a stable data-test.\n");
        prompt.append("- Do not `driver.get(...)` a URL to skip a control that is in the YAML (especially the cart).\n");
        prompt.append("- Each control lists at most two verified locators (token-lean); do not invent extras.\n");
        prompt.append("- Use ").append(waits).append(" waits (avoid brittle Thread.sleep).\n");
        prompt.append("- Structure: ").append(style).append(".\n");
        prompt.append("- Test framework: ").append(framework).append(".\n");
        prompt.append("- Do not invent elements that are not present in the snapshots.\n");
        prompt.append("- Follow each step in `flow.md` and honor step notes as intended actions/assertions.\n");
        prompt.append("- Read `Reading-Snapshots.md` for conventions (including dropdown closed vs open).\n");
        prompt.append("- Native `<select>` options appear under `options:` even when closed; custom menus need open-state snapshots.\n");
        prompt.append("- Use `NN_diff.md` (especially **Dropdown / options changes**) when steps open menus or reveal options.\n");
        if (goal != null && !goal.isBlank()) {
            prompt.append("\nUser goal: ").append(goal).append('\n');
        }
        Files.writeString(sessionDir.resolve("PROMPT.md"), prompt.toString(), StandardCharsets.UTF_8);

        StringBuilder sessionMd = new StringBuilder();
        sessionMd.append("# PageSnap session\n\n");
        sessionMd.append("- Start URL: ").append(sessionStartUrl).append('\n');
        if (goal != null && !goal.isBlank()) {
            sessionMd.append("- Goal: ").append(goal).append('\n');
        }
        sessionMd.append("- Framework: ").append(framework).append('\n');
        sessionMd.append("- Style: ").append(style).append('\n');
        sessionMd.append("- Generated: ").append(ISO_TS.format(sessionStart)).append("\n\n");
        sessionMd.append("Steps: see flow.md (updated as you capture)\n\n");
        sessionMd.append("Read order: SESSION.md -> TEST_GUIDE.md -> flow.md -> YAML snapshots -> PROMPT.md / Reading-Snapshots.md\n");
        Files.writeString(sessionDir.resolve("SESSION.md"), sessionMd.toString(), StandardCharsets.UTF_8);

        StringBuilder guide = new StringBuilder();
        guide.append("# Test generation guide\n\n");
        guide.append("Read in this order: SESSION.md -> TEST_GUIDE.md -> flow.md -> YAML snapshots -> PROMPT.md / Reading-Snapshots.md\n\n");
        guide.append("## Goal\n");
        guide.append("Produce ONE runnable Selenium Java test covering EVERY flow.md step in order. Do not invent steps or elements.\n\n");
        guide.append("## Locators\n");
        guide.append("- Prefer the highest `score`. Never use `score <= 40` unless nothing else exists. Never use `stability: low` unless nothing else exists.\n");
        guide.append("- Never use a locator containing a generated value (ULID/UUID, counters like mat-input-4 or input-8472, hashed classes like css-1x2y3z): it changes next run. Such locators are scored 20 and are only listed when nothing stable exists; then ask the developer for a stable data-test.\n");
        guide.append("- YAML `by: css` with a `[data-test...]` value is the test-id locator: use By.cssSelector exactly as written.\n");
        guide.append("- Do not driver.get(...) a URL to skip a control that is in the YAML (especially the cart).\n\n");
        guide.append("## Actions\n");
        guide.append("- Native `<select>`: `new Select(...)` from `options:`. Custom dropdown: closed then open; read NN_diff.md.\n");
        guide.append("- Honor waits=").append(waits).append(". Never Thread.sleep.\n");
        guide.append("- Honor `action:` / `assert:` / `data:` prefixes in notes.\n\n");
        guide.append("Framework=").append(framework).append(". Style=").append(style).append(". Waits=").append(waits).append(".\n");
        Files.writeString(sessionDir.resolve("TEST_GUIDE.md"), guide.toString(), StandardCharsets.UTF_8);
        refreshFlowFromSteps();
    }

    private static String defaultAgentInstructions() {
        // Fallback if Reading-Snapshots.md is missing from CWD; keep in sync with that file.
        return """
                # Reading snapshots - Selenium test generation from page snapshots

                You are given YAML page snapshots of a real web UI, captured for generating **Selenium Java** tests.

                ## How to read snapshots

                - Nested under controls: `value`, `locators`, `options:` (native select), `dropdown: open|closed`.
                - Comment sections: full `<select>` options dump, table headers/rows.
                - Alerts/validation are tree nodes: `- alert "message"` at page position; field errors as `error:` / `validationMessage:` under the field.
                - Duplicate names carry `[in="…"]` (nearest named container) or `[dup K/N]` qualifiers; hints mirror them (`// Billing > Save: …`).
                - `…`/`truncated` markers mean content was cut at a cap - never assume unlisted rows/subtrees don't exist.
                - `NN_diff.md` includes **Dropdown / options changes** when menus open.
                - `flow.md` step notes are the scenario narrative.

                ## Dropdowns

                - Native `<select>`: one snapshot; use `options:` and Select API in Selenium.
                - Custom menus: two captures (closed then open); open before selecting in tests.

                ## Locator rules

                1. Prefer the highest `score` (data-test css 98, id 92, name 88, linkText 75, css 45-85, label/text xpath 60, xpath 40, generated values 20); never use score <= 40 unless nothing else exists. Prefer stability high (id, name, data-testid).
                2. Never invent elements not in the snapshot.
                3. Explicit waits; Page Object when style=pageobject.
                """;
    }

    private void injectUi(WebDriver driver, JavascriptExecutor js) {
        try {
            // Pass default toolbar position into page before install
            js.executeScript(
                    "if (!sessionStorage.getItem('__ps_toolbar_pos')) {"
                            + "  window.__snapshotToolbarPosition = arguments[0];"
                            + "}",
                    toolbarPosition);
            js.executeScript(INSTALL_UI_JS);
        } catch (Exception ignored) {
            // page may be mid-navigation
        }
    }

    private static String shortHandle(String handle) {
        if (handle == null) return "?";
        return handle.length() <= 8 ? handle : handle.substring(0, 8) + "...";
    }

    /**
     * Everything the poll loop needs from the tab it is already on, in one
     * round-trip. Clears the capture request as it reads it, so the flag cannot
     * be reported twice.
     *
     * `needsInject` asks the page directly whether the UI is still installed -
     * the old check hashed {@code documentElement.outerHTML.length}, which
     * serialized the whole DOM several times a second and re-injected constantly
     * on any page that animates.
     */
    private static final String POLL_STATE_JS = """
            var w = window;
            var out = {
              visible: document.visibilityState === 'visible',
              focused: document.hasFocus(),
              capture: w.__snapshotCapture === true,
              note: '',
              end: w.__snapshotEnd === true,
              name: w.__snapshotSessionName || '',
              needsInject: !(w.__snapshotInit === true
                             && document.getElementById('__snapshot_toolbar_root'))
            };
            if (out.capture) {
              out.note = w.__snapshotNote || '';
              w.__snapshotCapture = false;
              w.__snapshotNote = '';
            }
            return out;
            """;

    /** Side-effect free: used while sweeping tabs so no capture request is consumed. */
    private static final String FOCUS_PROBE_JS = """
            return {
              visible: document.visibilityState === 'visible',
              focused: document.hasFocus()
            };
            """;

    @SuppressWarnings("unchecked")
    private static Map<String, Object> readTabState(JavascriptExecutor js, String script) {
        try {
            Object result = js.executeScript(script);
            if (result instanceof Map<?, ?> map) {
                Map<String, Object> out = new LinkedHashMap<>();
                for (Map.Entry<?, ?> e : map.entrySet()) {
                    out.put(String.valueOf(e.getKey()), e.getValue());
                }
                return out;
            }
        } catch (org.openqa.selenium.WebDriverException e) {
            // tab is navigating or was closed - try again next tick
        }
        return Map.of();
    }

    private static Map<String, Object> readTabState(JavascriptExecutor js) {
        return readTabState(js, POLL_STATE_JS);
    }

    /**
     * Moves the driver to the tab the user is actually working in.
     *
     * Called only when the current tab reports it is hidden or unfocused, because
     * every switchTo() raises a tab: doing this on a timer is what made the
     * browser flicker between tabs.
     *
     * @return true when a focused (or at least visible) tab was found
     */
    private static boolean followActiveTab(WebDriver driver, Set<String> handles, String fallback) {
        String visibleHandle = null;
        for (String h : handles) {
            try {
                driver.switchTo().window(h);
                Map<String, Object> s = readTabState((JavascriptExecutor) driver, FOCUS_PROBE_JS);
                if (Boolean.TRUE.equals(s.get("focused"))) {
                    if (!h.equals(fallback)) {
                        System.out.println("[tab] following active tab " + shortHandle(h));
                    }
                    return true;
                }
                if (visibleHandle == null && Boolean.TRUE.equals(s.get("visible"))) {
                    visibleHandle = h;
                }
            } catch (Exception ignored) {
                // tab closed mid-sweep
            }
        }
        if (visibleHandle != null) {
            try {
                driver.switchTo().window(visibleHandle);
                if (!visibleHandle.equals(fallback)) {
                    System.out.println("[tab] following visible tab " + shortHandle(visibleHandle));
                }
                return true;
            } catch (Exception ignored) {
                // fall through
            }
        }
        // Nothing focused or visible (browser minimised): stay where we were.
        try {
            driver.switchTo().window(fallback);
        } catch (Exception ignored) {
            // handle disappeared
        }
        return false;
    }

    @SuppressWarnings("unchecked")
    /** Same URL + same note within this window is a double-fire, not a second step. */
    static final long DUP_WINDOW_MS = 2500;
    private long dupCaptureAtMs;
    private String dupCaptureUrl;
    private String dupCaptureNote;

    /**
     * Collapse doubled prefixes and glued duplicates from the note dialog:
     * "2action:" -> "2 action:", "action: action: x" -> "action: x", "abcabc" -> "abc".
     */
    static String normalizeNote(String raw) {
        String n = raw == null ? "" : raw.replaceAll("\\s+", " ").trim();
        n = n.replaceAll("(?i)(\\S)(?=(?:action|assert|data):)", "$1 ");
        java.util.regex.Matcher m = java.util.regex.Pattern
                .compile("(?i)^(action|assert|data):\\s*(?:\\1:\\s*)+").matcher(n);
        if (m.find()) {
            n = n.substring(0, m.start()) + m.group(1).toLowerCase() + ": " + n.substring(m.end());
        }
        if (n.length() >= 8 && n.length() % 2 == 0) {
            int half = n.length() / 2;
            if (n.substring(0, half).equals(n.substring(half))) {
                n = n.substring(0, half).trim();
            }
        }
        return n.replaceAll("\\s+", " ").trim();
    }

    static boolean isDuplicateCapture(long lastAt, String lastUrl, String lastNote,
                                      long now, String url, String note) {
        return lastUrl != null && now - lastAt < DUP_WINDOW_MS
                && lastUrl.equals(url) && java.util.Objects.equals(lastNote, note);
    }

    private boolean saveSnapshot(WebDriver driver, JavascriptExecutor js, String note) {
        try {
            note = normalizeNote(note);
            String url = driver.getCurrentUrl();
            if (url == null || url.equals("about:blank")) {
                System.out.println("  Skipped: about:blank");
                try {
                    js.executeScript(
                            "if (window.__snapshotToast) window.__snapshotToast('Skipped about:blank', false);");
                } catch (Exception ignored) {
                    // ignore
                }
                return false;
            }

            long nowMs = System.currentTimeMillis();
            if (isDuplicateCapture(dupCaptureAtMs, dupCaptureUrl, dupCaptureNote, nowMs, url, note)) {
                System.out.println("  Skipped duplicate capture");
                return false;
            }
            dupCaptureAtMs = nowMs;
            dupCaptureUrl = url;
            dupCaptureNote = note;

            waitForDomReady(js, 300, 5000);

            // Hide toolbar/toast/note before walking DOM
            try {
                js.executeScript(
                        "if (window.__snapshotSetChromeHidden) window.__snapshotSetChromeHidden(true);");
            } catch (Exception ignored) {
                // ignore
            }

            String tree = "";
            List<String> hints = List.of();
            try {
                Map<String, Object> opts = new LinkedHashMap<>();
                opts.put("maxTableRows", maxTableRows);
                opts.put("redactPasswords", redactPasswords);
                opts.put("redactEmails", redactEmails);

                Object result = js.executeScript(CAPTURE_TREE_JS, opts);
                if (result instanceof Map<?, ?> map) {
                    Object t = map.get("tree");
                    tree = t != null ? t.toString() : "";
                    Object h = map.get("hints");
                    if (h instanceof List<?> list) {
                        List<String> collected = new ArrayList<>();
                        for (Object item : list) {
                            if (item != null) {
                                collected.add(item.toString());
                            }
                        }
                        hints = collected;
                    }
                } else if (result != null) {
                    tree = result.toString();
                }
            } finally {
                try {
                    js.executeScript(
                            "if (window.__snapshotSetChromeHidden) window.__snapshotSetChromeHidden(false);");
                } catch (Exception ignored) {
                    // ignore
                }
            }

            if (redactEmails) {
                tree = EMAIL.matcher(tree).replaceAll("***@***.***");
            }

            if (tree.isBlank()) {
                System.err.println("  Warning: capture script returned empty tree (null/blank).");
            }

            Instant now = Instant.now();
            step++;
            int stepN = step;
            String base = String.format("%02d_%s", stepN, sanitizeUrl(url));
            String filename = base + ".yaml";
            Path filepath = sessionDir.resolve(filename);

            StringBuilder content = new StringBuilder();
            content.append("# URL: ").append(url).append('\n');
            content.append("# Captured: ").append(ISO_TS.format(now)).append('\n');
            content.append("# Trigger: manual\n");
            content.append("# Step: ").append(stepN).append('\n');
            if (note != null && !note.isBlank()) {
                content.append("# Note: ").append(note.replace('\n', ' ')).append('\n');
            }
            if (goal != null && !goal.isBlank()) {
                content.append("# Session goal: ").append(goal.replace('\n', ' ')).append('\n');
            }
            content.append('\n');
            content.append(tree).append('\n');

            if (includeHints && !hints.isEmpty()) {
                content.append('\n');
                content.append("# --- Selenium hints (best-effort; prefer high-stability locators) ---\n");
                for (String hint : hints) {
                    content.append(hint.startsWith("//") ? "# " + hint.substring(2).trim() : "# " + hint);
                    content.append('\n');
                }
            }

            Files.createDirectories(sessionDir);
            Files.writeString(filepath, content.toString(), StandardCharsets.UTF_8);

            if (writeDiff && !lastTreeBody.isBlank() && !tree.isBlank()) {
                String diff = simpleDiff(lastTreeBody, tree);
                if (!diff.isBlank()) {
                    Path diffPath = sessionDir.resolve(String.format("%02d_diff.md", stepN));
                    String diffDoc = diffHeader(stepN - 1, stepN, lastCaptureUrl, url) + diff;
                    Files.writeString(diffPath, diffDoc, StandardCharsets.UTF_8);
                }
            }
            lastTreeBody = tree;
            lastCaptureUrl = url;

            steps.add(new StepRecord(stepN, filename, url, note, ISO_TS.format(now)));
            refreshFlowFromSteps();

            System.out.println("  Saved: " + filename
                    + (tree.isBlank() ? " (EMPTY TREE)" : " (" + tree.lines().count() + " lines)"));
            try {
                js.executeScript(
                        "if (window.__snapshotToast) window.__snapshotToast(arguments[0], true);",
                        "Saved snapshot #" + stepN);
            } catch (Exception ignored) {
                // ignore
            }
            return true;
        } catch (Exception e) {
            System.err.println("  Failed to capture: " + e.getMessage());
            e.printStackTrace(System.err);
            try {
                js.executeScript(
                        "if (window.__snapshotSetChromeHidden) window.__snapshotSetChromeHidden(false);"
                                + "if (window.__snapshotToast) window.__snapshotToast('Capture failed', false);");
            } catch (Exception ignored) {
                // ignore
            }
            return false;
        }
    }

    private void refreshFlowFromSteps() throws IOException {
        StringBuilder sb = new StringBuilder();
        sb.append("# Capture session flow\n\n");
        sb.append("- Updated: ").append(ISO_TS.format(Instant.now())).append('\n');
        sb.append("- Start URL: ").append(sessionStartUrl).append('\n');
        if (goal != null && !goal.isBlank()) {
            sb.append("- Goal: ").append(goal).append('\n');
        }
        sb.append("- Steps captured: ").append(steps.size()).append('\n');
        sb.append('\n');
        sb.append("## Steps\n\n");
        if (steps.isEmpty()) {
            sb.append("_No steps captured yet._\n");
        } else {
            for (StepRecord s : steps) {
                sb.append("### ").append(s.n()).append(". ");
                sb.append(s.note() != null && !s.note().isBlank() ? s.note() : "Capture").append('\n');
                sb.append("- File: `").append(s.file()).append("`\n");
                sb.append("- URL: ").append(s.url()).append('\n');
                sb.append("- Captured: ").append(s.capturedAt()).append('\n');
                if (writeDiff && s.n() > 1 && Files.exists(sessionDir.resolve(String.format("%02d_diff.md", s.n())))) {
                    sb.append("- Diff vs previous: `").append(String.format("%02d_diff.md", s.n())).append("`\n");
                }
                sb.append('\n');
            }
        }
        Files.writeString(sessionDir.resolve("flow.md"), sb.toString(), StandardCharsets.UTF_8);
    }

    /** Header for NN_diff.md, naming the URL each side was actually captured on. */
    static String diffHeader(int fromStep, int toStep, String fromUrl, String toUrl) {
        String head = "# Diff step " + fromStep + " \u2192 " + toStep + "\n\n";
        if (fromUrl != null && !fromUrl.isBlank() && fromUrl.equals(toUrl)) {
            return head + "Both steps were captured on the same URL: " + fromUrl + "\n\n";
        }
        return head
                + "- Step " + fromStep + " URL: " + (fromUrl == null || fromUrl.isBlank() ? "unknown" : fromUrl) + "\n"
                + "- Step " + toStep + " URL: " + (toUrl == null || toUrl.isBlank() ? "unknown" : toUrl) + "\n\n";
    }

    /**
     * Count-aware line diff between consecutive trees. A line present once before
     * and three times after is two additions, not "no change" - set-based diffing
     * hid exactly the repeated rows and options these snapshots exist to show.
     */
    static String simpleDiff(String before, String after) {
        List<String> beforeLines = diffLines(before);
        List<String> afterLines = diffLines(after);
        List<String> added = new ArrayList<>();
        List<String> removed = new ArrayList<>();

        Map<String, Integer> budget = new LinkedHashMap<>();
        for (String l : beforeLines) {
            budget.merge(l, 1, Integer::sum);
        }
        for (String l : afterLines) {
            int left = budget.getOrDefault(l, 0);
            if (left > 0) {
                budget.put(l, left - 1);
            } else {
                added.add(l);
            }
        }
        Map<String, Integer> afterBudget = new LinkedHashMap<>();
        for (String l : afterLines) {
            afterBudget.merge(l, 1, Integer::sum);
        }
        for (String l : beforeLines) {
            int left = afterBudget.getOrDefault(l, 0);
            if (left > 0) {
                afterBudget.put(l, left - 1);
            } else {
                removed.add(l);
            }
        }

        if (added.isEmpty() && removed.isEmpty()) {
            if (beforeLines.equals(afterLines)) {
                return "_No structural line changes detected._\n";
            }
            List<String> moved = new ArrayList<>();
            for (int i = 0; i < afterLines.size(); i++) {
                if (i >= beforeLines.size() || !beforeLines.get(i).equals(afterLines.get(i))) {
                    moved.add(afterLines.get(i));
                }
            }
            StringBuilder sb = new StringBuilder();
            sb.append("## Reordered\n\n");
            sb.append("_Same lines in a different order (").append(moved.size())
                    .append(" line(s) shifted position)._\n\n");
            moved.stream().limit(40).forEach(l -> sb.append("~ ").append(l).append('\n'));
            return sb.toString();
        }

        // Highlight option/dropdown-related lines first (common closed→open pattern)
        List<String> addedOptions = added.stream().filter(SnapshotCapture::looksLikeOptionLine).sorted().toList();
        List<String> removedOptions = removed.stream().filter(SnapshotCapture::looksLikeOptionLine).sorted().toList();
        List<String> addedOther = added.stream().filter(l -> !looksLikeOptionLine(l)).sorted().toList();
        List<String> removedOther = removed.stream().filter(l -> !looksLikeOptionLine(l)).sorted().toList();

        StringBuilder sb = new StringBuilder();
        sb.append("_Tip: For custom dropdowns, capture once closed and once open (Ctrl+Shift+K with notes)._\n\n");
        if (!addedOptions.isEmpty() || !removedOptions.isEmpty()) {
            sb.append("## Dropdown / options changes\n\n");
            for (String l : addedOptions.stream().limit(60).toList()) {
                sb.append("+ ").append(l).append('\n');
            }
            for (String l : removedOptions.stream().limit(60).toList()) {
                sb.append("- ").append(l).append('\n');
            }
            sb.append('\n');
        }
        if (!addedOther.isEmpty()) {
            sb.append("## Added\n\n");
            addedOther.stream().limit(80).forEach(l -> sb.append("+ ").append(l).append('\n'));
            sb.append('\n');
        }
        if (!removedOther.isEmpty()) {
            sb.append("## Removed\n\n");
            removedOther.stream().limit(80).forEach(l -> sb.append("- ").append(l).append('\n'));
            sb.append('\n');
        }
        return sb.toString();
    }

    /** Structural lines that take part in a diff, in document order (duplicates kept). */
    private static List<String> diffLines(String body) {
        List<String> out = new ArrayList<>();
        for (String line : body.split("\\R")) {
            String t = line.trim();
            if (t.isEmpty()) {
                continue;
            }
            // Keep role-tree lines and dumps that matter for dropdowns/tables/errors
            if (!t.startsWith("#")
                    || t.contains("<select>")
                    || t.contains("option")
                    || t.startsWith("#   -")
                    || t.startsWith("# table")
                    || t.contains("headers:")
                    || t.contains("row ")) {
                out.add(t);
            }
        }
        return out;
    }

    private static boolean looksLikeOptionLine(String line) {
        String l = line.toLowerCase(Locale.ROOT);
        return l.contains("option ")
                || l.contains("<select>")
                || l.contains("dropdown:")
                || l.contains("listbox")
                || l.contains("combobox")
                || (l.contains("listitem") && l.contains("\""));
    }

    private void waitForDomReady(JavascriptExecutor js, int stableMs, int maxMs) {
        try {
            js.executeAsyncScript(WAIT_READY_JS, stableMs, maxMs);
        } catch (Exception ignored) {
            // page navigated during wait
        }
    }

    /**
     * Host + path only; strips jsessionid, query string, fragment, and unsafe chars.
     */
    static String sanitizeUrl(String url) {
        try {
            String cleaned = url
                    .replaceAll("(?i);jsessionid=[^?#/]*", "")
                    .replaceAll("(?i)(?:^|[?&])jsessionid=[^&#]*", "");
            java.net.URI uri = java.net.URI.create(cleaned);
            String host = uri.getHost() != null ? uri.getHost() : "unknown";
            String path = uri.getPath();
            if (path == null || path.isBlank() || path.equals("/")) {
                path = "root";
            } else {
                path = path.replaceAll("^/|/$", "").replace('/', '_');
            }
            // drop query/fragment intentionally
            String base = (host + "_" + path).replaceAll("[^a-zA-Z0-9._-]", "_");
            if (base.length() > 80) {
                base = base.substring(0, 80);
            }
            return base;
        } catch (Exception e) {
            return "unknown";
        }
    }

    private void loadCookies(WebDriver driver, Path path, String startUrl) throws IOException {
        if (!Files.isRegularFile(path)) {
            System.err.println("Cookies file not found: " + path);
            return;
        }
        String raw = Files.readString(path, StandardCharsets.UTF_8).trim();
        // Minimal JSON array of {name,value,domain,path,secure,httpOnly,expiry}
        List<Map<String, String>> cookies = parseCookieJson(raw);
        // Need to be on domain first
        try {
            java.net.URI uri = java.net.URI.create(startUrl);
            String origin = uri.getScheme() + "://" + uri.getHost()
                    + (uri.getPort() > 0 ? ":" + uri.getPort() : "");
            driver.get(origin);
        } catch (Exception ignored) {
            // stay on startUrl
        }
        int n = 0;
        for (Map<String, String> c : cookies) {
            try {
                Cookie.Builder b = new Cookie.Builder(c.get("name"), c.get("value"));
                if (c.get("domain") != null) {
                    b.domain(c.get("domain"));
                }
                if (c.get("path") != null) {
                    b.path(c.get("path"));
                } else {
                    b.path("/");
                }
                if ("true".equalsIgnoreCase(c.getOrDefault("secure", "false"))) {
                    b.isSecure(true);
                }
                if ("true".equalsIgnoreCase(c.getOrDefault("httpOnly", "false"))) {
                    b.isHttpOnly(true);
                }
                if (c.get("expiry") != null && !c.get("expiry").isBlank()) {
                    try {
                        long exp = Long.parseLong(c.get("expiry"));
                        if (exp > 0) {
                            b.expiresOn(new java.util.Date(exp * (exp < 10_000_000_000L ? 1000 : 1)));
                        }
                    } catch (NumberFormatException ignored) {
                        // skip expiry
                    }
                }
                driver.manage().addCookie(b.build());
                n++;
            } catch (Exception e) {
                System.err.println("  Skip cookie " + c.get("name") + ": " + e.getMessage());
            }
        }
        System.out.println("Loaded " + n + " cookie(s) from " + path);
    }

    private void saveCookies(WebDriver driver, Path path) throws IOException {
        Set<Cookie> cookies = driver.manage().getCookies();
        StringBuilder sb = new StringBuilder();
        sb.append("[\n");
        int i = 0;
        for (Cookie c : cookies) {
            if (i++ > 0) {
                sb.append(",\n");
            }
            sb.append("  {\n");
            sb.append("    \"name\": ").append(jsonStr(c.getName())).append(",\n");
            sb.append("    \"value\": ").append(jsonStr(c.getValue())).append(",\n");
            sb.append("    \"domain\": ").append(jsonStr(c.getDomain())).append(",\n");
            sb.append("    \"path\": ").append(jsonStr(c.getPath() != null ? c.getPath() : "/")).append(",\n");
            sb.append("    \"secure\": ").append(c.isSecure()).append(",\n");
            sb.append("    \"httpOnly\": ").append(c.isHttpOnly());
            if (c.getExpiry() != null) {
                sb.append(",\n    \"expiry\": ").append(c.getExpiry().getTime() / 1000);
            }
            sb.append("\n  }");
        }
        sb.append("\n]\n");
        Files.writeString(path, sb.toString(), StandardCharsets.UTF_8);
        System.out.println("Saved " + cookies.size() + " cookie(s) to " + path.toAbsolutePath());
    }

    private static String jsonStr(String s) {
        if (s == null) {
            return "null";
        }
        return "\"" + s.replace("\\", "\\\\").replace("\"", "\\\"") + "\"";
    }

    private static final List<String> COOKIE_FIELDS =
            List.of("name", "value", "domain", "path", "secure", "httpOnly", "expiry");

    /**
     * Reads a Selenium-compatible cookie array. Real JSON parsing first - the old
     * brace-matching scanner mangled any cookie carrying a nested object or a value
     * containing braces - with that scanner kept for files that are not valid JSON.
     */
    static List<Map<String, String>> parseCookieJson(String raw) {
        List<Map<String, String>> parsed = parseCookieJsonStrict(raw);
        return parsed != null ? parsed : scanCookieObjects(raw);
    }

    @SuppressWarnings("unchecked")
    private static List<Map<String, String>> parseCookieJsonStrict(String raw) {
        Object tree;
        try {
            tree = new Json().toType(raw, Object.class);
        } catch (RuntimeException e) {
            return null;
        }
        if (tree instanceof Map<?, ?> wrapper && wrapper.get("cookies") instanceof List<?>) {
            tree = wrapper.get("cookies");
        }
        if (!(tree instanceof List<?> entries)) {
            return null;
        }
        List<Map<String, String>> out = new ArrayList<>();
        for (Object entry : entries) {
            if (!(entry instanceof Map<?, ?> map)) {
                continue;
            }
            Object name = map.get("name");
            if (name == null || name.toString().isBlank()) {
                continue;
            }
            Map<String, String> cookie = new LinkedHashMap<>();
            for (String field : COOKIE_FIELDS) {
                Object v = map.get(field);
                if (v == null) {
                    continue;
                }
                if (v instanceof Number n) {
                    cookie.put(field, n.doubleValue() == Math.floor(n.doubleValue())
                            ? String.valueOf(n.longValue()) : n.toString());
                } else if (v instanceof Map || v instanceof List) {
                    continue; // nested structures are not cookie fields
                } else {
                    cookie.put(field, v.toString());
                }
            }
            cookie.putIfAbsent("value", "");
            out.add(cookie);
        }
        return out;
    }

    /** Last-resort scanner for hand-edited cookie files that are not valid JSON. */
    private static List<Map<String, String>> scanCookieObjects(String raw) {
        List<Map<String, String>> list = new ArrayList<>();
        // split objects roughly
        Matcher obj = Pattern.compile("\\{([^{}]*)\\}").matcher(raw);
        while (obj.find()) {
            String body = obj.group(1);
            Map<String, String> map = new LinkedHashMap<>();
            Matcher field = Pattern.compile(
                    "\"(name|value|domain|path|secure|httpOnly|expiry)\"\\s*:\\s*(\"(?:\\\\.|[^\"\\\\])*\"|true|false|null|[0-9]+)")
                    .matcher(body);
            while (field.find()) {
                String key = field.group(1);
                String val = field.group(2);
                if (val.startsWith("\"") && val.endsWith("\"")) {
                    val = val.substring(1, val.length() - 1).replace("\\\"", "\"").replace("\\\\", "\\");
                }
                map.put(key, val);
            }
            if (map.containsKey("name")) {
                map.putIfAbsent("value", "");
                list.add(map);
            }
        }
        return list;
    }

    private static void printUsage() {
        System.out.println("Usage: mvn -q exec:java -Dexec.args=\"<url> [options]\"");
        System.out.println();
        System.out.println("Manual page snapshot capture for LLM-assisted Selenium Java test generation.");
        System.out.println("  Ctrl+K       - capture snapshot (no note)");
        System.out.println("  Ctrl+Shift+K - capture with note (in-page form)");
        System.out.println("  Ctrl+Q       - end session");
        System.out.println();
        System.out.println("Options:");
        System.out.println("  --goal=<text>           Session goal written into PROMPT.md / YAML headers");
        System.out.println("  --config=<file>         Load capture.config.properties");
        System.out.println("  --output=<dir>          Output root (default: pageSnapshots)");
        System.out.println("  --flat                  Do not create session-* subdirectory");
        System.out.println("  --load-cookies=<file>   Load cookies JSON before capture");
        System.out.println("  --save-cookies=<file>   Save cookies JSON on exit");
        System.out.println("  --max-table-rows=<n>    Rows per table dump (default: 5)");
        System.out.println("  --framework=<name>      e.g. junit5, testng");
        System.out.println("  --style=<name>          e.g. pageobject, linear");
        System.out.println("  --waits=<name>          e.g. explicit, fluent");
        System.out.println("  --no-hints              Skip Selenium hint comments");
        System.out.println("  --no-redact             Do not mask passwords/emails");
        System.out.println("  --no-diff               Skip step diffs");
        System.out.println("  --chromedriver=<path>   Override chromeDriverPath for this run only");
        System.out.println("  --timezone=<zone>       IANA zone for session folder names (default: America/New_York)");
        System.out.println("  --toolbar-position=left|middle|right   Dock toolbar (default: right)");
        System.out.println("  --toolbar-left | --toolbar-middle | --toolbar-right");
        System.out.println();
        System.out.println("ChromeDriver: set chromeDriverPath in capture.config.properties (preferred).");
        System.out.println("Toolbar is the primary capture control (multi-tab supported).");
        System.out.println();
        System.out.println("Example:");
        System.out.println("  mvn -q exec:java -Dexec.args=\"https://myapp.com --goal=Register a user\"");
        System.out.println("  mvn -q exec:java -Dexec.args=\"https://myapp.com --save-cookies=cookies.json\"");
    }
}
