// How much of a connected MCP endpoint one binding may call, encoded in the resource URL fragment.
// The fragment is what the user approved, what `describe()` shows them, and what the facet enforces.
//
//   <endpoint>                                  every tool the endpoint offers, now and later
//   <endpoint>#server=github                    every tool of one portal upstream server
//   <endpoint>#tool=a&tool=b                    only these exact tools
//   <endpoint>#server=github&tool=github_a      both, enforced independently
//   <endpoint>#codemode=search_and_execute      the portal's Code Mode tool pair, and nothing else
//
// `tools` holds exact wire names rather than names relative to the server, so no code has to guess
// at the portal's separator and grants issued before portals existed still resolve identically.

import type { ToolCatalog } from "./client.js";
import {
  isPortalCodeMode,
  isPortalCodeModeTool,
  isPortalNativeTool,
  PORTAL_CODEMODE_QUERY_PARAM,
  toolBelongsToServer,
  type PortalCodeMode,
  type PortalServer,
} from "./portal.js";
import { MAX_TOOLS_PER_SERVER } from "./tools.js";

/** The breadth of one binding's grant over its endpoint. */
export type ToolScope = {
  /** When set, only tools belonging to this portal upstream server. */
  serverId?: string;
  /** When set, only these exact tool names, as the endpoint spells them. */
  tools?: string[];
  /**
   * When set, the portal's Code Mode pair instead of any upstream server's tools.
   *
   * The sandbox runs portal-side, so such a grant reaches every upstream tool the portal session
   * enables and `serverId`/`tools` cannot narrow it. The two keys are refused alongside it rather
   * than ignored, so a grant never appears narrower than it is.
   */
  codeMode?: PortalCodeMode;
};

/** True when the scope names no restriction at all, i.e. the whole endpoint. */
export function isWholeEndpoint(scope: ToolScope): boolean {
  return scope.serverId === undefined && scope.tools === undefined
    && scope.codeMode === undefined;
}

/**
 * The endpoint half of a resource URL: everything the scope fragment does not cover.
 *
 * A grant is `<endpoint>#<scope>`, so dropping the fragment recovers the endpoint it was issued
 * against. Both sides of every comparison go through `URL`, so two spellings of one endpoint cannot
 * read as different endpoints.
 */
export function endpointOfResourceUrl(resourceUrl: string | URL): string {
  const url = new URL(resourceUrl);
  url.hash = "";
  return url.toString();
}

/**
 * Whether two URLs name the same endpoint, ignoring any scope fragment.
 *
 * The whole URL is compared, not just the origin. Path and query are part of which server is being
 * spoken to -- one host can front `/mcp` and `/mcp-v2` as unrelated endpoints -- so an origin-only
 * test would accept a resource URL the account never connected to. Returns false for anything
 * unparseable, since a URL that cannot be read cannot be shown to match.
 */
export function sameEndpoint(a: string, b: string): boolean {
  try {
    return endpointOfResourceUrl(a) === endpointOfResourceUrl(b);
  } catch {
    return false;
  }
}

/**
 * Endpoint identity for an action-kind scope tag, so persistent approval policy is namespaced by
 * exactly the identity `sameEndpoint` compares.
 *
 * Two endpoints share a tag if and only if `sameEndpoint` calls them the same, since both are
 * `endpointOfResourceUrl`. Anything coarser leaks authority between servers this connector treats
 * as unrelated: keying on the origin let one host's `/mcp` and `/mcp-v2` share an always-approve
 * decision for the same tool name. Anything finer -- the raw string -- would split one endpoint's
 * policy across two spellings of it.
 *
 * Encoded, so a path or query can never be read as a separator by whatever composes the tag.
 */
export function endpointTag(endpoint: string): string {
  return encodeURIComponent(endpointOfResourceUrl(endpoint));
}


/**
 * Reads the scope out of a resource URL's fragment. Unknown keys are ignored.
 *
 * A `tool` key that yields nothing usable is kept as an empty restriction. The obsolete `tools` key
 * also produces an empty restriction rather than failing open. Only the absence of both keys grants
 * the whole endpoint. An unrecognized `codemode` value throws, since the alternative -- an empty
 * scope -- is the whole endpoint and therefore every tool the portal enables.
 */
export function parseToolScope(resourceUrl: string | URL): ToolScope {
  let params: URLSearchParams;
  try {
    const url = typeof resourceUrl === "string" ? new URL(resourceUrl) : resourceUrl;
    params = new URLSearchParams(url.hash.slice(1));
  } catch {
    return {};
  }
  const rawTools = params.getAll("tool");
  if (rawTools.length > MAX_TOOLS_PER_SERVER) {
    throw new Error(`A grant can name at most ${MAX_TOOLS_PER_SERVER} MCP tools.`);
  }
  const rawCodeMode = params.get(PORTAL_CODEMODE_QUERY_PARAM);
  if (rawCodeMode !== null && !isPortalCodeMode(rawCodeMode)) {
    throw new Error(`Unsupported portal code mode "${rawCodeMode}".`);
  }
  return {
    serverId: params.has("server") ? params.get("server")!.trim() : undefined,
    tools: params.has("tools")
      ? []
      : params.has("tool")
      ? rawTools.map(name => name.trim()).filter(Boolean)
      : undefined,
    codeMode: rawCodeMode ?? undefined,
  };
}

/**
 * Renders a scope back onto an endpoint URL, inverting `parseToolScope`. A key present with an empty
 * value is emitted as such: `describe()` feeds its result back through `parseToolScope`, so omitting
 * it would undo the fail-closed parse above on the round trip.
 *
 * A code-mode scope is rendered as the mode alone. `serverId` and `tools` are the sandbox's to
 * ignore, and a URL that named them beside `codemode` would describe a restriction the grant cannot
 * enforce.
 */
export function formatToolScope(endpoint: string, scope: ToolScope): string {
  if (scope.codeMode !== undefined) {
    const params = new URLSearchParams();
    params.set(PORTAL_CODEMODE_QUERY_PARAM, scope.codeMode);
    return `${endpoint}#${params.toString()}`;
  }
  if ((scope.tools?.length ?? 0) > MAX_TOOLS_PER_SERVER) {
    throw new Error(`A grant can name at most ${MAX_TOOLS_PER_SERVER} MCP tools.`);
  }
  const params = new URLSearchParams();
  if (scope.serverId !== undefined) params.set("server", scope.serverId);
  for (const tool of scope.tools ?? []) params.append("tool", tool);
  if (scope.tools?.length === 0) params.append("tool", "");
  const fragment = params.toString();
  return fragment ? `${endpoint}#${fragment}` : endpoint;
}

/**
 * Whether this scope permits calling `toolName`. `isPortal` gates the portal-native exclusion, so a
 * plain server with a tool coincidentally named `portal_something` still works.
 *
 * A code-mode scope is checked first and as a closed set: the pair is allowed on a portal and
 * nothing else is, neither the portal's session-management tools nor any upstream name. `serverId`
 * and `tools` are not consulted there, since nothing can narrow a portal-side sandbox.
 */
export function scopeAllows(scope: ToolScope, toolName: string, isPortal: boolean): boolean {
  if (scope.codeMode !== undefined) return isPortal && isPortalCodeModeTool(toolName);
  if (isPortal && isPortalNativeTool(toolName)) return false;
  if (scope.serverId !== undefined && !toolBelongsToServer(toolName, scope.serverId)) return false;
  if (scope.tools !== undefined && !scope.tools.includes(toolName)) return false;
  return true;
}

/** Refuses individual-tool selection when the server's catalog is incomplete. */
export function requireCompleteCatalogForToolSelection(truncated: boolean): void {
  if (truncated) {
    throw new Error(
      "This server's tool catalog is too large to select individual tools. Grant all tools instead.");
  }
}

/**
 * Validates a requested grant against the current catalog.
 *
 * For portal scopes, `reportedServers` may establish a server that currently publishes no tools.
 * The matching server is returned so callers can persist its current display name.
 */
export function validateToolScopeAgainstCatalog(
  scope: ToolScope,
  catalog: ToolCatalog,
  reportedServers: PortalServer[] = [],
): PortalServer | undefined {
  let server: PortalServer | undefined;
  const serverId = scope.serverId;
  if (serverId !== undefined) {
    server = reportedServers.find(candidate => candidate.id === serverId);
    if (!server && catalog.tools.some(tool => toolBelongsToServer(tool.name, serverId))) {
      server = { id: serverId, name: serverId, enabled: true };
    }
    if (!server) {
      throw new Error(`Server "${serverId}" is absent from the current portal catalog.`);
    }
  }

  const names = new Set(catalog.tools.map(tool => tool.name));
  for (const name of scope.tools ?? []) {
    if (serverId !== undefined && !toolBelongsToServer(name, serverId)) {
      throw new Error(`Tool "${name}" does not belong to portal server "${serverId}".`);
    }
    if (!names.has(name)) {
      if (catalog.truncated) {
        throw new Error("The current tool catalog is truncated, so this grant cannot be validated.");
      }
      throw new Error(`Tool "${name}" is absent from the current tool catalog.`);
    }
  }
  return server;
}
