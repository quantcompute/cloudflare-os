// One message an MCP App view asked its host to put into the conversation that opened its link, and
// the loopback entrypoint that receives them.
//
// Delivery cannot be a route the link carries: an app view is a document in a sandboxed window, and
// its `ui/message` reaches this deployment, not the Workshop -- nothing in the link says which
// conversation opened it. It is a hook instead. Whoever wants the app's messages -- normally the
// agent's `self`, which turns each one into an ordinary callback in its own chat -- asks the session
// to subscribe (see `subscribeAppMessages()`), the session binds this controller on its approval
// queue, and once the user enables the hook in Connections the account files the initiator under
// the link's token. Every later `ui/message` for that link rides it (see `account.ts`).
//
// The controller is an entrypoint of the connector's Worker rather than part of the account Durable
// Object because the request that files an initiator arrives through RPC, and because the account is
// one address the connector already exports (`McpAccount`): this class keeps no state of its own,
// and reaches the account the same way the connector's own code does.

import { RpcTarget, WorkerEntrypoint } from "cloudflare:workers";
import type {
  HookController,
  HookInitiator,
  HookTargetMetadata,
} from "@gadgets/workshop-shared/gatekeeper";

/** One message an MCP App view asked its host to put into the conversation that opened its link. */
export type McpAppMessage = {
  /** The `ui://` resource whose view sent this message. */
  uri: string;
  /** The message body, exactly as the app wrote it. */
  text: string;
  /** The sender's idempotency key. Delivery is at-least-once, so key your work on it. */
  key: string;
};

/**
 * Implemented by whoever asked to receive an MCP App view's messages: normally the agent's `self`,
 * passed to `McpSessionBase.subscribeAppMessages()`. One method, one message per call.
 */
export interface McpAppMessageHook {
  receiveAppMessage(message: McpAppMessage): Promise<void>;
}

/**
 * The same hook as something RPC can bind.
 *
 * A callback is typed by the target it stubs, and an interface alone is not one (the Google
 * connector's `ChatMessageHookTarget` exists for the same reason), so the binding uses this alias
 * while the agent-facing surface names `McpAppMessageHook` itself.
 */
export type McpAppMessageHookTarget = RpcTarget & McpAppMessageHook;

/** Props of the controller bound for one app link. */
export type AppMessageHookProps = {
  /** The account DO that minted the link. */
  accountId: string;
  /** The app link token this subscription delivers for. */
  token: string;
  /** The `ui://` resource the link renders. */
  uri: string;
  /** The MCP server's display name, for the hook's description. */
  serverName: string;
};

/**
 * What this controller asks of the account that minted the link: where its initiator is filed.
 *
 * Branded as a Durable Object so the stub of it can be typed -- a stub's target must be an
 * entrypoint, and the account is the connector's own Durable Object (`McpAccountBase`).
 */
export type AppMessageHookAccount = Rpc.DurableObjectBranded & {
  /**
   * Files `initiator` under the registration's token, replacing any initiator filed before it.
   *
   * A controller cannot tell whether the link is still live -- only the account holds the record --
   * so it passes the registration through and lets the account refuse one that could never deliver.
   */
  registerAppMessageHook(
    props: AppMessageHookProps,
    initiator: Fetcher<HookInitiator<McpAppMessageHookTarget>>,
  ): Promise<void>;

  /** Forgets the initiator filed under the registration's token, if any. */
  unregisterAppMessageHook(props: AppMessageHookProps): Promise<void>;
};

// The export this controller reaches the account through: every MCP connector's entry module
// exports its account Durable Object as `McpAccount`, which is how the connector's own code addresses
// it too. Spelled out here, rather than read off `Cloudflare.Exports`, because that type is generated
// per Worker while this class is compiled once for both connectors.
type ConnectorExports = {
  McpAccount: {
    idFromString(id: string): DurableObjectId;
    get(id: DurableObjectId): Fetcher<AppMessageHookAccount>;
  };
};

/**
 * The one export a connector's Worker entry must provide for app-message hooks.
 *
 * Named here, rather than read from the connector's own `Cloudflare.Exports`, because a shared
 * package sees the runtime's empty exports type: `facet.ts` mints the controller through this shape,
 * and a connector satisfies it by re-exporting the class (`export { AppMessageHookController } from
 * "@gadgets/mcp-shared/app-message-hook"`).
 */
export type AppMessageHookExports = {
  AppMessageHookController(
    init: { props: AppMessageHookProps },
  ): Fetcher<HookController<McpAppMessageHookTarget>>;
};

/**
 * The `HookController` a connector exports from its Worker entry.
 *
 * Carries no `@validateRpc()`: a decorator here would reach the Worker untransformed and throw when
 * the class is defined (see `cursors.ts` in the gatekeeper kit). A connector that wants argument
 * checking subclasses this and decorates its own class instead.
 */
export class AppMessageHookController
  extends WorkerEntrypoint<Cloudflare.Env, AppMessageHookProps>
  implements HookController<McpAppMessageHookTarget>
{
  /** Files the initiator this link's messages are delivered through, for the account to invoke. */
  async enable(
    initiator: Fetcher<HookInitiator<McpAppMessageHookTarget>>,
    _target: HookTargetMetadata,
  ): Promise<void> {
    await this.#account().registerAppMessageHook(this.ctx.props, initiator);
  }

  /** Forgets it, so a `ui/message` that arrives afterwards is refused rather than delivered. */
  async disable(): Promise<void> {
    await this.#account().unregisterAppMessageHook(this.ctx.props);
  }

  #account(): Fetcher<AppMessageHookAccount> {
    const { McpAccount } = this.ctx.exports as unknown as ConnectorExports;
    return McpAccount.get(McpAccount.idFromString(this.ctx.props.accountId));
  }
}
