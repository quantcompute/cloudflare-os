// The subscription an app link's view messages are delivered through: what the account files when
// the user enables the hook, and what `/rpc` does with a `ui/message` afterwards.
//
// Exercised against the account itself -- a fake Durable Object context and its storage map -- since
// the delivery path is the account's. The pure halves have their own suites: the plan and the URL in
// `app-tokens`, the parameter rule in `app-gateway`, and the consent page in `app-page`.

import { describe, expect, it } from "vitest";

import { McpAccountBase, type AccountEnv } from "../src/account.js";
import {
    AppMessageHookController,
    type AppMessageHookProps,
    type McpAppMessage,
} from "../src/app-message-hook.js";
import { appMessageHookKey, appTokenKey } from "../src/app-tokens.js";
import type { AppBinding } from "../src/apps.js";

const ACCOUNT_ID = "a1".repeat(32);
const URI = "ui://events/board";
const BASE_URL = "https://gatekeeper.example";
const SERVER_NAME = "Example MCP";

const binding: AppBinding = {
  endpoint: "https://mcp.example/rpc",
  serverName: SERVER_NAME,
  scope: {},
  trust: "byo",
};

function fakeContext() {
  const values = new Map<string, unknown>();
  return {
    values,
    ctx: {
      id: { toString: () => ACCOUNT_ID },
      storage: {
        async deleteAlarm() { },
        async setAlarm() { },
        async deleteAll() { values.clear(); },
        kv: {
          get<T>(key: string) { return values.get(key) as T | undefined; },
          put<T>(key: string, value: T) { values.set(key, value); },
          delete(key: string) { return values.delete(key); },
        },
      },
    },
  };
}

const testLog = { with() { return testLog; }, info() { }, warn() { } };

class TestAccount extends McpAccountBase<AccountEnv> {
  protected baseUrl(): string { return BASE_URL; }
  protected log(): never { return testLog as never; }
  protected mintAccount(): never { throw new Error("not reached"); }
}

function account() {
  const { values, ctx } = fakeContext();
  return { values, subject: new TestAccount(ctx as never, {} as never) };
}

function propsOf(token: string): AppMessageHookProps {
  return { accountId: ACCOUNT_ID, token, uri: URI, serverName: SERVER_NAME };
}

/** One `ui/message` request, shaped as the page posts it. */
function uiMessage(id: number, params: unknown): string {
  return JSON.stringify({ jsonrpc: "2.0", id, method: "ui/message", params });
}

function bodyOf(reply: { body: string }): Record<string, unknown> {
  return JSON.parse(reply.body) as Record<string, unknown>;
}

function tokenOf(url: string): string {
  return new URL(url).pathname.split("/").pop() as string;
}

/**
 * The initiator a controller files, recording the calls one delivery makes through it.
 *
 * `startHook()` answers the shape workerd's RPC does -- a pair of stubs the caller disposes when the
 * firing is over -- so the account can use it exactly as it uses the real one.
 */
function fakeInitiator() {
  const calls: string[] = [];
  const observations: { title: string; description: string }[] = [];
  const delivered: McpAppMessage[] = [];
  const initiator = {
    async startHook() {
      calls.push("startHook");
      return {
        [Symbol.dispose]() { calls.push("dispose"); },
        approvalQueue: {
          async authorizeObservation(description: { title: string; description: string }) {
            calls.push("authorizeObservation");
            observations.push(description);
          },
        },
        callback: {
          async receiveAppMessage(message: McpAppMessage) {
            calls.push("receiveAppMessage");
            delivered.push(message);
          },
        },
      };
    },
  };
  return { initiator, calls, observations, delivered };
}

describe("what an enable files", () => {
  it("stores the initiator beside the link's own facts, and forgets both on disable", async () => {
    const { values, subject } = account();
    const url = await subject.mintAppLink(binding, { uri: URI });
    const token = tokenOf(url);
    const props = propsOf(token);
    const { initiator } = fakeInitiator();

    await subject.registerAppMessageHook(props, initiator as never);

    // The registration is what a delivery reaches the conversation through, so it lives under a key
    // of its own rather than inside the record the mint measured.
    expect(values.get("appMessageHook:" + token)).toEqual({ initiator, props });
    expect(values.get(appTokenKey(token))).not.toHaveProperty("initiator");

    await subject.unregisterAppMessageHook(props);
    expect(values.has(appMessageHookKey(token))).toBe(false);
  });

  it("refuses an enable for another account's link, and stores nothing", async () => {
    const { values, subject } = account();
    const url = await subject.mintAppLink(binding, { uri: URI });
    const token = tokenOf(url);
    const { initiator } = fakeInitiator();

    await expect(subject.registerAppMessageHook(
      { ...propsOf(token), accountId: "b2".repeat(32) }, initiator as never,
    )).rejects.toThrow(/app link has expired/);
    expect(values.has(appMessageHookKey(token))).toBe(false);
  });

  it("refuses an enable for a link that is no longer live, and clears any earlier one", async () => {
    const { values, subject } = account();
    const url = await subject.mintAppLink(binding, { uri: URI });
    const token = tokenOf(url);
    const props = propsOf(token);
    const { initiator } = fakeInitiator();
    await subject.registerAppMessageHook(props, initiator as never);
    const record = values.get(appTokenKey(token)) as { expiresAt: number };
    values.set(appTokenKey(token), { ...record, expiresAt: 0 });

    await expect(subject.registerAppMessageHook(props, initiator as never))
      .rejects.toThrow(/app link has expired/);
    // The user is told their enable could not deliver anything; leaving the earlier registration
    // behind would be storage nothing would ever collect.
    expect(values.has(appMessageHookKey(token))).toBe(false);
  });
});

describe("resolving a link for a subscription", () => {
  it("answers the resource of a live link of this account, and nothing else", async () => {
    const { values, subject } = account();
    const url = await subject.mintAppLink(binding, { uri: URI });
    const token = tokenOf(url);

    await expect(subject.appLinkResource(ACCOUNT_ID, token)).resolves.toEqual({ uri: URI });
    // A token of another account, a token this account never minted, and one whose link has expired
    // are all the same answer: nothing to subscribe to.
    await expect(subject.appLinkResource("b2".repeat(32), token)).resolves.toBeUndefined();
    await expect(subject.appLinkResource(ACCOUNT_ID, "f".repeat(64))).resolves.toBeUndefined();
    const record = values.get(appTokenKey(token)) as { expiresAt: number };
    values.set(appTokenKey(token), { ...record, expiresAt: 0 });
    await expect(subject.appLinkResource(ACCOUNT_ID, token)).resolves.toBeUndefined();
  });
});

describe("ui/message at /rpc", () => {
  it("delivers through the registered initiator, authorized and keyed", async () => {
    const { subject } = account();
    const url = await subject.mintAppLink(binding, { uri: URI });
    const token = tokenOf(url);
    const { initiator, calls, observations, delivered } = fakeInitiator();
    await subject.registerAppMessageHook(propsOf(token), initiator as never);

    const reply = await subject.callApp(token, uiMessage(7, {
      role: "user", content: [{ type: "text", text: "hello" }], key: "send-1",
    }));

    expect(bodyOf(reply)).toEqual({ jsonrpc: "2.0", id: 7, result: {} });
    expect(reply.status).toBe(200);
    // The firing is opened first, then the observation the hook contract requires, then the
    // callback: the message is what the app wrote, under the link's own resource, key and all.
    expect(calls).toEqual(["startHook", "authorizeObservation", "receiveAppMessage", "dispose"]);
    expect(delivered).toEqual([{ uri: URI, text: "hello", key: "send-1" }]);
    // The observation names the server the link belongs to and says what was delivered.
    expect(observations[0]?.title).toContain(SERVER_NAME);
    expect(observations[0]?.description).toContain(URI);
  });

  it("mints a key when the sender chose none, and forwards one it chose unchanged", async () => {
    const { subject } = account();
    const url = await subject.mintAppLink(binding, { uri: URI });
    const token = tokenOf(url);
    const { initiator, delivered } = fakeInitiator();
    await subject.registerAppMessageHook(propsOf(token), initiator as never);

    await subject.callApp(token, uiMessage(8, {
      role: "user", content: [{ type: "text", text: "hello" }],
    }));
    // A hand-rolled caller of `/rpc` that declared no key gets one per request, random and
    // well-formed (the page always declares one -- see below).
    expect(delivered[0]?.key).toMatch(/^[0-9a-f-]{36}$/);

    const request = uiMessage(11, {
      role: "user", content: [{ type: "text", text: "hello" }], key: "send-1",
    });
    // The page posts once, but the transport may repeat the request; the key travels unchanged so
    // the conversation -- which owns the dedupe, not this connector -- recognises the repeat as the
    // delivery it already applied.
    for (let repeat = 0; repeat < 2; repeat++) await subject.callApp(token, request);
    expect(delivered.slice(1)).toEqual([
      { uri: URI, text: "hello", key: "send-1" },
      { uri: URI, text: "hello", key: "send-1" },
    ]);
  });

  it("refuses a message whose declared key is not one it can pass on", async () => {
    const { subject } = account();
    const url = await subject.mintAppLink(binding, { uri: URI });
    const token = tokenOf(url);
    const { initiator, delivered } = fakeInitiator();
    await subject.registerAppMessageHook(propsOf(token), initiator as never);
    const unusable = [
      { key: "x".repeat(129) },
      { key: "bad\u0007key" },
      { key: 5 },
    ];

    for (const params of unusable) {
      const reply = await subject.callApp(token, uiMessage(12, {
        role: "user", content: [{ type: "text", text: "hello" }], ...params,
      }));
      // Delivered under a key of this host's choosing would break the sender's own retries, so the
      // request is refused instead of being silently re-identified.
      expect(bodyOf(reply).error).toEqual({ code: -32602, message: expect.any(String) });
    }
    expect(delivered).toEqual([]);
  });

  it("refuses a message that is not text, and opens no firing", async () => {
    const { subject } = account();
    const url = await subject.mintAppLink(binding, { uri: URI });
    const token = tokenOf(url);
    const { initiator, calls, delivered } = fakeInitiator();
    await subject.registerAppMessageHook(propsOf(token), initiator as never);

    const reply = await subject.callApp(token, uiMessage(3, {
      role: "user", content: [{ type: "image", data: "AAAA" }],
    }));

    expect(bodyOf(reply).error).toEqual({ code: -32602, message: expect.any(String) });
    expect(delivered).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("tells the sender nothing is subscribed when no initiator is registered", async () => {
    const { subject } = account();
    const url = await subject.mintAppLink(binding, { uri: URI });
    const token = tokenOf(url);

    const reply = await subject.callApp(token, uiMessage(9, {
      role: "user", content: [{ type: "text", text: "hello" }],
    }));

    // The one sentence a person reading the window can act on: the chat is not subscribed yet.
    expect(reply.status).toBe(200);
    expect(bodyOf(reply)).toEqual({
      jsonrpc: "2.0", id: 9,
      error: { code: -32601, message: expect.stringMatching(/subscribe/) },
    });
  });

  it("answers a delivery the subscription refused as an error, never as success", async () => {
    const { subject } = account();
    const url = await subject.mintAppLink(binding, { uri: URI });
    const token = tokenOf(url);
    await subject.registerAppMessageHook(propsOf(token), {
      // A disabled or deleted subscription: the hook's own queue refuses before the message travels.
      async startHook() { throw new Error("Hook has been deleted or disabled."); },
    } as never);

    const reply = await subject.callApp(token, uiMessage(4, {
      role: "user", content: [{ type: "text", text: "hello" }],
    }));

    // An error frame, not `{}`: the app must not believe a message landed when it did not.
    expect(bodyOf(reply)).toEqual({
      jsonrpc: "2.0", id: 4, error: { code: -32603, message: expect.any(String) },
    });
  });

  it("refuses an expired link before reading the message, and forgets its subscription", async () => {
    const { values, subject } = account();
    const url = await subject.mintAppLink(binding, { uri: URI });
    const token = tokenOf(url);
    const { initiator, calls } = fakeInitiator();
    await subject.registerAppMessageHook(propsOf(token), initiator as never);
    // Backdate the record past its expiry; the subscription is irrelevant to that decision.
    const record = values.get(appTokenKey(token)) as { expiresAt: number };
    values.set(appTokenKey(token), { ...record, expiresAt: 0 });

    const reply = await subject.callApp(token, uiMessage(5, {
      role: "user", content: [{ type: "text", text: "hello" }],
    }));

    expect(bodyOf(reply).error).toEqual({ code: -32001, message: expect.any(String) });
    expect(calls).toEqual([]);
    // A token no live record names can deliver nothing, so its registration goes with the record.
    expect(values.has(appMessageHookKey(token))).toBe(false);
  });
});

describe("the controller a connector exports", () => {
  it("files the initiator with the account its props name, and forgets it again", async () => {
    const filed: { props: unknown; initiator: unknown }[] = [];
    const forgotten: unknown[] = [];
    const ctx = {
      props: propsOf("c".repeat(64)),
      exports: {
        McpAccount: {
          idFromString: (id: string) => id,
          get: (id: string) => {
            expect(id).toBe(ACCOUNT_ID);
            return {
              registerAppMessageHook: async (props: unknown, initiator: unknown) => {
                filed.push({ props, initiator });
              },
              unregisterAppMessageHook: async (props: unknown) => { forgotten.push(props); },
            };
          },
        },
      },
    };
    const controller = new AppMessageHookController(ctx as never, {} as never);
    const initiator = { startHook: async () => ({}) };

    await controller.enable(initiator as never, { workspaceId: "ws" } as never);
    await controller.disable();

    // The props travel untouched, so the account can file the registration under the link's token
    // without knowing how the controller found it.
    expect(filed).toEqual([{ props: ctx.props, initiator }]);
    expect(forgotten).toEqual([ctx.props]);
  });
});
