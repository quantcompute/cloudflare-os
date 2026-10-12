import { beforeEach, describe, expect, it, vi } from "vitest";

import type {
  McpServerConfiguratorRpc,
  McpServerConfiguratorValues,
} from "../src/configurator/server-configurator-types.js";

// The real `h` and the controls throw: the sandbox runtime supplies them at load time. These tests
// exercise the data flow in `render`, not the markup, so a plain tree is enough.
vi.mock("@gadgets/configurator-ui", () => ({
  h: (component: unknown, props: unknown, ...children: unknown[]) =>
    ({ component, props, children }),
  Section: "Section",
  Field: "Field",
  Autocomplete: "Autocomplete",
  CheckboxList: "CheckboxList",
  RadioCards: "RadioCards",
}));

type Values = McpServerConfiguratorValues;

// The module caches the server list at module scope, which is safe only because the host hands it a fresh
// iframe -- and so a fresh realm -- for every account and resource pattern. Re-importing per test
// reproduces that; without it one test's cached list is served to the next.
async function loadSpec() {
  vi.resetModules();
  return (await import("../src/configurator/server-configurator-ui.js")).default;
}

function propsFor(node: unknown, component: string): Record<string, unknown> {
  const item = node as { component?: unknown; props?: Record<string, unknown>; children?: unknown[] };
  if (item?.component === component) return item.props ?? {};
  for (const child of item?.children ?? []) {
    try { return propsFor(child, component); } catch {}
  }
  throw new Error(`${component} not found`);
}

// Drives `render` the way the host does: values in, `setValues` patches applied, render again.
function harness(
  spec: { render: (args: never) => unknown }, initial: Values, ui: McpServerConfiguratorRpc,
) {
  let values = { ...initial };
  return {
    render: () => spec.render({
      values,
      setValues: (patch: Partial<Values>) => { values = { ...values, ...patch }; },
      ui,
    } as never),
    get values() { return values; },
  };
}

const portalValues = (server: string): Values =>
  ({ server, mode: "all", tools: null, codeMode: null, endpointKind: "portal" });

let spec: Awaited<ReturnType<typeof loadSpec>>;
beforeEach(async () => { spec = await loadSpec(); });

// Every question this form asks depends on reaching the portal, so a failure has its own path.
function unreachableRpc(): McpServerConfiguratorRpc {
  return {
    getEndpoint: async () => "https://gw.example.com/mcp",
    listServerOptions: async () => { throw new Error("portal unreachable"); },
    listToolOptions: async () => { throw new Error("portal unreachable"); },
  } as unknown as McpServerConfiguratorRpc;
}

function rpcWithServers(...serverIds: string[]): McpServerConfiguratorRpc {
  return {
    getEndpoint: async () => "https://gw.example.com/mcp",
    listServerOptions: async () => serverIds.map(value => ({ value, title: value })),
    listToolOptions: async () => [],
  } as unknown as McpServerConfiguratorRpc;
}

describe("portal configurator", () => {
  it("blocks the grant when the portal cannot be listed, rather than granting all of it", async () => {
    // "We asked and it is not a portal" and "we could not ask" are different answers. Failure used
    // to be recorded as the former, which made the form submittable against the bare endpoint --
    // every tool of every system behind the portal, which is the one grant this connector refuses
    // to offer in a click.
    const ui = unreachableRpc();
    const app = harness(spec, {
      server: null, mode: "all", tools: null, endpointKind: "unknown",
    }, ui);

    app.render();
    await vi.waitFor(() => expect(app.values.endpointKind).toBe("unavailable"));

    expect(spec.isReady({ values: app.values })).toBe(false);

    // And it says so, instead of showing a tool list it could not populate.
    const rendered = JSON.stringify(app.render());
    expect(rendered).toContain("Could not reach the portal");
    expect(rendered).not.toContain("CheckboxList");
  });

  it("shows neutral guidance when no servers are grantable", async () => {
    const ui = {
      getEndpoint: async () => "https://gw.example.com/mcp",
      listServerOptions: async () => [],
      listToolOptions: async () => [],
    } as unknown as McpServerConfiguratorRpc;
    const app = harness(spec, {
      server: null, mode: "all", tools: null, endpointKind: "unknown",
    }, ui);

    app.render();
    await vi.waitFor(() => expect(app.values.endpointKind).toBe("empty"));
    expect(app.values.server).toBeNull();
    expect(spec.isReady({ values: app.values })).toBe(false);
    const rendered = JSON.stringify(app.render());
    expect(rendered).toContain("No grantable servers");
    expect(rendered).not.toContain("Could not reach the portal");
  });

  it("clears a prefilled server that the filtered portal list does not offer", async () => {
    const ui = {
      getEndpoint: async () => "https://gw.example.com/mcp",
      listServerOptions: async () => [{ value: "gitlab", title: "GitLab" }],
      listToolOptions: async () => [],
    } as unknown as McpServerConfiguratorRpc;
    const values = await spec.initialValuesFromResourceUrl({
      resourceUrl: "https://gw.example.com/mcp#server=jira&tool=jira_search",
      ui,
    } as never) as Values;

    expect(values.server).toBeNull();
    expect(values.tools).toBeNull();
    expect(spec.isReady({ values })).toBe(false);
    const rendered = JSON.stringify(harness(spec, values, ui).render());
    expect(rendered).toContain("Autocomplete");
    expect(rendered).not.toContain("jira");
    expect(rendered).not.toContain("CheckboxList");
  });

  it("shows every tool as a disabled preview for an all-tools grant", () => {
    const ui = { listToolOptions: vi.fn() } as unknown as McpServerConfiguratorRpc;
    const rendered = JSON.stringify(harness(spec, portalValues("linear"), ui).render());
    expect(rendered).toContain("CheckboxList");
    expect(rendered).toContain('"disabled":true');
    expect(rendered).toContain('"allSelected":true');
  });
});

describe("a Code Mode grant", () => {
  const url = "https://gw.example.com/mcp#codemode=search_and_execute";

  it("reopens selected and ready without picking a server", async () => {
    const ui = rpcWithServers("linear");
    const values = await spec.initialValuesFromResourceUrl(
      { resourceUrl: url, ui } as never) as Values;

    expect(values.codeMode).toBe("search_and_execute");
    expect(spec.isReady({ values } as never)).toBe(true);
    await expect(spec.resourceUrl({ values, ui } as never)).resolves.toBe(url);
  });

  it("hides the server and tool questions while it is selected", () => {
    const ui = rpcWithServers("linear");
    const rendered = JSON.stringify(harness(
      spec, { ...portalValues("linear"), codeMode: "search_and_execute" }, ui).render());

    expect(rendered).toContain("Code Mode");
    expect(rendered).not.toContain("Autocomplete");
    expect(rendered).not.toContain("CheckboxList");
  });

  it("is picked from the grant cards and emitted as the fragment", async () => {
    const ui = rpcWithServers("linear");
    const app = harness(spec, portalValues("linear"), ui);
    const cards = propsFor(app.render(), "RadioCards");
    expect((cards.options as Array<{ value: string }>).map(option => option.value))
      .toEqual(["server", "codemode"]);

    (cards.onChange as (kind: string) => void)("codemode");
    expect(app.values.codeMode).toBe("search_and_execute");
    await expect(spec.resourceUrl({ values: app.values, ui } as never)).resolves.toBe(url);
  });

  it("stays on the server side for a mode this connector does not mint", async () => {
    // The mint refuses an unknown mode, so the form must not present it as a selected Code Mode
    // grant; the person can still repair the resource URL with an ordinary server grant.
    const ui = rpcWithServers("linear");
    const values = await spec.initialValuesFromResourceUrl({
      resourceUrl: "https://gw.example.com/mcp#codemode=bogus", ui,
    } as never) as Values;

    expect(values.codeMode).toBeNull();
    await expect(spec.resourceUrl({ values, ui } as never)).resolves.toBe(
      "https://gw.example.com/mcp#server=linear");
  });

  it("is not ready without a portal the listing could confirm", () => {
    expect(spec.isReady({ values: {
      server: null, mode: "all", tools: null, codeMode: "search_and_execute", endpointKind: "empty",
    } } as never)).toBe(false);
  });
});

describe("a grant whose tool list is empty", () => {
  const url = "https://gw.example.com/mcp#server=linear&tool=&tool=";

  it("reopens pinned and empty rather than as a grant over everything", async () => {
    const loaded = await loadSpec();
    const values = await loaded.initialValuesFromResourceUrl(
      { resourceUrl: url, ui: rpcWithServers("linear") } as never) as Values;
    expect(values.mode).toBe("choose");
    expect(values.tools).toBeNull();
  });

  it("cannot be submitted until tools are actually chosen", async () => {
    const loaded = await loadSpec();
    const values = await loaded.initialValuesFromResourceUrl(
      { resourceUrl: url, ui: rpcWithServers("linear") } as never) as Values;
    expect(loaded.isReady({ values } as never)).toBe(false);
    expect(loaded.isReady({ values: { ...values, tools: " , , " } } as never)).toBe(false);
    expect(loaded.isReady({ values: { ...values, tools: "linear_search" } } as never)).toBe(true);
  });
});

describe("tool-name transport", () => {
  it("round-trips tool names containing delimiters", async () => {
    const ui = rpcWithServers("linear");
    const values = await spec.initialValuesFromResourceUrl({
      resourceUrl: "https://gw.example.com/mcp#server=linear&tool=linear_a%2Cb&tool=linear_percent%25name",
      ui,
    } as never) as Values;
    expect(values.tools).toBe("linear_a%2Cb,linear_percent%25name");
    await expect(spec.resourceUrl({ values, ui } as never)).resolves.toBe(
      "https://gw.example.com/mcp#server=linear&tool=linear_a%2Cb&tool=linear_percent%25name");
  });

  it("encodes server tool names before passing them to CheckboxList", async () => {
    const rendered = harness(spec, portalValues("linear"), {
      listToolOptions: async () => [{ value: "linear_a,b", title: "A, B" }],
    } as unknown as McpServerConfiguratorRpc).render();
    const loadOptions = propsFor(rendered, "CheckboxList").loadOptions as () => Promise<unknown[]>;
    await expect(loadOptions()).resolves.toEqual([{ value: "linear_a%2Cb", title: "A, B" }]);
  });
});

describe("a resource URL the form cannot decode", () => {
  // `decodeURIComponent("%")` throws, and this runs before anything renders: the configurator would
  // show nothing at all rather than let the grant be repaired.
  it("opens instead of throwing", async () => {
    const loaded = await loadSpec();
    const values = await loaded.initialValuesFromResourceUrl({
      resourceUrl: "https://gw.example.com/mcp#server=%&tool=%",
      ui: rpcWithServers("linear"),
    } as never) as Values;
    expect(values.server).toBeNull();
    expect(values.tools).toBeNull();
  });
});
