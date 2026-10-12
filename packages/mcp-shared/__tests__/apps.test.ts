import { afterEach, describe, expect, it, vi } from "vitest";

import {
  APP_EXTENSION_ID,
  APP_MIME_TYPE,
  appResourceNames,
  appResourceUri,
  appToolNames,
  canonicalAppUri,
  clampAppResult,
  clampResourceMeta,
  isAppResourceUri,
  prefixedAppUri,
  MAX_APP_CSP_DOMAINS,
  MAX_APP_CSP_DOMAIN_CHARS,
  MAX_APP_RESULT_BYTES,
  MAX_UI_URI_CHARS,
  isAppMimeType,
  toolUiResourceUri,
  toolVisibleToApp,
  toolVisibleToModel,
  uiResourceUriInResult,
  viewAllowAttribute,
  viewCsp,
  type AppBinding,
  type AppToolResult,
} from "../src/apps.js";
import { clampToolDefinition, McpClient } from "../src/client.js";

afterEach(() => vi.unstubAllGlobals());

// The two ends of the app wire that belong to this package: what a client advertises, and what the
// sidecar gateway answers.
describe("the extension a client advertises", () => {
  it("declares MCP Apps support in initialize, and nothing else", async () => {
    const requests: Array<{ method?: string; params?: { capabilities?: unknown } }> = [];
    vi.stubGlobal("fetch", async (_input: unknown, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body));
      requests.push(request);
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: {} }), {
        status: 200,
        headers: { "Content-Type": "application/json", "Mcp-Session-Id": "session" },
      });
    });

    await new McpClient("https://mcp.example.com/mcp", async () => null).initialize("Gadgets");

    expect(requests.map(request => request.method)).toEqual([
      "initialize", "notifications/initialized",
    ]);
    expect(requests[0]?.params?.capabilities).toEqual({
      extensions: {
        // Both spellings, because a server reads this list to decide whether to attach a view and
        // the ones written before the profile type existed would see only a refusal.
        [APP_EXTENSION_ID]: { mimeTypes: [APP_MIME_TYPE, "text/html"] },
      },
    });
  });
});

// The text of a result's first block, which every case below knows is a text block. Narrowed rather
// than cast, so a block that is not one fails the assertion instead of reading `undefined`.
function firstText(result: AppToolResult): string | undefined {
  const [block] = result.content;
  if (typeof block !== "object" || block === null || !("text" in block)) return undefined;
  return typeof block.text === "string" ? block.text : undefined;
}

const BINDING: AppBinding = {
  endpoint: "https://mcp.example/rpc",
  serverName: "Example MCP",
  scope: {},
  trust: "byo",
};

describe("appResourceUri", () => {
  it("reads a resource under the URI it declared, for an endpoint that serves it there", () => {
    expect(appResourceUri(BINDING, "ui://weather/current")).toBe("ui://weather/current");
  });

  it("reads a renamed resource under the prefix its endpoint serves it with", () => {
    // A portal lists and reads an upstream resource as `{serverId}_{uri}`, and refuses the URI the
    // upstream declared.
    const portal = { ...BINDING, resourceUriPrefix: "mcp-app-server_" };

    expect(appResourceUri(portal, "ui://demo/dashboard"))
      .toBe("mcp-app-server_ui://demo/dashboard");
  });

  it("drops the portal's own server_id routing parameter before prefixing", () => {
    // A portal injects `server_id=<id>` into the app URI it advertises; the upstream declared the
    // URI without it and answers a read forwarded with it with an HTTP 400 (see fnbullion/NetSuite).
    const portal = { ...BINDING, resourceUriPrefix: "netsuite-fnb_" };

    expect(appResourceUri(
      portal,
      "ui://SuiteApps/com.netsuite.mcpstandardtools/prompt-library-app/mcp-app.html" +
      "?server_id=netsuite-fnb",
    )).toBe(
      "netsuite-fnb_ui://SuiteApps/com.netsuite.mcpstandardtools/prompt-library-app/mcp-app.html",
    );
    // Other parameters survive, and a URI without the parameter is untouched.
    expect(appResourceUri(portal, "ui://demo/dashboard?a=1&server_id=x&b=2"))
      .toBe("netsuite-fnb_ui://demo/dashboard?a=1&b=2");
    expect(appResourceUri(portal, "ui://demo/dashboard?keep=1"))
      .toBe("netsuite-fnb_ui://demo/dashboard?keep=1");
  });

  it("drops this deployment's own routing parameter before any endpoint sees the URI", () => {
    // `server_id` names a server to a portal: the portal routes by it, and a window must not be
    // able to smuggle it to an endpoint in the URI it asks to read.
    expect(appResourceUri(BINDING, "ui://demo/dashboard?server_id=ws&keep=1"))
      .toBe("ui://demo/dashboard?keep=1");
    // A portal gets the same strip, applied before the prefix it routes by.
    expect(appResourceUri({ ...BINDING, resourceUriPrefix: "portal_" }, "ui://demo/a?server_id=c&x=1"))
      .toBe("portal_ui://demo/a?x=1");
    // A bare name with no `=` is dropped the same way.
    expect(appResourceUri({ ...BINDING, resourceUriPrefix: "portal_" }, "ui://demo/a?server_id"))
      .toBe("portal_ui://demo/a");
    // Only host-owned names go: a parameter that merely starts with one is the server's business.
    expect(appResourceUri({ ...BINDING, resourceUriPrefix: "portal_" }, "ui://demo/a?server_idx=1"))
      .toBe("portal_ui://demo/a?server_idx=1");
  });
});

describe("appResourceNames", () => {
  it("reads a resource under the name it declared when the endpoint does not rename", () => {
    expect(appResourceNames(BINDING, "ui://weather/current")).toEqual(["ui://weather/current"]);
  });

  it("reads only the binding's prefixed name when the endpoint renames", () => {
    // A portal refuses the upstream's own name, so the unprefixed one is never tried.
    expect(appResourceNames({ ...BINDING, resourceUriPrefix: "portal_" }, "ui://weather/current"))
      .toEqual(["portal_ui://weather/current"]);
  });

  it("drops the endpoint's own routing parameter so the name carries none", () => {
    // A portal decorates the URIs it advertises with `?server_id=`, but a read carrying it is
    // refused, so the name may not keep it (see `canonicalAppUri`).
    expect(appResourceNames(
      { ...BINDING, resourceUriPrefix: "netsuite-sb1_" },
      "ui://SuiteApps/app/index.html?server_id=netsuite-sb1",
    )).toEqual(["netsuite-sb1_ui://SuiteApps/app/index.html"]);
  });

  it("prefixes a declared name once, never twice", () => {
    // The URI taken from `_meta.ui.resourceUri` is the upstream's plain name; a name that already
    // carries the prefix (from a result that used the endpoint's own) is left alone.
    expect(appResourceNames(
      { ...BINDING, resourceUriPrefix: "netsuite-sb1_" },
      "netsuite-sb1_ui://SuiteApps/app/index.html",
    )).toEqual(["netsuite-sb1_ui://SuiteApps/app/index.html"]);
  });
});

describe("prefixedAppUri", () => {
  it("prefixes a ui:// name once, and leaves an endpoint's own name untouched", () => {
    expect(prefixedAppUri("netsuite-sb1_", "ui://demo/a")).toBe("netsuite-sb1_ui://demo/a");
    expect(prefixedAppUri("netsuite-sb1_", "netsuite-sb1_ui://demo/a"))
      .toBe("netsuite-sb1_ui://demo/a");
    // No prefix (an endpoint that serves a resource under its own name) is the identity.
    expect(prefixedAppUri(undefined, "ui://demo/a")).toBe("ui://demo/a");
    expect(prefixedAppUri("", "ui://demo/a")).toBe("ui://demo/a");
  });
});

describe("appToolNames", () => {
  it("calls a tool under the name it declared when the endpoint does not rename", () => {
    // An endpoint that serves its own tools, so what the window asked for is the wire name.
    expect(appToolNames(BINDING, "ns_getSuiteQLMetadata")).toEqual(["ns_getSuiteQLMetadata"]);
  });

  it("namespaces a tool under the server prefix a portal serves it with", () => {
    // A portal serves an upstream `ns_getSuiteQLMetadata` as `netsuite-sb1_ns_getSuiteQLMetadata`,
    // and the app can only know the upstream's own name, so the binding supplies the prefix it
    // already applies to that server's resources.
    expect(appToolNames(
      { ...BINDING, resourceUriPrefix: "netsuite-sb1_" },
      "ns_getSuiteQLMetadata",
    )).toEqual(["netsuite-sb1_ns_getSuiteQLMetadata"]);
  });

  it("prefixes a name that already carries the prefix once, never twice", () => {
    expect(appToolNames(
      { ...BINDING, resourceUriPrefix: "netsuite-sb1_" },
      "netsuite-sb1_ns_getSuiteQLMetadata",
    )).toEqual(["netsuite-sb1_ns_getSuiteQLMetadata"]);
  });
});

describe("isAppResourceUri", () => {
  it("accepts a ui:// name and an endpoint's prefixed one, and nothing else", () => {
    expect(isAppResourceUri(undefined, "ui://demo/a")).toBe(true);
    expect(isAppResourceUri("netsuite-sb1_", "netsuite-sb1_ui://demo/a")).toBe(true);
    // The prefix is only stripped for the binding that owns it.
    expect(isAppResourceUri("other_", "netsuite-sb1_ui://demo/a")).toBe(false);
    expect(isAppResourceUri("netsuite-sb1_", "https://example.com/a")).toBe(false);
  });
});

describe("canonicalAppUri", () => {
  it("keeps a ui:// URI and drops only the parameters this deployment owns", () => {
    expect(canonicalAppUri("ui://demo/a")).toBe("ui://demo/a");
    expect(canonicalAppUri("ui://demo/a?keep=1")).toBe("ui://demo/a?keep=1");
    expect(canonicalAppUri("ui://demo/a?server_id=x&b=2")).toBe("ui://demo/a?b=2");
    // A bare name with no `=` is dropped the same way; a parameter that merely starts with a
    // host-owned one is the server's business.
    expect(canonicalAppUri("ui://demo/a?server_id")).toBe("ui://demo/a");
    expect(canonicalAppUri("ui://demo/a?server_idx=1")).toBe("ui://demo/a?server_idx=1");
    // A percent-encoded spelling names the same parameter, so it is dropped too; a name that will
    // not decode is compared as written.
    expect(canonicalAppUri("ui://demo/a?server%5Fid=x&b=2")).toBe("ui://demo/a?b=2");
    expect(canonicalAppUri("ui://demo/a?bad%zz=1")).toBe("ui://demo/a?bad%zz=1");
  });
});

describe("toolUiResourceUri", () => {
  it("reads the resource a tool renders with", () => {
    const tool = clampToolDefinition({
      name: "get_weather",
      inputSchema: { type: "object" },
      _meta: { ui: { resourceUri: "ui://weather/current", visibility: ["model"] } },
    });
    expect(toolUiResourceUri(tool)).toBe("ui://weather/current");
    expect(tool.ui?.visibility).toEqual(["model"]);
  });

  it("reads the deprecated flat metadata key", () => {
    const tool = clampToolDefinition({
      name: "get_weather",
      inputSchema: { type: "object" },
      _meta: { "ui/resourceUri": "ui://weather/legacy" },
    });
    expect(toolUiResourceUri(tool)).toBe("ui://weather/legacy");
  });

  it("ignores an association that is not a ui:// resource", () => {
    const tool = clampToolDefinition({
      name: "get_weather",
      inputSchema: { type: "object" },
      _meta: { ui: { resourceUri: "https://weather.example.com/app.html" } },
    });
    expect(toolUiResourceUri(tool)).toBeUndefined();
  });

  it("keeps nothing else from a tool's metadata", () => {
    const tool = clampToolDefinition({
      name: "get_weather",
      inputSchema: { type: "object" },
      _meta: {
        ui: { resourceUri: "ui://weather/current", csp: { connectDomains: ["*"] } },
        "example/extension": { arbitrary: "x".repeat(1000) },
      },
    });
    expect(tool).toEqual({
      name: "get_weather",
      title: undefined,
      description: undefined,
      inputSchema: { type: "object" },
      annotations: undefined,
      ui: { resourceUri: "ui://weather/current", visibility: undefined },
    });
  });
});

describe("isAppMimeType", () => {
  it("reads the profile type, the bare media type, and their parameters as one document", () => {
    // Servers written before the profile type existed -- the playground ones users paste in -- serve
    // a bare `text/html`, and a document is qualified by its `ui://` URI, not by this string.
    for (const declared of ["text/html;profile=mcp-app", "text/html", "text/html; charset=utf-8",
      "TEXT/HTML"]) {
      expect(isAppMimeType(declared)).toBe(true);
    }
    for (const declared of ["text/plain", "application/xhtml+xml", "text/htmlx", undefined]) {
      expect(isAppMimeType(declared)).toBe(false);
    }
  });
});

describe("uiResourceUriInResult", () => {
  it("prefers the result's own metadata", () => {
    expect(uiResourceUriInResult({
      _meta: { ui: { resourceUri: "ui://weather/current" } },
      content: [{ type: "resource_link", uri: "ui://weather/other" }],
    })).toBe("ui://weather/current");
  });

  it("falls back to a linked ui:// resource", () => {
    expect(uiResourceUriInResult({
      content: [
        { type: "text", text: "6°C" },
        { type: "resource_link", uri: "ui://weather/current" },
      ],
    })).toBe("ui://weather/current");
  });

  it("falls back to an embedded ui:// resource", () => {
    expect(uiResourceUriInResult({
      content: [{ type: "resource", resource: { uri: "ui://weather/current", text: "<html></html>" } }],
    })).toBe("ui://weather/current");
  });

  it("ignores a ui:// URI longer than the bound it is stored under", () => {
    // The URI is written to the action that produced it and into the link's token record, and the
    // server chooses its length. Dropping it keeps the bound; truncating it would name a resource
    // the server never meant.
    const long = `ui://demo/${"x".repeat(MAX_UI_URI_CHARS)}`;
    expect(uiResourceUriInResult({ _meta: { ui: { resourceUri: long } } })).toBeUndefined();
    expect(uiResourceUriInResult({
      _meta: { ui: { resourceUri: `ui://demo/${"x".repeat(MAX_UI_URI_CHARS - 10)}` } },
    })).toMatch(/^ui:\/\/demo\/x+$/);
  });

  it("ignores anything that is not a ui:// resource", () => {
    expect(uiResourceUriInResult({
      _meta: { ui: { resourceUri: "https://weather.example.com/app.html" } },
      content: [
        { type: "resource_link", uri: "https://weather.example.com/page" },
        { type: "resource", resource: { uri: "https://weather.example.com/raw" } },
        { type: "text", text: "ui://not-a-block" },
      ],
    })).toBeUndefined();
    expect(uiResourceUriInResult({})).toBeUndefined();
  });
});

describe("visibility", () => {
  it("shows a tool to both sides when nothing was declared", () => {
    expect(toolVisibleToModel({ name: "a" })).toBe(true);
    expect(toolVisibleToApp({ name: "a" })).toBe(true);
  });

  it("honours a declared side", () => {
    expect(toolVisibleToModel({ name: "a", ui: { visibility: ["app"] } })).toBe(false);
    expect(toolVisibleToApp({ name: "a", ui: { visibility: ["app"] } })).toBe(true);
    expect(toolVisibleToModel({ name: "a", ui: { visibility: ["model"] } })).toBe(true);
    expect(toolVisibleToApp({ name: "a", ui: { visibility: ["model"] } })).toBe(false);
  });

  it("hides a tool from both sides when the declaration survived empty", () => {
    const tool = clampToolDefinition({
      name: "a",
      inputSchema: { type: "object" },
      _meta: { ui: { resourceUri: "ui://a", visibility: ["nobody"] } },
    });
    expect(toolVisibleToModel(tool)).toBe(false);
    expect(toolVisibleToApp(tool)).toBe(false);
  });
});

describe("viewCsp", () => {
  it("applies the specification's defaults when the resource declared nothing", () => {
    const expected = [
      "default-src 'none'",
      "script-src 'self' 'unsafe-inline'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data:",
      "media-src 'self' data:",
      "font-src 'none'",
      "connect-src 'none'",
      "frame-src 'none'",
      "base-uri 'self'",
      "object-src 'none'",
    ].join("; ");
    expect(viewCsp(undefined)).toBe(expected);
    expect(viewCsp({})).toBe(expected);
  });

  it("widens a directive only by what the resource declared for it", () => {
    const csp = viewCsp({
      csp: {
        resourceDomains: ["https://cdn.example.com"],
        connectDomains: ["https://api.example.com"],
        frameDomains: ["https://player.example.com"],
        baseUriDomains: ["https://cdn.example.com"],
      },
    });
    expect(csp).toContain("script-src 'self' 'unsafe-inline' https://cdn.example.com");
    expect(csp).toContain("style-src 'self' 'unsafe-inline' https://cdn.example.com");
    expect(csp).toContain("img-src 'self' data: https://cdn.example.com");
    expect(csp).toContain("media-src 'self' data: https://cdn.example.com");
    expect(csp).toContain("font-src https://cdn.example.com");
    expect(csp).toContain("connect-src https://api.example.com");
    expect(csp).toContain("frame-src https://player.example.com");
    expect(csp).toContain("base-uri https://cdn.example.com");
    expect(csp).toContain("object-src 'none'");
  });

  it("keeps a resource domain out of the directives it did not declare", () => {
    const csp = viewCsp({ csp: { resourceDomains: ["https://cdn.example.com"] } });
    expect(csp).toContain("connect-src 'none'");
    expect(csp).toContain("frame-src 'none'");
    expect(csp).toContain("base-uri 'self'");
  });

  it("drops a declared domain that would end its directive", () => {
    const csp = viewCsp({
      csp: {
        connectDomains: [
          "https://ok.example.com",
          "https://bad.example.com; script-src 'unsafe-eval'",
          "https://two.example.com https://three.example.com",
        ],
      },
    });
    expect(csp.match(/connect-src[^;]*/g)).toEqual(["connect-src https://ok.example.com"]);
    expect(csp).not.toContain("unsafe-eval");
    expect(csp).toContain("script-src 'self' 'unsafe-inline'");
  });

  it("cannot be widened past an unconditional object-src", () => {
    const csp = viewCsp({ csp: { resourceDomains: ["*"] } });
    expect(csp.match(/object-src[^;]*/g)).toEqual(["object-src 'none'"]);
  });

  it("cannot be widened or lengthened by a hostile declaration", () => {
    const declared = Array.from(
      { length: MAX_APP_CSP_DOMAINS * 4 },
      (_, index) => `https://host${index}.example.com`,
    );
    const csp = viewCsp({
      csp: {
        connectDomains: declared,
        resourceDomains: [
          "https://ok.example.com",
          "*",
          "data:",
          `https://${"a".repeat(MAX_APP_CSP_DOMAIN_CHARS)}.example.com`,
          "https://bad.example.com; script-src *",
        ],
      },
    });

    // Only the first declarations are read at all, so nothing past the cap can reach a directive.
    expect(csp.match(/connect-src[^;]*/g)).toEqual([
      `connect-src ${declared.slice(0, MAX_APP_CSP_DOMAINS).join(" ")}`,
    ]);
    // One usable origin is left in the other directive: the wildcard, the bare scheme, the over-long
    // host, and the injection all dropped rather than written into a policy.
    expect(csp.match(/script-src[^;]*/g)).toEqual([
      "script-src 'self' 'unsafe-inline' https://ok.example.com",
    ]);
    expect(csp.length).toBeLessThan(
      4 * MAX_APP_CSP_DOMAINS * (MAX_APP_CSP_DOMAIN_CHARS + 1) + 512);
  });
});

describe("viewAllowAttribute", () => {
  it("asks for nothing when the resource declared nothing", () => {
    expect(viewAllowAttribute(undefined)).toBeUndefined();
    expect(viewAllowAttribute({ permissions: {} })).toBeUndefined();
  });

  it("names the features the resource asked for", () => {
    expect(viewAllowAttribute({ permissions: { camera: true } })).toBe("camera");
    expect(viewAllowAttribute({
      permissions: { camera: true, microphone: true, geolocation: true, clipboardWrite: true },
    })).toBe("camera; microphone; geolocation; clipboard-write");
    expect(viewAllowAttribute({ permissions: { camera: false, geolocation: true } }))
      .toBe("geolocation");
  });
});

describe("clampResourceMeta", () => {
  it("reads the declared domains and permissions of a resource", () => {
    expect(clampResourceMeta({
      csp: {
        connectDomains: ["https://api.example.com"],
        resourceDomains: "https://cdn.example.com",
      },
      // The specification declares a permission by its presence, with an empty object for a value.
      permissions: { camera: {}, microphone: false },
      domain: "apps.example.com",
    })).toEqual({
      csp: {
        connectDomains: ["https://api.example.com"],
        resourceDomains: undefined,
        frameDomains: undefined,
        baseUriDomains: undefined,
      },
      permissions: { camera: true, microphone: false, geolocation: false, clipboardWrite: false },
    });
  });

  it("treats metadata that is not a declaration as no declaration", () => {
    expect(clampResourceMeta(undefined)).toBeUndefined();
    expect(clampResourceMeta("ui")).toBeUndefined();
    expect(clampResourceMeta(["ui"])).toBeUndefined();
    expect(clampResourceMeta({ csp: [] })).toEqual({ csp: undefined, permissions: undefined });
  });
});

describe("clampAppResult", () => {
  it("passes a result through unchanged while it fits", () => {
    expect(clampAppResult({
      content: [{ type: "text", text: "6°C" }],
      structuredContent: { temperature: 6 },
      isError: false,
    })).toEqual({
      content: [{ type: "text", text: "6°C" }],
      structuredContent: { temperature: 6 },
      isError: false,
    });
  });

  it("bounds what a window is sent", () => {
    const result = clampAppResult({
      content: [{ type: "text", text: "x".repeat(MAX_APP_RESULT_BYTES) }],
      structuredContent: { note: "dropped with the content" },
    });
    expect(JSON.stringify(result).length).toBeLessThanOrEqual(MAX_APP_RESULT_BYTES);
    expect(result.content).toHaveLength(1);
    expect(result.structuredContent).toBeUndefined();
  });

  it("clips the text block that does not fit and stops there", () => {
    const result = clampAppResult({
      content: [
        { type: "text", text: "y".repeat(MAX_APP_RESULT_BYTES) },
        { type: "text", text: "never reached" },
      ],
    });
    expect(result.content).toHaveLength(1);
    expect(firstText(result)?.endsWith("\u2026")).toBe(true);
  });

  it("drops a block it cannot clip, and the ones behind it", () => {
    const result = clampAppResult({
      content: [
        { type: "image", data: "A".repeat(MAX_APP_RESULT_BYTES), mimeType: "image/png" },
        { type: "text", text: "after the image" },
      ],
    });
    expect(result.content).toEqual([]);
  });

  it("counts non-ASCII text in bytes rather than characters", () => {
    const result = clampAppResult({ content: [{ type: "text", text: "é".repeat(MAX_APP_RESULT_BYTES) }] });
    expect(JSON.stringify(result).length).toBeLessThanOrEqual(MAX_APP_RESULT_BYTES);
    expect(firstText(result)).toMatch(/^é+…$/);
  });
});
