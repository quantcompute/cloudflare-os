// The MCP App view's way back into the conversation, rebuilt on the hook machinery: the caller
// subscribes with the app link it was given and a stub of its own (in production the agent's
// `self`), the user enables the resulting hook, and the account fires it when the view's page
// posts `ui/message`. The message lands in the chat as an ordinary agentCallback and starts it.
//
// The fixture's TestControl plays the connector's session and account sides through
// /control/register-app-link and /control/deliver-app-view-message; the subscription, the hook
// lifecycle, and the delivery all run through the real Workshop.

import { afterAll, beforeAll, expect, it } from "vitest";
import type { RpcStub } from "capnweb";
import type { AiChatMessage, Overseer, PublicApi } from "@gadgets/workshop-shared/api";
import { loadAllChatHistory } from "../src/agent-session.js";
import {
  startTestGatekeeperHarness, TEST_VENDOR_ID, testControl, type Harness,
} from "../src/harness.js";
import {
  SCRIPTED_MODEL_ID, scriptedModelRouter, type RoutedScriptedModel,
} from "../src/mock-model.js";
import { NetworkInterceptor } from "../src/network-interceptor.js";
import {
  connect, listConnectedAccounts, nextUsernames, signUp, waitFor, waitForIdleChat,
} from "../src/rpc-client.js";

let harness: Harness;
const models = scriptedModelRouter();
const network = new NetworkInterceptor({ handlers: [models.handler] });

beforeAll(async () => {
  network.install();
  harness = await startTestGatekeeperHarness({ enableGadgetExecution: true });
});

afterAll(async () => {
  try {
    await harness?.server.close();
    expect(network.getUnmockedCalls()).toEqual([]);
  } finally {
    network.uninstall();
  }
});

/** The `ui://` resource whose view subscribes; the fixture's one app-link model. */
const APP_URI = "ui://test/appview";

type Workspace = {
  gadgetId: string;
  overseer: RpcStub<Overseer>;
};

/** A fresh owner with `model` configured, a workspace, and the ambient test connection. */
async function newWorkspace(
  publicApi: RpcStub<PublicApi>, model: RoutedScriptedModel): Promise<Workspace> {
  const [alice] = nextUsernames("appview");
  const aliceApi = await signUp(publicApi, alice);
  await aliceApi.addModel(model.userModel.profile, model.userModel.config);
  await aliceApi.setPreferredModel(SCRIPTED_MODEL_ID);
  await aliceApi.provisionAmbientAccount(TEST_VENDOR_ID);
  await waitFor(`the ambient test account for ${alice}`, async () =>
    (await listConnectedAccounts(aliceApi)).find(entry => entry.vendorId === TEST_VENDOR_ID)
    ?? null);
  const overseer = await aliceApi.newGadget();
  const { id: gadgetId } = await overseer.getMetadata();
  return { gadgetId, overseer };
}

/** The account firing the registered hook, as its `ui/message` route does. */
function deliver(token: string, text: string, key: string) {
  return testControl<{ delivered?: true; error?: string }>(
    harness, "deliver-app-view-message", { token, text, key });
}

function withText(history: AiChatMessage[], text: string, authorType: "user" | "agent") {
  return history.filter(message =>
    message.type === "message" && message.author.type === authorType && message.message === text);
}

async function historyOf(ws: Workspace, chatId: number): Promise<AiChatMessage[]> {
  return loadAllChatHistory(before => ws.overseer.getChatHistory(chatId, before));
}

it.concurrent(
  "a subscribed app-message hook carries the view's ui/message into the chat as an agentCallback",
  async () => {
    const token = `appview-${crypto.randomUUID().slice(0, 8)}`;
    const appUrl = `https://gadgets-test.example/app/test-account/${token}`;
    const model = models.script([
      {
        toolCall: {
          id: "subscribe",
          name: "executeCode",
          arguments: {
            code: `export default async function(self, env) {
  await env.TEST_AMBIENT.subscribeAppMessages(${JSON.stringify(appUrl)}, self);
}`,
          },
        },
      },
      { text: "Subscribed." },
      { text: "The app view's message arrived." },
    ]);
    using publicApi = connect(harness.url);
    const ws = await newWorkspace(publicApi, model);
    await testControl(harness, "register-app-link", { token, uri: APP_URI });

    const chatId = await ws.overseer.newChat("Open the app view.", SCRIPTED_MODEL_ID);
    await waitFor("the subscribe turn", async () => model.requests.length === 2 || null);
    await waitForIdleChat(ws.overseer, chatId);

    // The subscription bound a hook that listHooks() shows, born disabled. Enabling it is the
    // user's act in the Connections UI; nothing in the connector can enable its own hook.
    const hooks = await ws.overseer.listHooks();
    const hook = hooks.find(entry => entry.description.title === `App messages from ${APP_URI}`);
    if (hook === undefined) throw new Error("The subscription's hook is missing from listHooks()");
    expect(hook.enabled).toBe(false);
    await ws.overseer.enableHook(hook.id);

    expect(await deliver(token, "Hello from the app view.", "appview-first"))
      .toEqual({ delivered: true });

    // The effect, read back over the public API: the message arrived as a callback on the
    // conversation's agent -- method name and arguments included -- and started its turn.
    const settled = await waitFor("the delivered message and the turn it started", async () => {
      const history = await historyOf(ws, chatId);
      return withText(history, "The app view's message arrived.", "agent").length === 1
        ? history
        : null;
    });
    expect(settled.filter(message => message.type === "agentCallback")).toMatchObject([{
      methodName: "receiveAppMessage",
      argsSummary: expect.stringMatching(
        /ui:\/\/test\/appview[\s\S]*Hello from the app view\.[\s\S]*appview-first/),
    }]);
    expect(model.remainingSteps()).toBe(0);
    await waitForIdleChat(ws.overseer, chatId);

    // The callback targets the conversation's agent, so a deleted conversation refuses rather
    // than parking the message somewhere.
    await ws.overseer.deleteChat(chatId);
    expect(await deliver(token, "Too late.", "appview-deleted"))
      .toMatchObject({ error: expect.stringMatching(/no such chatId/i) });

    // Disabling the hook is the user's kill switch: the stored initiator remains, but the
    // Workshop's own startHook() re-check refuses the firing.
    await ws.overseer.disableHook(hook.id);
    expect(await deliver(token, "Not anymore.", "appview-disabled"))
      .toMatchObject({ error: expect.stringContaining("deleted or disabled") });

    // A token nobody subscribed delivers nothing, and says how to fix that.
    expect(await deliver("appview-never-subscribed", "Nobody asked.", "appview-unsubscribed"))
      .toMatchObject({ error: expect.stringContaining("Ask the agent in the chat to subscribe") });
  });
