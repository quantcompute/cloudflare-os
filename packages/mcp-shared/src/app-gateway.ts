// The JSON-RPC endpoint an open sidecar page talks to: one message in, one reply out.
//
// It is pure on purpose -- no Durable Object, no storage, no environment -- so the whole of the
// policy an app is subject to is in this file and can be exercised without a Worker. The policy
// exists because a sidecar window has no approval queue: anything a person would have had to approve
// in the chat is refused here with a sentence telling them to ask the agent, and what gets refused
// is decided by this binding's own classification, never by anything the app or the server can
// influence. An app therefore never gets a write, never gets a tool outside the grant, and never
// gets a tool the server reserved for the agent.
//
// Nothing thrown below is allowed to leave: every failure, including one this deployment caused, is
// framed as a JSON-RPC error the app can read.
//
// One request is answered elsewhere on purpose. `ui/message` -- the app asking to put text into the
// conversation that opened its link -- is delivered by the account from the subscription the user
// enabled for that link, which is storage and not this module's business; the account answers that
// request itself and hands everything else to `answerAppRpc` (see `callApp` in `account.ts`).

import {
  APP_ERROR_NOT_PERMITTED,
  clampAppResult,
  isUiUri,
  toolVisibleToApp,
  type AppRpcReply,
} from "./apps.js";
import { isValidToolName, type McpClient } from "./client.js";
import type { WithClientOptions } from "./connection.js";
import type { ClassifiedTool } from "./tools.js";
import { safeServerText } from "./util.js";

/** What the app gateway needs from the binding it is answering for. */
export interface AppGatewayHost {
  /**
   * The granted tool, if this binding exposes it to apps at all.
   *
   * Scope is this method's business, since the gateway has none of its own: whatever it returns is
   * taken to be a tool the app is entitled to call.
   */
  findTool(name: string): Promise<ClassifiedTool | undefined>;
  /**
   * The URI this binding reads one app resource by, given the name the window asked for.
   *
   * A portal renames the resources it fronts, so the name an app knows its own document by is not
   * always the name the endpoint answers to; this is only how the read is addressed.
   */
  resourceUri(uri: string): string;
  /** Runs `fn` against an initialized client for this binding's endpoint. */
  call<T>(fn: (client: McpClient) => Promise<T>, options?: WithClientOptions): Promise<T>;
}

/**
 * JSON-RPC 2.0 framing codes. Spelled out rather than imported: they are part of this endpoint's own
 * contract with the app, which switches on them.
 */
export const RPC_PARSE_ERROR = -32700;
export const RPC_INVALID_REQUEST = -32600;
export const RPC_METHOD_NOT_FOUND = -32601;
export const RPC_INVALID_PARAMS = -32602;
export const RPC_INTERNAL_ERROR = -32603;

/** One JSON-RPC request, once the envelope around it is known to be one. */
export type AppRpcRequest = {
  id: JsonRpcId;
  method: string;
  params: unknown;
};

/**
 * One message, read as far as its envelope: a request to dispatch, or the framing reply that says
 * why it is not one.
 *
 * The split exists because `/rpc` answers `ui/message` itself. Delivery needs the subscription
 * registered for the link -- storage, which is not this module's business -- so the account reads
 * the envelope first, delivers there, and hands everything else to `answerAppRpc`.
 */
export type AppRpcRead =
  | ({ ok: true } & AppRpcRequest)
  | { ok: false; reply: AppRpcReply };

/**
 * Reads the JSON-RPC envelope of one message. Framing only: what a method means is decided by
 * whoever answers it, and nothing here throws.
 */
export function readAppRpc(message: unknown): AppRpcRead {
  let parsed = message;
  if (typeof message === "string") {
    try {
      parsed = JSON.parse(message);
    } catch {
      // Nothing parsed, so there is no id to echo; JSON-RPC requires null in that position.
      return {
        ok: false,
        reply: appRpcFailure(null, RPC_PARSE_ERROR, "The request was not valid JSON."),
      };
    }
  }

  const request = record(parsed);
  const id = request !== undefined && "id" in request ? jsonRpcId(request.id) : undefined;
  if (request?.jsonrpc !== "2.0" || typeof request.method !== "string" || id === undefined) {
    // A notification (no id) is answered the same way as a malformed request. This endpoint only
    // serves requests, and the honest reply to something that expects none is that it is not one.
    return {
      ok: false,
      reply: appRpcFailure(id ?? null, RPC_INVALID_REQUEST, "Not a JSON-RPC 2.0 request."),
    };
  }
  return { ok: true, id, method: request.method, params: request.params };
  }

/** Answers one JSON-RPC message from a sidecar page. Never throws for a caller error. */
export async function appRpcReply(message: unknown, host: AppGatewayHost): Promise<AppRpcReply> {
  return await answerAppRpc(readAppRpc(message), host);
}

/** Answers one message already read as far as its envelope (see `readAppRpc`). */
export async function answerAppRpc(read: AppRpcRead, host: AppGatewayHost): Promise<AppRpcReply> {
  if (!read.ok) return read.reply;
  const { id, method, params } = read;
  try {
    switch (method) {
      case "ping":
        return appRpcSuccess(id, {});
      case "tools/call":
        return await callTool(id, params, host);
      case "resources/read":
        return await readResource(id, params, host);
      default:
        return appRpcFailure(id, RPC_METHOD_NOT_FOUND, `Unknown method "${quoted(method)}".`);
    }
  } catch (err) {
    // The failure is this deployment's or the server's, and the app gets a sentence rather than a
    // stack: letting it throw would reach the app as an HTTP 500 it has no convention for.
    return appRpcFailure(id, RPC_INTERNAL_ERROR, failureMessage(err));
  }
}

/**
 * The text one `ui/message` request asks this host to deliver, or undefined when it is not a message
 * this host can carry.
 *
 * The specification's request is a user message made of content blocks, and this host delivers text
 * blocks only: a request that is not a user message, that names any other kind of block, or that
 * carries no text at all is refused rather than delivered with its other parts dropped silently.
 * Text blocks are joined in order, blank-line separated, which is how several blocks read as the one
 * message.
 */
export function appViewMessageText(params: unknown): string | undefined {
  const request = record(params);
  if (request?.role !== "user" || !Array.isArray(request.content) || request.content.length === 0) {
    return undefined;
  }
  const parts: string[] = [];
  for (const block of request.content) {
    const content = record(block);
    if (content?.type !== "text" || typeof content.text !== "string") return undefined;
    parts.push(content.text);
  }
  const text = parts.join("\n\n");
  // Nothing to deliver: a blank message would land in the conversation as an empty turn.
  return text.trim() === "" ? undefined : text;
}

/**
 * Longest idempotency key this host accepts from a sender. The key names one delivery in the
 * conversation's records, so it is bounded before it travels; the page's own keys are 32 hex
 * characters, well inside it.
 */
const MAX_APP_VIEW_MESSAGE_KEY_CHARS = 128;

/**
 * What a `ui/message` request said about the key its delivery should be recognised by.
 *
 * - `chosen`: the sender picked this key, and it is one this host will pass on;
 * - `absent`: the sender picked nothing (or an empty string, which names nothing), so the caller
 *   mints one instead;
 * - `invalid`: the sender picked something unusable -- not a string, over the bound, or carrying a
 *   control character -- and the request is refused rather than delivered under a different
 *   identity than the one its own retries would use.
 */
export type AppViewMessageKeyChoice =
  | { kind: "chosen"; key: string }
  | { kind: "absent" }
  | { kind: "invalid" };

/**
 * Reads the idempotency key a `ui/message` request chose for its delivery.
 *
 * The page generates one when it stages a send and carries it on the POST, so a repeat of that same
 * request is the same delivery: the conversation records the key it applied and drops the retry.
 * A request that chose nothing is delivered under a key the caller mints (a hand-rolled host that
 * talks to `/rpc` directly need not know about any of this).
 */
export function appViewMessageKey(params: unknown): AppViewMessageKeyChoice {
  const key = record(params)?.key;
  if (key === undefined || key === "") return { kind: "absent" };
  if (typeof key !== "string" || key.length > MAX_APP_VIEW_MESSAGE_KEY_CHARS) {
    return { kind: "invalid" };
  }
  for (let index = 0; index < key.length; index++) {
    const code = key.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return { kind: "invalid" };
  }
  return { kind: "chosen", key };
}

// One app call, under the whole of the app policy: granted, classified `read`, and offered to apps.
//
// The retry is on: every tool that gets this far is a read, which is exactly what `withClient`'s
// re-initialize-and-retry is safe for. The chat path turns it off only for a write that may already
// have taken effect, and no write reaches here.
async function callTool(
  id: JsonRpcId,
  params: unknown,
  host: AppGatewayHost,
): Promise<AppRpcReply> {
  // Params that are absent or unreadable are the same as empty ones: either way there is no tool
  // name, which is what the check below reports.
  const request = record(params) ?? {};
  const name = request.name;
  if (!isValidToolName(name)) {
    return appRpcFailure(id, RPC_INVALID_PARAMS, '"tools/call" needs a tool name.');
  }
  const args = record(request.arguments);
  if (request.arguments !== undefined && args === undefined) {
    return appRpcFailure(id, RPC_INVALID_PARAMS, '"tools/call" arguments must be an object.');
  }

  const entry = await host.findTool(name);
  if (!entry) return notPermitted(id, name, "this binding does not grant it");
  if (entry.mode !== "read") return notPermitted(id, name, "it is not a read-only tool");
  if (!toolVisibleToApp(entry.tool)) {
    return notPermitted(id, name, "the server did not offer it to apps");
  }

  const result = await host.call(
    client => client.callTool(name, args ?? {}), { retryOnExpiry: true });
  return appRpcSuccess(id, clampAppResult(result));
}

// A window may read a `ui://` resource and nothing else, for the same reason it may call a read and
// nothing else: it exists to render one app, and every other resource on the endpoint belongs to the
// conversation the window is not part of. What it asks for is the resource's own name; the name that
// reaches the endpoint is the binding's (`resourceUri`).
async function readResource(
  id: JsonRpcId,
  params: unknown,
  host: AppGatewayHost,
): Promise<AppRpcReply> {
  const uri = record(params)?.uri;
  if (typeof uri !== "string" || uri.length === 0) {
    return appRpcFailure(id, RPC_INVALID_PARAMS, '"resources/read" needs a uri.');
  }
  if (!isUiUri(uri)) {
    return appRpcFailure(id, APP_ERROR_NOT_PERMITTED,
      "This window can only read ui:// resources. Ask the agent in the chat for anything else.");
  }

  const contents = await host.call(
    client => client.readResource(host.resourceUri(uri)),
    { retryOnExpiry: true },
  );
  // MCP-shaped, because the View is an MCP client, and only the three fields one reads: the CSP the
  // resource declared was applied when the page was built and is the host's business.
  return appRpcSuccess(id, {
    contents: contents.map(content => ({
      uri: content.uri, mimeType: content.mimeType, text: content.text,
    })),
  });
}

// The refusal an app gets for anything it is not allowed to do, phrased for the person reading the
// window: a bare "forbidden" would leave them with no idea that the chat can still do it.
function notPermitted(id: JsonRpcId, name: string, reason: string): AppRpcReply {
  return appRpcFailure(id, APP_ERROR_NOT_PERMITTED,
    `"${quoted(name)}" cannot be called from here: ${reason}. ` +
    "Ask the agent in the chat to run it.");
}

/** A JSON-RPC id, as the reply echoes it back. */
export type JsonRpcId = string | number | null;

// Only a string or a number identifies a request. Anything else -- an object, an explicit null, or a
// notification's absent id -- leaves nothing to echo, so the reply carries null.
function jsonRpcId(value: unknown): JsonRpcId | undefined {
  return typeof value === "string" || typeof value === "number" ? value : undefined;
}

/**
 * Both reply shapes are HTTP 200, including a failure: framing errors belong to the JSON-RPC layer,
 * so the route above stays a transport and the View reads `error` out of the body rather than from a
 * status code it has no convention for.
 */
export function appRpcSuccess(id: JsonRpcId, result: unknown): AppRpcReply {
  return { body: JSON.stringify({ jsonrpc: "2.0", id, result }), status: 200 };
}

/** The same serialization for a failure, under one of the framing codes above. */
export function appRpcFailure(id: JsonRpcId, code: number, message: string): AppRpcReply {
  return { body: JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }), status: 200 };
}

// The connector's own errors are already written for a person ("The MCP server rejected this
// connection's credentials. Please reconnect the account."), so one is passed through the shaping
// every server-quoted string gets. Anything else gets this deployment's own sentence.
function failureMessage(err: unknown): string {
  const message = err instanceof Error ? safeServerText(err.message) : undefined;
  return message ?? "This window could not complete the request.";
}

// Names and methods reach error messages from the app and from the server, so each is shaped before
// it is quoted: an unbounded or multi-line value would forge the rest of the message.
function quoted(value: string): string {
  return safeServerText(value) ?? "unknown";
}

// Untrusted JSON arrives as `unknown` at every entry point here -- a parsed body, params, arguments
// -- so one narrowing serves them all.
function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}
