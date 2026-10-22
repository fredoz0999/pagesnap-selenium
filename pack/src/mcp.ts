#!/usr/bin/env node
/**
 * PageSnap MCP server (stdio). Exposes the lean pack as native agent tools so
 * Copilot / Claude Code call them directly instead of shelling out.
 *
 * VS Code (.vscode/mcp.json):
 *   { "servers": { "pagesnap": { "command": "npm", "args": ["--prefix", "/path/to/pagesnap-selenium", "run", "-s", "mcp"],
 *     "env": { "PAGESNAP_CWD": "${workspaceFolder}" } } } }
 * Claude Code:
 *   claude mcp add pagesnap -e PAGESNAP_CWD="$PWD" -- npm --prefix /path/to/pagesnap-selenium run -s mcp
 *
 * Zero dependencies: newline-delimited JSON-RPC 2.0 per the MCP stdio transport.
 * Relative paths resolve against PAGESNAP_CWD (your test repo), else INIT_CWD / cwd.
 */
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { buildIndex, LEAN_DIR, queryIndex } from "./index.js";
import { ensureIndex, resolveSession, userPath } from "./paths.js";

export const PROTOCOL_VERSION = "2025-06-18";

type Args = Record<string, unknown>;
interface Tool {
  name: string;
  description: string;
  inputSchema: object;
  run(a: Args): Promise<{ text: string; isError?: boolean }>;
}

const session = { type: "string", description: "Session folder (absolute or relative to the repo) or \"latest\"" };
const str = (a: Args, k: string): string | undefined => (typeof a[k] === "string" && (a[k] as string).trim() ? String(a[k]) : undefined);
const num = (a: Args, k: string): number | undefined => (typeof a[k] === "number" ? (a[k] as number) : undefined);
const need = (a: Args, k: string): string => {
  const v = str(a, k);
  if (!v) throw new Error("missing required argument: " + k);
  return v;
};

export const TOOLS: Tool[] = [
  {
    name: "pagesnap_overview",
    description: "Start here. Session flow (steps + notes) and lean pack summary for a PageSnap capture session. Small.",
    inputSchema: { type: "object", properties: { session }, required: ["session"] },
    async run(a) {
      const dir = resolveSession(need(a, "session"));
      await ensureIndex(dir);
      const read = (f: string) => (fs.existsSync(f) ? fs.readFileSync(f, "utf8").trim() : "");
      return { text: [read(path.join(dir, "flow.md")), read(path.join(dir, LEAN_DIR, "PACK.md"))].filter(Boolean).join("\n\n") + "\nSession: " + dir + "\n" };
    },
  },
  {
    name: "pagesnap_query",
    description: "Token-lean lookup of the captured UI for one test step: page outline + the few relevant regions with verified locators (after =>). Use diff=true with step to skip regions unchanged since the previous step.",
    inputSchema: {
      type: "object",
      properties: {
        session,
        query: { type: "string", description: "The step text, e.g. the flow.md note" },
        step: { type: "integer", description: "Restrict to this capture step" },
        diff: { type: "boolean", description: "Omit regions unchanged since step-1 on the same page" },
        k: { type: "integer", description: "Max regions (default 4)" },
      },
      required: ["session", "query"],
    },
    async run(a) {
      const dir = resolveSession(need(a, "session"));
      await ensureIndex(dir);
      const r = await queryIndex(dir, need(a, "query"), { step: num(a, "step"), k: num(a, "k"), diff: a.diff === true });
      return { text: r.text };
    },
  },
  {
    name: "pagesnap_build",
    description: "Rebuild the lean pack (compact snapshots, index, prompts) after new captures. Query/overview do this automatically when stale.",
    inputSchema: { type: "object", properties: { session }, required: ["session"] },
    async run(a) {
      const idx = await buildIndex(resolveSession(need(a, "session")));
      return { text: "Built: " + idx.pages.length + " pages, " + idx.stats.chunkCount + " chunks, ~" + idx.stats.rawTokens + " -> ~" + idx.stats.compactTokens + " tokens\n" };
    },
  },
];

interface Req { jsonrpc: "2.0"; id?: number | string | null; method: string; params?: Record<string, unknown> }

export async function handle(req: Req): Promise<object | null> {
  const reply = (result: object) => ({ jsonrpc: "2.0", id: req.id ?? null, result });
  const fail = (code: number, message: string) => ({ jsonrpc: "2.0", id: req.id ?? null, error: { code, message } });
  switch (req.method) {
    case "initialize":
      return reply({
        protocolVersion: typeof req.params?.protocolVersion === "string" ? req.params.protocolVersion : PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: "pagesnap", version: "1.1.0" },
        instructions: "PageSnap lean pack. Call pagesnap_overview first, then pagesnap_query per test step (Selenium Java: map each `=>` locator to a By.*). Never read every NN_*.yaml.",
      });
    case "ping":
      return reply({});
    case "tools/list":
      return reply({ tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
    case "tools/call": {
      const name = String(req.params?.name ?? "");
      const tool = TOOLS.find((t) => t.name === name);
      if (!tool) return fail(-32602, "Unknown tool: " + name);
      try {
        const r = await tool.run((req.params?.arguments as Args) ?? {});
        return reply({ content: [{ type: "text", text: r.text }], isError: !!r.isError });
      } catch (e) {
        return reply({ content: [{ type: "text", text: "Error: " + (e instanceof Error ? e.message : String(e)) }], isError: true });
      }
    }
    default:
      if (req.id === undefined) return null; // notification (e.g. notifications/initialized)
      return fail(-32601, "Method not found: " + req.method);
  }
}

export function serve(input: NodeJS.ReadableStream = process.stdin, output: NodeJS.WritableStream = process.stdout): void {
  const rl = readline.createInterface({ input });
  // Tool calls may be slow (verify); answer in order of completion, each line is self-contained.
  rl.on("line", async (line) => {
    if (!line.trim()) return;
    let req: Req;
    try {
      req = JSON.parse(line);
    } catch {
      output.write(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }) + "\n");
      return;
    }
    const res = await handle(req);
    if (res) output.write(JSON.stringify(res) + "\n");
  });
}

const isMain = process.argv[1] && /mcp\.(ts|js)$/.test(process.argv[1]);
if (isMain) serve();
