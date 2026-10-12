// The field vocabulary both MCP connectors log against, so the two produce identically-named,
// queryable fields. Typed rather than `Record<string, unknown>` so that `ReservedLogField` makes
// `token`, `secret`, and `prompt` unloggable in a package that holds OAuth tokens.

import type { Logger } from "@gadgets/observability/logger";
import type { ServerTrust } from "./tools.js";

/** Fields an MCP connector may attach to a log line, beyond the reserved ones every logger has. */
export type McpLogFields = {
 /** The gatekeeper's vendor id, set once on the module logger. */
 vendorId: string;
 /** Display slug of the connected server, or of the upstream server a grant is scoped to. */
 serverId: string;
 /** Endpoint host only. The path may encode tenant identifiers, so it is never logged. */
 serverHost: string;
 toolName: string;
 /**
  * The name a tool call reached the endpoint under, when it differs from `toolName`: a binding that
  * fronts a renaming endpoint (a portal serves `{serverId}_{tool}`) resolves the window's own name
  * to the endpoint's, and this is the endpoint's. Absent when the two coincide.
  */
 appToolName: string;
 actionId: number;
 toolCount: number;
 catalogRevision: string;
 /** The tier in force for the operation, read from configuration at the time it ran. */
 trust: ServerTrust;
 /** Who chose the endpoint. Distinguishes a user-supplied server from a deployment's own gateway. */
 provenance: "user" | "deployment";
 /**
  * The `ui://` resource an app-surface event is about. Server-chosen, and not a secret: it names a
  * resource, not the link that opens it.
  */
 appUri: string;
 /** The CSP a sidecar app's document is actually served under, for security review of its reach. */
 appCsp: string;
 /** The `allow` attribute the app's frame actually got, when its resource declared permissions. */
 appAllow: string;
 /** JSON-RPC error code from a failed call, when the failure carried one. */
 errorCode: number;
 /**
  * A failed call's JSON-RPC `data` member, JSON-serialized, when the server sent one. A portal
  * reports an upstream failure here (`is_upstream`, `cause`), which the message alone does not.
  */
 errorData: string;
 /**
  * The URI this binding addresses the resource by, logged beside `appUri` whenever a link is minted
  * or read, because those differ for a binding that renames resources: a portal namespaces them
  * (`{serverId}_{uri}`), so a read that failed or a link that will not open names nothing an
  * operator can check after the fact without the name it went out under.
  */
 resourceUri: string;
 /**
  * Which name a resource read went out under, when a binding has more than one for it: the resource's
  * own `ui://` name (`appUri`, tried first) or the binding's renamed name (`resourceUri`, the
  * fallback). A link that opens on one portal and refuses on another is only explicable with this.
  */
 appResourceName: string;
 /**
  * How many resource items a read returned. A count of zero is a successful read the server answered
  * with nothing, which is what tells "the resource is not there" apart from "the read failed".
  */
 appContentCount: number;
 /**
  * The URIs the items of a `resources/read` answer carried, joined. The server's own name for what it
  * returned, which differs from the name asked for when an endpoint fronts resources under a prefix.
  */
 appContentUris: string;
 /**
  * A bounded description of the items a `resources/read` answered with when none of them was a
  * document this host renders: each item's URI, media type and body size, joined. It is the result of
  * the call as the host read it -- the body itself is never logged -- so a read that returned
  * something unusable is told apart from one that returned nothing.
  */
 appContentItems: string;
 /**
  * The byte length of the reply a `resources/read` call returned, whether or not it carried a
  * document. A read that answered with nothing this host can render is otherwise indistinguishable
  * from a transport hiccup, and this number tells a tiny empty answer from a large unusable one.
  */
 appResponseBytes: number;
 /**
  * TEMPORARY (remove): each item of a `resources/read` answer that was not an app document, dumped
  * as its declared media type and a prefix of its body. `appContentItems` names a type and a size but
  * never the body, so it cannot show why a read the endpoint served as a document did not read as
  * one. Exists only to diagnose that mismatch and goes with the log line that emits it.
  */
 appContentSample: string;
 /**
  * TEMPORARY (remove): the media type of a `resources/read` reply and a bounded head of its raw
  * body, logged beside a read that produced no usable document. `appResponseBytes` says how large
  * the reply was but never what arrived, so an answer whose document was dropped by a size check,
  * or framed in a way this client did not expect, cannot be told apart from one that carried
  * nothing. Goes with the log line that emits it.
  */
 wireContentType: string;
 wireHead: string;
 /**
  * TEMPORARY (remove): every item of the raw `resources/read` result before this client filtered
  * it -- URI, declared media type, decoded body size and, for a discarded item, why. The
  * post-filter fields are empty exactly when this is the only evidence there is.
  */
 appWireItems: string;
 /**
  * How many resources a diagnostic `resources/list` returned after a read was refused, and their URIs
  * joined. The pair says which names an endpoint actually publishes when the one a link asked for was
  * not found.
  */
 appResourceCount: number;
 appResourceNames: string;
};

/** The logger this package expects to be handed. */
export type McpLog = Logger<McpLogFields>;
