/**
 * Dynamic-value detection: a locator built on a value that changes between runs (generated ids, counters,
 * hashed class names, record ids in an href) is never valid, whatever attribute it sits in.
 *
 * Mirrored by `isDynamicValue` in the capture JS (SnapshotCapture.java); test/dynamic.test.ts keeps the two
 * in step. Link text is user-facing copy, not a generated value, so it is exempt.
 */
export function isDynamicValue(v: unknown): boolean {
  const t = String(v ?? "");
  if (!t) return false;
  if (/[0-9A-HJKMNP-TV-Z]{26}/.test(t)) return true; // ULID
  if (/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}/.test(t)) return true; // UUID
  if (/(?=[0-9a-f]*\d)[0-9a-f]{12,}/i.test(t)) return true; // long hex / hash
  if (/\d{3,}/.test(t)) return true; // 3+ digit run: counters, timestamps, row ids
  if (/^(mat|ng|ember|react|rc|ui|mui|radix|headlessui|downshift|select2|gwt|yui|ext)[-_a-z]*\d+/i.test(t)) return true; // framework counters
  if (/^:r[0-9a-z]*:$/.test(t) || /«[a-z0-9]+»/.test(t)) return true; // React useId
  if (/^(css|sc|jss|emotion|styled)-[a-z0-9]{5,}$/i.test(t)) return true; // CSS-in-JS classes
  if (/_[A-Za-z]+__[A-Za-z0-9_-]{5}$/.test(t)) return true; // CSS-modules localIdent
  const flat = t.replace(/[-_.:\s]/g, "");
  if (flat.length >= 8 && /\d/.test(flat) && /[a-z]/i.test(flat) && /^[a-z0-9]+$/i.test(flat)) {
    let flips = 0;
    for (let i = 1; i < flat.length; i++) if (/\d/.test(flat[i]) !== /\d/.test(flat[i - 1])) flips++;
    if (flips >= 4) return true; // random-looking token
  }
  return false;
}

/** True when the locator's identifying value (id, name, quoted attribute value, #id / .class token) is dynamic. */
export function locatorHasDynamic(by: string, value: string): boolean {
  if (by === "id" || by === "name") return isDynamicValue(value);
  if (by === "linkText" || by === "partialLinkText") return false;
  const parts: string[] = [];
  value.replace(/"([^"]*)"/g, (m, g) => { parts.push(g); return m; });
  value.replace(/'([^']*)'/g, (m, g) => { parts.push(g); return m; });
  value.replace(/[#.]([A-Za-z_][-\w]*)/g, (m, g) => { parts.push(g); return m; });
  return parts.some(isDynamicValue);
}
