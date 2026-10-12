import { afterEach, describe, expect, it, vi } from "vitest";

import { scopedCatalog, type CatalogRequest, type CatalogStore } from "../src/catalog.js";
import type { ConnectionAccount } from "../src/connection.js";
import type { McpLog } from "../src/log.js";
import type { ToolScope } from "../src/scope.js";

afterEach(() => vi.unstubAllGlobals());

// Enough of a logger for a path that only logs a changed or unrefreshable catalog; neither happens
// here, and `with` keeps the same object because nothing reads the fields back.
const log: McpLog = {
  debug() {}, info() {}, warn() {}, error() {},
  with() { return log; },
};

// What a Code Mode request is answered with, and the claims a portal may attach to it. The execute
// tool is marked read-only on purpose: a sandbox that can call every upstream tool is the one thing
// whose self-description must not decide whether its calls need approval.
const CODEMODE_TOOLS = [
  { name: "portal_codemode_search" },
  {
    name: "portal_codemode_execute",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  },
];

// Answers one portal's every request with `tools`, remembering the URL each one arrived at.
function stubPortal(tools: unknown[]): Array<{ url: string; method: string }> {
  const requests: Array<{ url: string; method: string }> = [];
  vi.stubGlobal("fetch", async (input: unknown, init?: RequestInit) => {
    const body: { id: number; method: string } = JSON.parse(String(init?.body));
    requests.push({ url: String(input), method: body.method });
    if (body.method === "initialize") {
      return Response.json({ jsonrpc: "2.0", id: body.id, result: {} });
    }
    if (body.method === "tools/list") {
      return Response.json({ jsonrpc: "2.0", id: body.id, result: { tools } });
    }
    return new Response(null, { status: 202 });
  });
  return requests;
}

const account: ConnectionAccount = {
  async getConnection() {
    return { authorization: null, sessionId: null, generation: 1 };
  },
  async assertConnectionCurrent() {},
  async setMcpSessionId() { return true; },
  async noteCredentialsExpired() {},
};

function requestFor(scope: ToolScope): CatalogRequest {
  const values = new Map<string, unknown>();
  const store: CatalogStore = {
    get: <T,>(key: string) => values.get(key) as T | undefined,
    put: <T,>(key: string, value: T) => { values.set(key, value); },
  };
  return {
    store,
    log,
    env: {},
    account,
    endpoint: "https://portal.example.com/mcp",
    scope,
    trust: "vetted",
  };
}

describe("scopedCatalog", () => {
  it("asks with the mode and classifies a Code Mode grant's own pair", async () => {
    const requests = stubPortal(CODEMODE_TOOLS);

    const catalog = await scopedCatalog(requestFor({ codeMode: "search_and_execute" }));

    expect(catalog.isPortal).toBe(true);
    expect(catalog.tools.map(entry => ({
      name: entry.tool.name, mode: entry.mode, autoApprovable: entry.autoApprovable,
    }))).toEqual([
      { name: "portal_codemode_search", mode: "read", autoApprovable: false },
      { name: "portal_codemode_execute", mode: "action", autoApprovable: false },
    ]);
    // The mode travels on every request: the portal lists its pair only for the URL that asks.
    expect(requests.filter(r =>
      r.url !== "https://portal.example.com/mcp?codemode=search_and_execute")).toEqual([]);
    expect(requests.length).toBeGreaterThan(0);
  });

  it("sends a plain scope to the bare endpoint, where the same claims are honoured", async () => {
    const requests = stubPortal(CODEMODE_TOOLS);

    const catalog = await scopedCatalog(requestFor({}));

    // Nothing in this listing identifies a portal, so the tools are read as a plain server's and
    // classified by their annotations -- the trade this deployment accepts everywhere except a
    // sandbox that can reach every upstream tool.
    expect(catalog.isPortal).toBe(false);
    expect(catalog.tools.map(entry => ({
      name: entry.tool.name, mode: entry.mode, classifiedBy: entry.classifiedBy,
    }))).toEqual([
      { name: "portal_codemode_search", mode: "action", classifiedBy: "default" },
      { name: "portal_codemode_execute", mode: "read", classifiedBy: "server-annotation" },
    ]);
    expect(requests.filter(r => r.url.includes("codemode"))).toEqual([]);
  });
});
