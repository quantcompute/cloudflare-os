import { beforeEach, describe, expect, it, vi } from "vitest";

import type { McpServerConfiguratorRpc } from
  "../src/configurator/server-configurator-types.js";

const mocks = vi.hoisted(() => ({ withClient: vi.fn() }));

vi.mock("capnweb-validate", () => ({
  validateRpc: () => (value: unknown) => value,
  skipRpcValidation: () => (value: unknown) => value,
}));

vi.mock("@gadgets/mcp-shared/connection", async importOriginal => ({
  ...await importOriginal<typeof import("@gadgets/mcp-shared/connection")>(),
  withClient: mocks.withClient,
}));

import { GatekeeperUserImpl, McpGatekeeperImpl } from "../src/portal.js";

const ENDPOINT = "https://gw.example.com/mcp";

type FakeClient = {
  callTool: ReturnType<typeof vi.fn>;
  findTool: ReturnType<typeof vi.fn>;
  listToolIndex: ReturnType<typeof vi.fn>;
  listMatchingToolSummaries: ReturnType<typeof vi.fn>;
};

function makeSubject(hiddenServerIds = "jira") {
  const client: FakeClient = {
    callTool: vi.fn(async () => ({
      isError: false,
      structuredContent: [
        { id: "jira", name: "Jira", enabled: true },
        { id: "gitlab", name: "GitLab", enabled: true },
      ],
    })),
    findTool: vi.fn(async (name: string) => ({ name })),
    listToolIndex: vi.fn(),
    listMatchingToolSummaries: vi.fn(),
  };
  mocks.withClient.mockImplementation(async (...args: unknown[]) => {
    const callback = args[3] as (value: FakeClient) => unknown;
    return callback(client);
  });

  const account = {
    getServer: vi.fn(async () => ({
      endpoint: ENDPOINT,
      auth: "oauth",
      provenance: "deployment",
      serverId: "portal",
      serverName: "CF Portal",
    })),
  };
  const mintFacet = vi.fn();
  const ctx = {
    props: { accountObjectId: "account-id" },
    exports: {
      McpAccount: {
        idFromString: vi.fn(() => "account-id"),
        get: vi.fn(() => account),
      },
      McpGatekeeperImpl: mintFacet,
    },
  };
  const env = {
    MCP_PORTAL_URL: ENDPOINT,
    MCP_PORTAL_NAME: "CF Portal",
    MCP_PORTAL_AUTH: "oauth",
    MCP_PORTAL_HIDDEN_SERVER_IDS: hiddenServerIds,
  };
  return { user: new GatekeeperUserImpl(ctx as never, env as never), client, mintFacet };
}

async function configuratorFor(user: GatekeeperUserImpl): Promise<McpServerConfiguratorRpc> {
  const frame = await user.startResourceConfigurator("https://gw.example.com/*");
  return (frame.ui as unknown as { target: McpServerConfiguratorRpc }).target;
}

beforeEach(() => {
  mocks.withClient.mockReset();
});

describe("hidden portal server boundaries", () => {
  it("removes hidden servers from the configurator RPC result", async () => {
    const { user } = makeSubject();

    await expect((await configuratorFor(user)).listServerOptions()).resolves.toEqual([{
      value: "gitlab",
      title: "GitLab",
      meta: undefined,
    }]);
  });

  it("does not fetch portal data for a hidden server's tool options", async () => {
    const { user } = makeSubject();

    await expect((await configuratorFor(user)).listToolOptions("jira")).resolves.toEqual([]);
    expect(mocks.withClient).not.toHaveBeenCalled();
  });

  it("rejects a crafted hidden-server URL before fetching portal data", async () => {
    const { user } = makeSubject();

    await expect(user.getGatekeeperClassFor(`${ENDPOINT}#server=jira`))
      .rejects.toThrow(/native connector/);
    expect(mocks.withClient).not.toHaveBeenCalled();
  });

  it("keeps an existing hidden-server facet usable", async () => {
    const ctx = {
      props: {
        accountObjectId: "account-id",
        endpoint: ENDPOINT,
        serverId: "portal",
        serverName: "CF Portal",
        scopeServerName: "Jira",
        scope: { serverId: "jira" },
      },
      storage: {
        kv: {
          get: vi.fn(() => ({
            tools: [{ name: "jira_search", annotations: { readOnlyHint: true } }],
            revision: "cached",
            fetchedAt: Date.now(),
            truncated: false,
          })),
          put: vi.fn(),
        },
        sql: {},
      },
      exports: {
        McpAccount: {
          idFromString: vi.fn(() => "account-id"),
          get: vi.fn(() => ({})),
        },
      },
    };
    const facet = new McpGatekeeperImpl(ctx as never, {
      MCP_PORTAL_HIDDEN_SERVER_IDS: "jira",
    } as never);

    await expect(facet.tools()).resolves.toMatchObject([{
      tool: { name: "jira_search" },
      mode: "read",
    }]);
    expect(mocks.withClient).not.toHaveBeenCalled();
  });
});

describe("a Code Mode grant", () => {
  const CODEMODE_URL = `${ENDPOINT}#codemode=search_and_execute`;

  it("probes both Code Mode tools through the code-mode connection and mints the facet", async () => {
    const { user, client, mintFacet } = makeSubject();

    await user.getGatekeeperClassFor(CODEMODE_URL);

    // Both probes go through the client flavor the binding itself will use: the account call keeps
    // the base endpoint and the mode travels in the options, never in the endpoint the account sees.
    expect(client.findTool.mock.calls.map(call => call[0]))
      .toEqual(["portal_codemode_search", "portal_codemode_execute"]);
    expect(mocks.withClient.mock.calls.map(call => call[2])).toEqual([ENDPOINT, ENDPOINT]);
    expect(mocks.withClient.mock.calls.map(call => call[4])).toEqual([
      { codeMode: "search_and_execute" },
      { codeMode: "search_and_execute" },
    ]);

    expect(mintFacet).toHaveBeenCalledTimes(1);
    const props = (mintFacet.mock.calls[0] as [{ props: Record<string, unknown> }])[0].props;
    expect(props.scope).toEqual({ codeMode: "search_and_execute" });
    // No upstream server is named, so there is no display name to carry.
    expect(props).not.toHaveProperty("scopeServerName");
    // Hidden servers are a server-grant boundary; a Code Mode grant names no server to hide.
    expect(props.serverName).toBe("CF Portal");
  });

  it("refuses a portal that does not serve Code Mode, naming the policy", async () => {
    const { user, client, mintFacet } = makeSubject();
    client.findTool.mockImplementation(async (name: string) =>
      name === "portal_codemode_execute" ? undefined : { name });

    await expect(user.getGatekeeperClassFor(CODEMODE_URL))
      .rejects.toThrow(/Code Mode policy/);
    expect(mintFacet).not.toHaveBeenCalled();
  });

  it("refuses a Code Mode scope that also names a server or tools, before fetching", async () => {
    const { user } = makeSubject();

    await expect(user.getGatekeeperClassFor(`${CODEMODE_URL}&server=gitlab`))
      .rejects.toThrow(/cannot also name/);
    await expect(user.getGatekeeperClassFor(`${CODEMODE_URL}&server=jira`))
      .rejects.toThrow(/cannot also name/);
    await expect(user.getGatekeeperClassFor(`${CODEMODE_URL}&tool=gitlab_a`))
      .rejects.toThrow(/cannot also name/);
    expect(mocks.withClient).not.toHaveBeenCalled();
  });

  it("refuses a scope naming no server and no Code Mode", async () => {
    const { user } = makeSubject();

    await expect(user.getGatekeeperClassFor(ENDPOINT))
      .rejects.toThrow(/name one of the servers/);
    expect(mocks.withClient).not.toHaveBeenCalled();
  });

  it("refuses an unknown Code Mode instead of reading it as a server grant", async () => {
    const { user } = makeSubject();

    await expect(user.getGatekeeperClassFor(`${ENDPOINT}#codemode=bogus`))
      .rejects.toThrow(/code mode/i);
    expect(mocks.withClient).not.toHaveBeenCalled();
  });

  it("describes the facet from the portal's two Code Mode tools alone", async () => {
    const ctx = {
      props: {
        accountObjectId: "account-id",
        endpoint: ENDPOINT,
        serverId: "portal",
        serverName: "CF Portal",
        scope: { codeMode: "search_and_execute" },
      },
      storage: {
        kv: {
          get: vi.fn(() => ({
            tools: [
              { name: "portal_codemode_search", annotations: {} },
              { name: "portal_codemode_execute", annotations: {} },
              { name: "jira_search", annotations: { readOnlyHint: true } },
            ],
            revision: "cached",
            fetchedAt: Date.now(),
            truncated: false,
          })),
          put: vi.fn(),
        },
        sql: {},
      },
      exports: {
        McpAccount: {
          idFromString: vi.fn(() => "account-id"),
          get: vi.fn(() => ({})),
        },
      },
    };
    const facet = new McpGatekeeperImpl(ctx as never, {
      MCP_PORTAL_HIDDEN_SERVER_IDS: "jira",
    } as never);

    expect(facet.serverName).toBe("CF Portal / Code Mode");
    // No upstream server is fronted, so there is no resource-name prefix to apply.
    expect((facet as unknown as { resourceUriPrefix?: string }).resourceUriPrefix).toBeUndefined();

    const description = await facet.describe();
    expect(description.title).toBe("CF Portal / Code Mode");
    expect(description.snippet).toContain("Code Mode");
    expect(description.url).toBe(CODEMODE_URL);
    expect(description.suggestedBindingName).toBe("MCP_CODEMODE");

    // The upstream tool the portal fronts is outside the grant even though the catalog mentions it.
    await expect(facet.tools()).resolves.toMatchObject([
      { tool: { name: "portal_codemode_search" }, mode: "read", autoApprovable: false },
      { tool: { name: "portal_codemode_execute" }, mode: "action", autoApprovable: false },
    ]);

    const types = await facet.getTypeScriptTypes();
    expect(types).toContain("portal_codemode_search");
    expect(types).toContain("portal_codemode_execute");
    expect(types).not.toContain("jira_search");
    expect(mocks.withClient).not.toHaveBeenCalled();
  });
});
