// Base types for MCP-server sessions.
//
// These are prepended to every generated per-server `.d.ts` (see `schema-to-ts.ts`), so a workspace's
// coding agent always has them in scope. One method per tool and `callTool` overloads are generated
// from the server's own tool catalog and appended below this file's contents.

import type { RpcStub } from "cloudflare:workers";

/** A block of content returned by an MCP tool. */
export type McpContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string }
  | { type: "audio"; data: string; mimeType: string }
  | { type: "resource_link"; uri: string; name?: string; description?: string; mimeType?: string }
  | { type: "resource"; resource: { uri: string; mimeType?: string; text?: string; blob?: string } };

/**
 * Outcome of `callTool` or `getActionResult`.
 *
 * Read-only tools resolve to `"ok"` straight away. Everything else is an action: it is queued for
 * approval and resolves to `"pending"`, then to `"ok"`, `"rejected"`, or `"failed"`.
 */
export type McpCallResult =
  | {
      status: "ok";
      /** Content blocks as returned by the server. */
      content: McpContent[];
      /** All text blocks concatenated, for the common case where that is all you need. */
      text: string;
      /** Present when the tool declares an output schema and returned structured data. */
      structuredContent?: unknown;
      /** True when the tool itself reported failure (the call succeeded; the tool did not). */
      isError?: boolean;
      /**
       * Present when this result has an interactive view. **Before you relay `url` to the user you
       * MUST call `subscribeAppMessages(url, self)` in this same turn, passing `url` exactly as it
       * appears here -- it is the only value that call accepts, and a link you shorten, re-host or
       * replace with `uri` is refused.** Until the link is subscribed the view cannot send anything
       * back into this conversation: a person who opens a link that was never subscribed can pick a
       * prompt and have nothing arrive, and nothing tells them why. Opening `url` renders the same
       * result in a sidecar window, with live access to this server's read-only tools.
       */
      app?: {
        /** The `ui://` resource that renders this result. */
        uri: string;
        /**
         * Link to open, and the exact string `subscribeAppMessages` takes: pass it as written.
         * Single-use-free and reusable while the account stays connected.
         */
        url: string;
        /** Display name for the link, when the server gave one. */
        title?: string;
      };
    }
  | {
      status: "pending";
      /** Pass to `getActionResult` to collect the outcome once it has been decided. */
      actionId: number;
      /** Human-readable explanation to relay to the user. */
      message: string;
    }
  | {
      status: "rejected";
      /** Why the action was not performed. */
      message: string;
    }
  | {
      status: "failed";
      /** The approved call failed. Its message says whether it may have taken effect. */
      message: string;
    };

/** One message an app view asked its host to put into the conversation that opened its link. */
export type McpAppMessage = {
  /** The `ui://` resource whose view sent this message. */
  uri: string;
  /** The message body, exactly as the app wrote it. */
  text: string;
  /** The sender's idempotency key. Delivery is at-least-once, so key your work on it. */
  key: string;
};

/**
 * What `subscribeAppMessages` delivers into: one method, called once per message the app's view
 * sent, after the person using the app agreed to send it.
 *
 * `self` already satisfies this -- a call to any method on `self` lands in this chat as a callback --
 * so an agent normally passes `self` and defines nothing of its own. The callback's one argument is
 * the `McpAppMessage` above.
 */
export interface McpAppMessageHook {
  receiveAppMessage(message: McpAppMessage): Promise<void>;
}

/** How this deployment classified one tool. */
export type McpToolMode =
  // Returns data immediately; every call is recorded as an observation.
  | "read"
  // Queued for approval before it runs.
  | "action";

/** Description of one tool exposed by the session. */
export type McpToolInfo = {
  /** Tool name, as passed to `callTool`. The generated method name is derived from it. */
  name: string;
  /** Display title, if the server supplied one. */
  title?: string;
  /** The server's own description of the tool. */
  description?: string;
  /** Whether calls are observations or approval-gated actions. */
  mode: McpToolMode;
  /**
   * Why the tool was classified this way: `"server-annotation"` when the server's own
   * `readOnlyHint` decided it, `"default"` when nothing was declared and it was treated as an
   * action. Recorded so an audit can find every call that was trusted on the server's word.
   */
  classifiedBy: "server-annotation" | "default";
  /** JSON Schema for the tool's arguments when it fits the connector's definition budget. */
  inputSchema?: unknown;
};

/** Bounded search result. Request the exact name through `listTools({ name })` for its schema. */
export type McpToolSummary = Omit<McpToolInfo, "inputSchema">;

/** Progressive catalog lookup through the existing `listTools` session method. */
export type McpToolListOptions =
  | { search: string; name?: never }
  | { name: string; search?: never };
