import fs from "node:fs";
import path from "node:path";
import { buildIndex, indexIsStale, INDEX_FILE, LEAN_DIR } from "./index.js";

/** npm run changes cwd to the tool folder; INIT_CWD is where the user (or agent) ran it. */
export function userPath(p: string): string {
  return path.resolve(process.env.PAGESNAP_CWD || process.env.INIT_CWD || process.cwd(), p);
}

/**
 * A session folder path, or "latest": newest session-* under ./pageSnapshots
 * where the command was run, else under the tool folder (the capture default).
 */
export function resolveSession(arg: string): string {
  if (arg !== "latest") return userPath(arg);
  const roots = [...new Set([userPath("pageSnapshots"), path.resolve("pageSnapshots")])];
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    const dirs = fs.readdirSync(root).filter((d) => d.startsWith("session-") && fs.statSync(path.join(root, d)).isDirectory()).sort();
    if (dirs.length) return path.join(root, dirs[dirs.length - 1]);
  }
  throw new Error("No pageSnapshots/session-* folder found in " + roots.join(" or "));
}

/** Build lean/ when missing or older than a snapshot, keeping the embedder. */
export async function ensureIndex(dir: string): Promise<void> {
  if (!indexIsStale(dir)) return;
  let embedder: string | undefined;
  try {
    // read raw: an index from an older version still tells us the embedder
    embedder = (JSON.parse(fs.readFileSync(path.join(dir, LEAN_DIR, INDEX_FILE), "utf8")) as { embedder?: string }).embedder;
  } catch { /* first build */ }
  await buildIndex(dir, { embedder });
}
