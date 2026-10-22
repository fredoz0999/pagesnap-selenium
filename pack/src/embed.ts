/**
 * Embedders turn chunk text into vectors for similarity search.
 *
 * `hash` (default) is a dependency-free signed feature-hashing embedder over
 * words, light synonyms and character trigrams. It runs offline, is
 * deterministic, and handles the "sign in" vs "login" / "basket" vs "cart"
 * kind of mismatch well enough for UI text.
 *
 * `minilm` uses a real sentence-embedding model (all-MiniLM-L6-v2) through
 * @huggingface/transformers when that optional package is installed:
 *   npm i -D @huggingface/transformers
 * The model (~23 MB) downloads on first use and is cached.
 */

export interface Embedder {
  id: string;
  dim: number;
  embed(texts: string[]): Promise<number[][]>;
}

const STOP = new Set([
  "a", "an", "the", "and", "or", "to", "of", "in", "on", "for", "with", "is", "it", "be", "as", "at",
  "by", "that", "this", "then", "into", "from", "user", "should", "can", "i", "we", "you", "page", "step",
]);

/** Small UI-vocabulary synonym groups; each word maps to a canonical token. */
const SYN_GROUPS: string[][] = [
  ["login", "signin", "log", "logon", "sign", "authenticate"],
  ["logout", "signout", "logoff"],
  ["cart", "basket", "bag", "trolley"],
  ["checkout", "pay", "payment", "purchase", "buy"],
  ["email", "mail", "e-mail"],
  ["password", "passcode", "passwd", "pwd"],
  ["username", "userid", "login-name", "user-name"],
  ["search", "find", "lookup", "filter"],
  ["submit", "send", "continue", "proceed", "next", "confirm"],
  ["remove", "delete", "trash", "discard"],
  ["add", "insert", "create", "new"],
  ["menu", "hamburger", "nav", "navigation", "sidebar"],
  ["sort", "order", "orderby"],
  ["price", "cost", "amount", "total"],
  ["error", "alert", "warning", "invalid"],
  ["close", "dismiss", "cancel", "x"],
  ["zip", "postal", "postcode"],
  ["phone", "mobile", "tel", "telephone"],
];
const SYN = new Map<string, string>();
for (const g of SYN_GROUPS) for (const w of g) SYN.set(w, "syn:" + g[0]);

function stem(w: string): string {
  if (w.length > 5 && w.endsWith("ing")) return w.slice(0, -3);
  if (w.length > 4 && w.endsWith("ed")) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith("es") && !w.endsWith("ses")) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss")) return w.slice(0, -1);
  return w;
}

/** Words for BM25 / hashing: splits camelCase, kebab, snake, dots; drops stopwords. */
export function tokenize(text: string): string[] {
  const spaced = text
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_\-./#=:[\]{}()"'`|>*,;!?@]+/g, " ")
    .toLowerCase();
  const out: string[] = [];
  for (const w of spaced.split(/\s+/)) {
    if (!w || STOP.has(w) || w.length > 40) continue;
    out.push(stem(w));
  }
  return out;
}

/** tokens + canonical synonym tokens */
export function expand(tokens: string[]): string[] {
  const out = [...tokens];
  for (const t of tokens) {
    const s = SYN.get(t);
    if (s) out.push(s);
  }
  return out;
}

function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function normalize(v: number[]): number[] {
  let n = 0;
  for (const x of v) n += x * x;
  n = Math.sqrt(n) || 1;
  return v.map((x) => x / n);
}

export function cosine(a: number[], b: number[]): number {
  let s = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) s += a[i] * b[i];
  return s;
}

export class HashEmbedder implements Embedder {
  id = "hash-v1";
  constructor(public dim = 384) {}
  embedOne(text: string): number[] {
    const v = new Array<number>(this.dim).fill(0);
    const bump = (feat: string, w: number) => {
      const h = fnv1a(feat);
      v[h % this.dim] += (h & 0x80000000 ? -1 : 1) * w;
    };
    for (const t of expand(tokenize(text))) {
      bump("w:" + t, 1);
      if (!t.startsWith("syn:") && t.length >= 4) {
        const p = "^" + t + "$";
        for (let i = 0; i + 3 <= p.length; i++) bump("g:" + p.slice(i, i + 3), 0.35);
      }
    }
    return normalize(v);
  }
  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((t) => this.embedOne(t));
  }
}

export class MiniLmEmbedder implements Embedder {
  id = "minilm-l6-v2";
  dim = 384;
  private pipe: ((t: string[], o: object) => Promise<{ tolist(): number[][] }>) | null = null;
  async embed(texts: string[]): Promise<number[][]> {
    if (!this.pipe) {
      const modName = "@huggingface/transformers";
      let mod: { pipeline: (task: string, model: string) => Promise<unknown> };
      try {
        mod = (await import(modName)) as typeof mod;
      } catch {
        throw new Error("--embedder=minilm needs the optional package: npm i -D @huggingface/transformers");
      }
      this.pipe = (await mod.pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2")) as typeof this.pipe;
    }
    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += 32) {
      const res = await this.pipe!(texts.slice(i, i + 32), { pooling: "mean", normalize: true });
      out.push(...res.tolist());
    }
    return out;
  }
}

export function makeEmbedder(id?: string): Embedder {
  if (!id || id === "hash" || id === "hash-v1") return new HashEmbedder();
  if (id === "minilm" || id === "minilm-l6-v2") return new MiniLmEmbedder();
  throw new Error("Unknown embedder: " + id + " (use hash | minilm)");
}
