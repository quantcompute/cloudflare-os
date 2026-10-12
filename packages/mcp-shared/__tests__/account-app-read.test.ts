// Which name an app resource is read under, and what happens when none of them answers.
//
// A binding that renames sends `{prefix}{uri}`; an endpoint that does not rename answers the plain
// URI; one that decorates the URIs it advertises answers the name the server declared, decoration
// included. Which one applies is a property of the endpoint, so the read walks the list and stops at
// the first name that returns anything.

import { afterEach, describe, expect, it, vi } from "vitest";

import { McpAccountBase, type AccountEnv, type ConnectedServer } from "../src/account.js";
import { appTokenKey, type AppTokenRecord } from "../src/app-tokens.js";

const ENDPOINT = "https://mcp.example.com/mcp";
const PLAIN_URI = "ui://SuiteApps/app/index.html";
const DECLARED_URI = `${PLAIN_URI}?server_id=netsuite-sb1`;
// The binding's renamed name, tried first, and the resource's own `ui://` name, tried only after it
// (see `appResourceNames`). The decorated `DECLARED_URI` is never one of them.
const BINDING_URI = `netsuite-sb1_${PLAIN_URI}`;

function contextFor(values: Map<string, unknown>) {
 return {
  id: { toString: () => "account-id" },
  storage: {
   async deleteAlarm() { },
   async setAlarm() { },
   async deleteAll() { values.clear(); },
   kv: {
    get<T>(key: string) { return values.get(key) as T | undefined; },
    put<T>(key: string, value: T) { values.set(key, value); },
    delete(key: string) { values.delete(key); },
   },
  },
 };
}

const testLog = { with() { return testLog; }, info() { }, warn() { } };

// What the account under test logs, swapped per test. The file's cases run in order, so one field is
// enough to let a case read the lines its own call produced.
let activeLog: {
 with(fields?: Record<string, unknown>): unknown;
 info(...args: unknown[]): void;
 warn(...args: unknown[]): void;
} = testLog;

class AppAccount extends McpAccountBase<AccountEnv> {
 protected baseUrl(): string { return "https://gatekeeper.example"; }
 protected log(): never { return activeLog as never; }
 protected mintAccount(): never { throw new Error("not reached"); }
 protected override staticToken(): string | null { return null; }
}

/** A logger that records every line, so a test can assert on them. Child fields are inherited. */
function recordingLog() {
 const events: Array<{ message: string; fields: Record<string, unknown> }> = [];
 const make = (base: Record<string, unknown>) => ({
  info(message: string, fields: Record<string, unknown>) {
   events.push({ message, fields: { ...base, ...fields } });
  },
  warn(message: string, fields: Record<string, unknown>) {
   events.push({ message, fields: { ...base, ...fields } });
  },
  with(fields: Record<string, unknown>) { return make({ ...base, ...fields }); },
 });
 return { log: make({}), events };
}

/**
 * An account with one live app link and a connected endpoint, whose `resources/read` answers from
 * `answers` keyed by the URI asked for. `reads` is every URI the endpoint was asked to read, in
 * order. An answer of the form `{ error }` is relayed as a JSON-RPC error rather than a result, and
 * `resources/list` answers with `resources`.
 */
function accountWithReads(
 answers: Record<string, unknown>,
 log: typeof activeLog = testLog,
 resources: unknown[] = [],
) {
 activeLog = log;
 const values = new Map<string, unknown>();
 values.set("server", {
  endpoint: ENDPOINT,
  provenance: "deployment",
  auth: "none",
  serverId: "portal",
  serverName: "Portal",
 } satisfies ConnectedServer);
 values.set("mcpSessions", { "": "session" });
 const record: AppTokenRecord = {
  binding: {
   endpoint: ENDPOINT,
   serverName: "Portal / netsuite-sb1",
   scope: { serverId: "netsuite-sb1" },
   trust: "byo",
   resourceUriPrefix: "netsuite-sb1_",
  },
  uri: DECLARED_URI,
  createdAt: Date.now(),
  expiresAt: Date.now() + 60_000,
 };
 values.set(appTokenKey("tok"), record);

 const reads: string[] = [];
 vi.stubGlobal("fetch", async (_input: unknown, init?: RequestInit) => {
  const request = JSON.parse(String(init?.body));
  if (request.method === "resources/list") {
   return new Response(
    JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { resources } }),
    { status: 200, headers: { "Content-Type": "application/json" } });
  }
  reads.push(request.params?.uri as string);
  const answer = answers[request.params?.uri];
  if (answer !== null && typeof answer === "object" && "error" in answer) {
   return new Response(
    JSON.stringify({ jsonrpc: "2.0", id: request.id, error: answer.error }),
    { status: 200, headers: { "Content-Type": "application/json" } });
  }
  return new Response(
   JSON.stringify({ jsonrpc: "2.0", id: request.id, result: answer ?? { contents: [] } }),
   { status: 200, headers: { "Content-Type": "application/json" } });
 });
 return { account: new AppAccount(contextFor(values) as never, {}), reads };
}

// The document an endpoint answers a read with. Only a `ui://` URI is retained by the client, which
// is what the names below are for: the one a read is addressed by, not the one the endpoint answers
// under.
const document = {
 contents: [{ uri: PLAIN_URI, mimeType: "text/html;profile=mcp-app", text: "<html>app</html>" }],
};

afterEach(() => vi.unstubAllGlobals());

describe("reading an app's own resource", () => {
 it("reads the name the binding serves the resource by, and opens the document", async () => {
  const { account, reads } = accountWithReads({ [BINDING_URI]: document });

  const view = await account.openAppView("tok");

  expect("refusal" in view).toBe(false);
  expect(reads).toEqual([BINDING_URI]);
 });

 it("opens a document the endpoint answered under its own namespaced uri", async () => {
  // A portal echoes the name it fronts the resource under. The item's URI is the server's to
  // choose, so the document is rendered rather than discarded for not being the `ui://` name.
  const { account, reads } = accountWithReads({
   [BINDING_URI]: {
    contents: [{
     uri: BINDING_URI, mimeType: "text/html;profile=mcp-app", text: "<html>app</html>",
    }],
   },
  });

  const view = await account.openAppView("tok");

  expect(reads).toEqual([BINDING_URI]);
  expect(view).toMatchObject({ html: "<html>app</html>" });
 });

 it("never reads the resource's own ui:// name once a prefix is declared", async () => {
  // The endpoint serves the resource only under the prefixed name; the unprefixed one is a request
  // it has already answered with `Resource not found`, not a second chance.
  const { account, reads } = accountWithReads({
   [PLAIN_URI]: document,
   [BINDING_URI]: { error: { code: -32602, message: "Resource not found" } },
  });

  const view = await account.openAppView("tok");

  expect("refusal" in view).toBe(true);
  expect(reads).toEqual([BINDING_URI]);
  expect(reads).not.toContain(PLAIN_URI);
  expect(reads).not.toContain(DECLARED_URI);
 });

 it("logs a read that answered with no document, and what the endpoint serves", async () => {
  // A result this host will not render is logged whole, so it is told apart from an empty answer;
  // the body itself never reaches the log. The endpoint is then asked what it does publish.
  const { log, events } = recordingLog();
  const { account } = accountWithReads({
   [BINDING_URI]: {
    contents: [{ uri: BINDING_URI, mimeType: "text/plain", text: "not a document" }],
   },
  }, log, [{ uri: "ui://SuiteApps/com.netsuite.mcpstandardtools/reports/mcp-app.html" }]);

  const view = await account.openAppView("tok");

  expect("refusal" in view).toBe(true);
  const skipped = events.find(event => event.fields.event === "app.resource.name.not-a-document");
  expect(skipped?.fields).toMatchObject({
   resourceUri: BINDING_URI,
   appContentCount: 1,
   appContentItems: `${BINDING_URI} (text/plain, 14 bytes)`,
   appResponseBytes: expect.any(Number),
  });
  expect(JSON.stringify(skipped?.fields)).not.toContain("not a document");
  const listed = events.find(event => event.fields.event === "app.resource.list");
  expect(listed?.fields).toMatchObject({
   resourceUri: BINDING_URI,
   appResourceCount: 1,
   appResourceNames: "ui://SuiteApps/com.netsuite.mcpstandardtools/reports/mcp-app.html",
  });
  const unusable = events.find(event => event.fields.event === "app.resource.unusable");
  expect(unusable?.fields).toMatchObject({
   appContentCount: 1, appResponseBytes: expect.any(Number),
  });
 });

 it("records the exact URI it passed when the read is refused", async () => {
  const { log, events } = recordingLog();
  const { account } = accountWithReads({
   [BINDING_URI]: { error: { code: -32602, message: "Resource not found" } },
  }, log, [{ uri: "ui://SuiteApps/com.netsuite.mcpstandardtools/reports/mcp-app.html" }]);

  const view = await account.openAppView("tok");

  expect("refusal" in view).toBe(true);
  const failed = events.find(event => event.fields.event === "app.resource.name.failed");
  expect(failed?.fields).toMatchObject({ resourceUri: BINDING_URI });
  const listed = events.find(event => event.fields.event === "app.resource.list");
  expect(listed?.fields).toMatchObject({ resourceUri: BINDING_URI, appResourceCount: 1 });
 });
});
