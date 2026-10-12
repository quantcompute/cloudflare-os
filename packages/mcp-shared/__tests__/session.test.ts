import { expect, it } from "vitest";
import type { AppMessageHookProps } from "../src/app-message-hook.js";

import { McpSessionBase, type McpSessionHost, type StoredAction } from "../src/session.js";
import { MAX_TOOL_NAME_CHARS, type McpTool } from "../src/client.js";
import { classifyTool } from "../src/tools.js";
import type { AppCallSnapshot } from "../src/apps.js";

it("reports an execution failure distinctly from a rejected approval", async () => {
  const failed: StoredAction = {
    id: 1,
    toolName: "send",
    args: {},
    state: "failed",
    submittedAt: 0,
    retryable: false,
    error: "The outcome is unknown.",
  };
  const host = {
    serverName: "Example",
    endpoint: "https://mcp.example.com",
    scope: {},
    lookupAction: () => failed,
  } as unknown as McpSessionHost;
  const session = new McpSessionBase(host, {} as never);

  await expect(session.getActionResult(1)).resolves.toEqual({
    status: "failed",
    message: "The outcome is unknown.",
  });
});

it("tells an agent to return a pending action so its approval can appear in chat", async () => {
  const entry = classifyTool({ name: "jira_create_issue" }, "byo");
  const staged: StoredAction = {
    id: 7,
    toolName: entry.tool.name,
    args: {},
    state: "pending",
    submittedAt: 0,
  };
  const host = {
    serverName: "Jira",
    endpoint: "https://mcp.example.com",
    scope: { serverId: "jira" },
    findTool: async () => entry,
    stageAction: () => staged,
    discardStagedAction() { },
    actionKindFor: () => ({ tag: "jira:create", label: "Create issue" }),
  } as unknown as McpSessionHost;
  const session = new McpSessionBase(host, { submitAction() { } } as never);

  const result = await session.callTool(entry.tool.name);

  expect(result).toMatchObject({ status: "pending", actionId: staged.id });
  if (result.status !== "pending") throw new Error("Expected a pending action.");
  expect(result.message).toContain("return from this executeCode call");
  expect(result.message).not.toMatch(/poll/i);
});

it("searches progressively discovered tools and records the catalog read", async () => {
  const found = classifyTool({
    name: "jira_search_issues",
    description: "Search Jira issues",
    annotations: { readOnlyHint: true },
  }, "byo");
  const observations: unknown[] = [];
  const host = {
    serverName: "Jira",
    endpoint: "https://mcp.example.com",
    scope: { serverId: "jira" },
    searchTools: async () => [found],
  } as unknown as McpSessionHost;
  const queue = {
    authorizeObservation: (description: unknown) => { observations.push(description); },
  };
  const session = new McpSessionBase(host, queue as never);

  await expect(session.listTools({ search: "issues" })).resolves.toEqual([{
    name: "jira_search_issues",
    description: "Search Jira issues",
    mode: "read",
    classifiedBy: "server-annotation",
    inputSchema: undefined,
    title: undefined,
  }]);
  expect(observations).toHaveLength(1);
});

it("calls a tool resolved beyond the initial generated catalog", async () => {
  const expanded = classifyTool({
    name: "jira_search_issues",
    annotations: { readOnlyHint: true },
  }, "byo");
  const host = {
    serverName: "Jira",
    endpoint: "https://mcp.example.com",
    scope: { serverId: "jira" },
    tools: async () => [],
    findTool: async () => expanded,
    call: async (fn: (client: never) => Promise<unknown>) => fn({
      callTool: async () => ({ content: [{ type: "text", text: "PROJ-1" }] }),
    } as never),
  } as unknown as McpSessionHost;
  const observations: { fields?: unknown[] }[] = [];
  const queue = {
    authorizeObservation: (description: { fields?: unknown[] }) => { observations.push(description); },
  };
  const session = new McpSessionBase(host, queue as never);

  await expect(session.callTool("jira_search_issues", { query: "open" })).resolves.toMatchObject({
    status: "ok",
    text: "PROJ-1",
  });
  // The observation records the arguments the read was made with, as the action would.
  expect(observations[0]?.fields).toContainEqual(
    { label: "Arguments", kind: "json", value: '{\n  "query": "open"\n}' });
});

it("identifies the tool in a describe observation", async () => {
  const observations: { description: string }[] = [];
  const host = {
    serverName: "Jira",
    endpoint: "https://mcp.example.com",
    scope: { serverId: "jira" },
    findTool: async () => classifyTool({ name: "jira_search_issues" }, "byo"),
  } as unknown as McpSessionHost;
  const queue = {
    authorizeObservation: (description: { description: string }) => {
      observations.push(description);
    },
  };
  const session = new McpSessionBase(host, queue as never);

  await session.listTools({ name: "jira_search_issues" });
  expect(observations[0].description).toContain("jira_search_issues");
});

it("names the grant, not the server, when a scoped binding lacks the tool", async () => {
  // On a scoped binding the tool may well exist on the endpoint. "No such tool" would send an agent
  // hunting for a typo it will not find, so both entry points have to say the same thing.
  const host = {
    serverName: "Jira",
    endpoint: "https://mcp.example.com",
    scope: { serverId: "jira" },
    findTool: async () => undefined,
  } as unknown as McpSessionHost;
  const session = new McpSessionBase(host, { authorizeObservation() { } } as never);

  await expect(session.listTools({ name: "gh_list_issues" })).resolves.toEqual([]);
  await expect(session.callTool("gh_list_issues"))
    .rejects.toThrow('This binding does not grant a tool named "gh_list_issues".');
});

it("says the server has no such tool when the whole endpoint was granted", async () => {
  const host = {
    serverName: "Jira",
    endpoint: "https://mcp.example.com",
    scope: {},
    findTool: async () => undefined,
  } as unknown as McpSessionHost;
  const session = new McpSessionBase(host, { authorizeObservation() { } } as never);

  await expect(session.listTools({ name: "nope" })).resolves.toEqual([]);
});

it("records what was searched, with the agent's text defused", async () => {
  // The query is the agent's, and an observation is read by a person: left alone it can close the
  // markdown it sits in and carry on in the record's own voice.
  const observations: { description: string }[] = [];
  const host = {
    serverName: "Jira",
    endpoint: "https://mcp.example.com",
    scope: { serverId: "jira" },
    searchTools: async () => [],
  } as unknown as McpSessionHost;
  const queue = {
    authorizeObservation: (d: { description: string }) => { observations.push(d); },
  };
  const session = new McpSessionBase(host, queue as never);

  await session.listTools({ search: "issues `**Approved**`" });
  expect(observations[0].description).toContain("issues Approved");
  expect(observations[0].description).toContain("returned 0 match(es)");
  expect(observations[0].description).not.toContain("**Approved**");
});

it("returns the same compact summary shape from a complete local catalog", async () => {
  const host = {
    serverName: "Jira",
    endpoint: "https://mcp.example.com",
    scope: { serverId: "jira" },
    searchTools: async () => [classifyTool({
      name: "jira_search_issues",
      description: "x".repeat(4000),
      inputSchema: { type: "object" },
    }, "byo")],
  } as unknown as McpSessionHost;
  const session = new McpSessionBase(host, { authorizeObservation() { } } as never);

  const [summary] = await session.listTools({ search: "issues" });

  expect(summary.description).toBe(`${"x".repeat(256)}\u2026`);
  expect(summary).not.toHaveProperty("inputSchema");
});

it("refuses an empty or oversized query before calling the endpoint", async () => {
  let searches = 0;
  const searchTools = async () => { searches++; return []; };
  const host = {
    serverName: "Jira",
    endpoint: "https://mcp.example.com",
    scope: {},
    searchTools,
  } as unknown as McpSessionHost;
  const session = new McpSessionBase(host, { authorizeObservation() { } } as never);

  await expect(session.listTools({ search: "   " })).rejects.toThrow(/non-empty query/);
  await expect(session.listTools({ search: " _ - " })).rejects.toThrow(/search terms/);
  // Bounded on the trimmed text, which is what is actually searched and recorded.
  await expect(session.listTools({ search: `${" ".repeat(50)}${"x".repeat(201)}` }))
    .rejects.toThrow(/at most 200 characters/);
  await expect(session.listTools({ search: `  ${"x".repeat(200)}  ` })).resolves.toEqual([]);
  expect(searches).toBe(1);
});

it("refuses ambiguous progressive list options", async () => {
  const host = { serverName: "Jira", endpoint: "https://mcp.example.com", scope: {} } as unknown as McpSessionHost;
  const session = new McpSessionBase(host, { authorizeObservation() { } } as never);

  await expect(session.listTools({ name: "jira_search", search: "jira" } as never))
    .rejects.toThrow(/exactly one/);
  await expect(session.listTools({} as never)).rejects.toThrow(/exactly one/);
});

it("treats optional selectors set to undefined as absent", async () => {
  const found = classifyTool({ name: "jira_search", annotations: { readOnlyHint: true } }, "byo");
  const host = {
    serverName: "Jira",
    endpoint: "https://mcp.example.com",
    scope: {},
    searchTools: async () => [found],
    findTool: async () => found,
  } as unknown as McpSessionHost;
  const session = new McpSessionBase(host, { authorizeObservation() { } } as never);

  await expect(session.listTools({ search: "jira", name: undefined }))
    .resolves.toHaveLength(1);
  await expect(session.listTools({ name: "jira_search", search: undefined }))
    .resolves.toHaveLength(1);
});

it("refuses oversized tool names before consulting the host", async () => {
  let finds = 0;
  const host = {
    serverName: "Jira",
    endpoint: "https://mcp.example.com",
    scope: {},
    findTool: async () => { finds++; return undefined; },
  } as unknown as McpSessionHost;
  const session = new McpSessionBase(host, { authorizeObservation() { } } as never);
  const oversized = "x".repeat(MAX_TOOL_NAME_CHARS + 1);

  await expect(session.listTools({ name: oversized })).rejects.toThrow(/tool name.*at most/i);
  await expect(session.callTool(oversized)).rejects.toThrow(/tool name.*at most/i);
  expect(finds).toBe(0);
});

it("offers the sidecar link a tool declares for its results", async () => {
  const tool: McpTool = {
    name: "jira_search_issues",
    title: "Search issues",
    annotations: { readOnlyHint: true },
    ui: { resourceUri: "ui://jira/search" },
  };
  const minted: AppCallSnapshot[] = [];
  const host = {
    serverName: "Jira",
    endpoint: "https://mcp.example.com",
    scope: {},
    findTool: async () => classifyTool(tool, "byo"),
    normalizeAppResourceUri: (uri: string) => uri,
    appLink: async (uri: string, call: AppCallSnapshot) => {
      minted.push(call);
      return `https://gadgets.example/app/${uri}`;
    },
    call: async (fn: (client: never) => Promise<unknown>) => fn({
      callTool: async () => ({ content: [{ type: "text", text: "PROJ-1" }] }),
    } as never),
  } as unknown as McpSessionHost;
  const session = new McpSessionBase(host, { authorizeObservation() { } } as never);

  const result = await session.callTool("jira_search_issues", { query: "open" });
  expect(result).toMatchObject({
    status: "ok",
    app: {
      uri: "ui://jira/search",
      url: "https://gadgets.example/app/ui://jira/search",
      title: "Search issues",
    },
  });
  if (result.status !== "ok") throw new Error("expected an ok result");
  // The link does nothing until it is subscribed, and this result is where the agent decides whether
  // to relay it, so the instruction leads both the content and the concatenated text.
  expect(result.content[0]).toMatchObject({ type: "text" });
  expect(result.content[1]).toMatchObject({ type: "text", text: "PROJ-1" });
  expect(result.text).toContain("ACTION REQUIRED");
  expect(result.text.endsWith("PROJ-1")).toBe(true);
  // The sidecar replays the call, so it is given the input the agent passed and the server's own
  // result, never a pointer to a session it cannot reach.
  expect(minted).toHaveLength(1);
  expect(minted[0]).toMatchObject({
    toolName: "jira_search_issues",
    input: { query: "open" },
    result: { content: [{ type: "text", text: "PROJ-1" }] },
  });
  // Wire shape, not this host's flattened vocabulary: a View parses the result with MCP's schema.
  expect(minted[0].result).not.toHaveProperty("status");
  expect(minted[0].result).not.toHaveProperty("text");
});

it("names a declared resource the way a renaming binding serves it", async () => {
  // A portal answers a resource it fronts under `{serverId}_{uri}` and refuses the upstream's own
  // name, so the declared `ui://` name is prefixed by the host before it becomes the link's identity.
  const tool: McpTool = {
    name: "jira_search_issues",
    annotations: { readOnlyHint: true },
    ui: { resourceUri: "ui://jira/search" },
  };
  const minted: string[] = [];
  const host = {
    serverName: "Portal",
    endpoint: "https://mcp.example.com",
    scope: {},
    findTool: async () => classifyTool(tool, "byo"),
    normalizeAppResourceUri: (uri: string) => `netsuite-sb1_${uri}`,
    appLink: async (uri: string) => {
      minted.push(uri);
      return `https://gadgets.example/app/${uri}`;
    },
    call: async (fn: (client: never) => Promise<unknown>) => fn({
      callTool: async () => ({ content: [{ type: "text", text: "ok" }] }),
    } as never),
  } as unknown as McpSessionHost;
  const session = new McpSessionBase(host, { authorizeObservation() { } } as never);

  const result = await session.callTool("jira_search_issues");

  if (result.status !== "ok") throw new Error("expected an ok result");
  expect(result.app?.uri).toBe("netsuite-sb1_ui://jira/search");
  expect(minted).toEqual(["netsuite-sb1_ui://jira/search"]);
});

it("subscribes to an app link through the props the account resolves", async () => {
  const props: AppMessageHookProps = {
    accountId: "a1".repeat(32),
    token: "c".repeat(64),
    uri: "ui://jira/search",
    serverName: "Jira",
  };
  const controller = { enable: async () => { } };
  const asked: [string, string][] = [];
  const minted: AppMessageHookProps[] = [];
  const bound: { controller: unknown; hook: unknown; description: Record<string, string> }[] = [];
  const host = {
    serverName: "Jira",
    endpoint: "https://mcp.example.com",
    scope: {},
    appMessageHookProps: async (accountId: string, token: string) => {
      asked.push([accountId, token]);
      return props;
    },
    appMessageHook: (given: AppMessageHookProps) => {
      minted.push(given);
      return controller;
    },
  } as unknown as McpSessionHost;
  const queue = {
    bindHook: async (given: unknown, hook: unknown, description: Record<string, string>) => {
      bound.push({ controller: given, hook, description });
    },
  };
  const session = new McpSessionBase(host, queue as never);
  const hook = { receiveAppMessage: async () => { } };

  await session.subscribeAppMessages(
    `https://gadgets.example/app/${props.accountId}/${props.token}`, hook as never);

  // The account is what decides whether the link is live and what it renders; the session adds
  // nothing to the props but the server's own name, which it carries.
  expect(asked).toEqual([[props.accountId, props.token]]);
  expect(minted).toEqual([props]);
  expect(bound[0]?.controller).toBe(controller);
  expect(bound[0]?.hook).toBe(hook);
  // The description is everything the user reads before enabling, so it names the app and the
  // server and says what stops a delivery.
  expect(bound[0]?.description.title).toContain("ui://jira/search");
  expect(bound[0]?.description.description).toContain("Jira");
  expect(bound[0]?.description.description).toMatch(/disabled/);
});

it("refuses a subscription to anything that is not a live link of this server", async () => {
  const asked: [string, string][] = [];
  const host = {
    serverName: "Jira",
    endpoint: "https://mcp.example.com",
    scope: {},
    appMessageHookProps: async (accountId: string, token: string) => {
      asked.push([accountId, token]);
      return undefined;
    },
  } as unknown as McpSessionHost;
  // Nothing may be bound for a link the account does not hold: a hook that could never deliver
  // would still ask the user to enable it.
  const queue = { bindHook: async () => { throw new Error("nothing may be bound"); } };
  const session = new McpSessionBase(host, queue as never);
  const hook = { receiveAppMessage: async () => { } };

  // A URL that is not this deployment's `/app/<account>/<token>` is refused before the account is
  // asked, so a wrong url costs no round trip and the agent is told what it should have passed.
  const malformed = [
    "",
    "not a url",
    "https://gadgets.example/app/only-two",
    "https://gadgets.example/app/a/b/extra",
    "https://gadgets.example/other/a/b",
  ];
  for (const url of malformed) {
    await expect(session.subscribeAppMessages(url, hook as never))
      .rejects.toThrow(/app links/);
  }
  expect(asked).toEqual([]);

  // And a link the account does not hold -- a token of another account, or one whose link has
  // expired -- is refused as one it cannot deliver for.
  const url = `https://gadgets.example/app/${"a1".repeat(32)}/${"c".repeat(64)}`;
  await expect(session.subscribeAppMessages(url, hook as never))
    .rejects.toThrow(/not one this account can deliver for/);
  expect(asked).toEqual([["a1".repeat(32), "c".repeat(64)]]);
});

it("accepts the link a connector mints under its own base path", async () => {
  // Every real link is minted as `<baseUrl>/app/<account>/<token>`, and a connector's base URL
  // ends in `/gatekeeper/<slug>`: a parse that assumed the link sat at the origin root refused
  // every link the platform handed an agent, and told it the app.url it had just been given was
  // not one.
  const props: AppMessageHookProps = {
    accountId: "4f".repeat(32),
    token: "32".repeat(32),
    uri: "netsuite-sb1_ui://SuiteApps/com.netsuite.mcpstandardtools/universal-selector/index.html",
    serverName: "MCP Server Portal (mcp.fnbullion.com) / netsuite-sb1",
  };
  const asked: [string, string][] = [];
  const bound: unknown[] = [];
  const host = {
    serverName: props.serverName,
    endpoint: "https://mcp.fnbullion.com/mcp",
    scope: {},
    appMessageHookProps: async (accountId: string, token: string) => {
      asked.push([accountId, token]);
      return props;
    },
    appMessageHook: () => ({ enable: async () => { } }),
  } as unknown as McpSessionHost;
  const queue = { bindHook: async (...args: unknown[]) => { bound.push(args); } };
  const session = new McpSessionBase(host, queue as never);

  await session.subscribeAppMessages(
    `http://localhost:8787/gatekeeper/mcp-portal/app/${props.accountId}/${props.token}`,
    { receiveAppMessage: async () => { } } as never);

  expect(asked).toEqual([[props.accountId, props.token]]);
  expect(bound).toHaveLength(1);
});

it("mints a link for a result that names a ui:// resource itself", async () => {
  const host = {
    serverName: "Jira",
    endpoint: "https://mcp.example.com",
    scope: {},
    findTool: async () => classifyTool({
      name: "jira_report",
      annotations: { readOnlyHint: true },
    }, "byo"),
    normalizeAppResourceUri: (uri: string) => uri,
    appLink: async (uri: string) => `https://gadgets.example/app/${uri}`,
    call: async (fn: (client: never) => Promise<unknown>) => fn({
      callTool: async () => ({
        content: [{ type: "resource_link", uri: "ui://jira/report", name: "Report" }],
      }),
    } as never),
  } as unknown as McpSessionHost;
  const session = new McpSessionBase(host, { authorizeObservation() { } } as never);

  const result = await session.callTool("jira_report");
  if (result.status !== "ok") throw new Error("Expected a result.");
  // A tool that named no view contributes no display name to the link.
  expect(result.app).toEqual({
    uri: "ui://jira/report",
    url: "https://gadgets.example/app/ui://jira/report",
  });
});

it("leaves the result untouched when no link can be minted", async () => {
  // A view is an extra on top of a result the agent already has: a host that refuses to mint one,
  // and a host with no way to mint one at all, must both hand the result back unchanged.
  const entry = classifyTool({
    name: "jira_search_issues",
    annotations: { readOnlyHint: true },
    ui: { resourceUri: "ui://jira/search" },
  }, "byo");
  const base = {
    serverName: "Jira",
    endpoint: "https://mcp.example.com",
    scope: {},
    findTool: async () => entry,
    call: async (fn: (client: never) => Promise<unknown>) => fn({
      callTool: async () => ({ content: [{ type: "text", text: "PROJ-1" }] }),
    } as never),
  };
  const queue = { authorizeObservation() { } } as never;
  const refusing = new McpSessionBase({
    ...base,
    appLink: async () => { throw new Error("the endpoint is unreachable"); },
  } as unknown as McpSessionHost, queue);
  const absent = new McpSessionBase(base as unknown as McpSessionHost, queue);

  for (const session of [refusing, absent]) {
    await expect(session.callTool("jira_search_issues")).resolves.toEqual({
      status: "ok",
      content: [{ type: "text", text: "PROJ-1" }],
      text: "PROJ-1",
      structuredContent: undefined,
      isError: undefined,
    });
  }
});

it("offers no view for a result the tool reported as an error", async () => {
  let mints = 0;
  const host = {
    serverName: "Jira",
    endpoint: "https://mcp.example.com",
    scope: {},
    findTool: async () => classifyTool({
      name: "jira_search_issues",
      annotations: { readOnlyHint: true },
      ui: { resourceUri: "ui://jira/search" },
    }, "byo"),
    appLink: async () => { mints++; return "https://gadgets.example/app/ui://jira/search"; },
    call: async (fn: (client: never) => Promise<unknown>) => fn({
      callTool: async () => ({ content: [{ type: "text", text: "boom" }], isError: true }),
    } as never),
  } as unknown as McpSessionHost;
  const session = new McpSessionBase(host, { authorizeObservation() { } } as never);

  const result = await session.callTool("jira_search_issues");
  if (result.status !== "ok") throw new Error("Expected a result.");
  expect(result).toMatchObject({ text: "boom", isError: true });
  expect(result.app).toBeUndefined();
  expect(mints).toBe(0);
});

it("offers the link for an approved action's stored result", async () => {
  const applied: StoredAction = {
    id: 4,
    toolName: "jira_create_issue",
    args: { summary: "Fix login" },
    state: "applied",
    submittedAt: 0,
    result: { status: "ok", content: [{ type: "text", text: "PROJ-9" }], text: "PROJ-9" },
  };
  const minted: AppCallSnapshot[] = [];
  const host = {
    serverName: "Jira",
    endpoint: "https://mcp.example.com",
    scope: {},
    lookupAction: () => applied,
    // The action store kept the flattened result, so the tool's own definition is what still knows
    // about the view.
    findTool: async () => classifyTool({
      name: "jira_create_issue",
      title: "Create issue",
      ui: { resourceUri: "ui://jira/issue" },
    }, "byo"),
    appLink: async (uri: string, call: AppCallSnapshot) => {
      minted.push(call);
      return `https://gadgets.example/app/${uri}`;
    },
  } as unknown as McpSessionHost;
  const session = new McpSessionBase(host, { authorizeObservation() { } } as never);

  const result = await session.getActionResult(4);
  expect(result).toMatchObject({
    status: "ok",
    app: {
      uri: "ui://jira/issue",
      url: "https://gadgets.example/app/ui://jira/issue",
      title: "Create issue",
    },
  });
  if (result.status !== "ok") throw new Error("expected an ok result");
  // A queued call's outcome is decorated exactly like a read's: the agent decides on the link here
  // too, so the subscription step is stated here too.
  expect(result.text).toContain("ACTION REQUIRED");
  expect(result.text.endsWith("PROJ-9")).toBe(true);
  expect(minted[0]).toMatchObject({
    toolName: "jira_create_issue",
    input: { summary: "Fix login" },
    result: { content: [{ type: "text", text: "PROJ-9" }] },
  });
  expect(minted[0].result).not.toHaveProperty("status");
});

it("offers the link for a result that named its own view", async () => {
  // A server may declare the view on the call's own result rather than on the tool -- the playground
  // servers do -- and the store keeps the flattened result, whose `_meta` is gone. The association is
  // therefore read where it can still be seen, while the call is being applied.
  const applied: StoredAction = {
    id: 6,
    toolName: "get_mcp_app_demo",
    args: {},
    state: "applied",
    submittedAt: 0,
    result: {
      status: "ok",
      content: [{ type: "text", text: "Dashboard ready" }],
      text: "Dashboard ready",
    },
    appUri: "ui://demo/dashboard",
  };
  const host = {
    serverName: "MCP Playground",
    endpoint: "https://mcp.example.com",
    scope: {},
    lookupAction: () => applied,
    findTool: async () => classifyTool({ name: "get_mcp_app_demo" }, "byo"),
    appLink: async (uri: string) => `https://gadgets.example/app/${uri}`,
  } as unknown as McpSessionHost;
  const session = new McpSessionBase(host, { authorizeObservation() { } } as never);

  const result = await session.getActionResult(6);
  expect(result).toMatchObject({
    status: "ok",
    app: {
      uri: "ui://demo/dashboard",
      url: "https://gadgets.example/app/ui://demo/dashboard",
    },
  });
  if (result.status !== "ok") throw new Error("expected an ok result");
  expect(result.text).toContain("ACTION REQUIRED");
  expect(result.text.endsWith("Dashboard ready")).toBe(true);
});

it("states the subscription step in the result the agent decides on", async () => {
  // The imperative also lives in the generated session type, but an agent reads that before it holds
  // a result -- and the app's own content competes for the same decision, telling the model to
  // ignore the result and wait for the app. So the wording is part of the contract and is asserted
  // here: a relayed-but-unsubscribed link renders perfectly well and sends nothing, and the person
  // has no way to tell why.
  const appUrl = "https://gadgets.example/app/ui://jira/search";
  const host = {
    serverName: "Jira",
    endpoint: "https://mcp.example.com",
    scope: {},
    findTool: async () => classifyTool({
      name: "jira_search_issues",
      title: "Search issues",
      annotations: { readOnlyHint: true },
      ui: { resourceUri: "ui://jira/search" },
    }, "byo"),
    appLink: async () => appUrl,
    call: async (fn: (client: never) => Promise<unknown>) => fn({
      callTool: async () => ({ content: [{ type: "text", text: "PROJ-1" }] }),
    } as never),
  } as unknown as McpSessionHost;
  const session = new McpSessionBase(host, { authorizeObservation() { } } as never);

  const result = await session.callTool("jira_search_issues", {});
  if (result.status !== "ok") throw new Error("expected an ok result");
  const instruction = (result.content[0] as { text: string }).text;
  expect(instruction).toContain("ACTION REQUIRED");
  // The exact call, with the link the result is about and the subscriber that lands in this chat.
  expect(instruction).toContain(`subscribeAppMessages("${appUrl}", self)`);
  // Same turn, because a link relayed first is a link nobody subscribed.
  expect(instruction).toContain("in this same turn");
  // One subscription per link, not one per result: each bindHook is another Connections entry.
  expect(instruction).toContain("already subscribed");
});

it("prefers the tool's declared view over the one its result named", async () => {
  // Both are declarations of what renders this call, and the tool's is the broader statement: it was
  // written for every call the tool makes, where a result describes only the call it came from.
  const applied: StoredAction = {
    id: 7,
    toolName: "jira_create_issue",
    args: {},
    state: "applied",
    submittedAt: 0,
    result: { status: "ok", content: [], text: "PROJ-9" },
    appUri: "ui://jira/other",
  };
  const host = {
    serverName: "Jira",
    endpoint: "https://mcp.example.com",
    scope: {},
    lookupAction: () => applied,
    findTool: async () => classifyTool({
      name: "jira_create_issue",
      ui: { resourceUri: "ui://jira/issue" },
    }, "byo"),
    appLink: async (uri: string) => `https://gadgets.example/app/${uri}`,
  } as unknown as McpSessionHost;
  const session = new McpSessionBase(host, { authorizeObservation() { } } as never);

  await expect(session.getActionResult(7)).resolves.toMatchObject({
    app: { uri: "ui://jira/issue" },
  });
});

it("returns an applied result even when the tool can no longer be read", async () => {
  // The catalog may be unreachable by the time the Gadget collects the outcome. Losing the view is
  // acceptable; losing the result an approval produced is not.
  const applied: StoredAction = {
    id: 5,
    toolName: "jira_create_issue",
    args: {},
    state: "applied",
    submittedAt: 0,
    result: { status: "ok", content: [], text: "done" },
  };
  const host = {
    serverName: "Jira",
    endpoint: "https://mcp.example.com",
    scope: {},
    lookupAction: () => applied,
    findTool: async () => { throw new Error("the endpoint is unreachable"); },
    appLink: async () => "https://gadgets.example/app/ui://jira/issue",
  } as unknown as McpSessionHost;
  const session = new McpSessionBase(host, { authorizeObservation() { } } as never);

  await expect(session.getActionResult(5)).resolves.toEqual({
    status: "ok",
    content: [],
    text: "done",
  });
});
