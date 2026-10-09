// The capability a Gadget actually holds: one session over one MCP binding. Every tool call a Gadget
// can make arrives here, and the rules applied are the same for both connectors.
//
// What differs per connector is which server and how to reach it, which is what `McpSessionHost`
// supplies. The base never touches the Durable Object, the account, or the endpoint's credentials.

import { RpcTarget, type RpcStub } from "cloudflare:workers";
import type { ActionDescription, ActionKind, ApprovalQueue, HookController }
  from "@gadgets/workshop-shared/gatekeeper";

import {
  toolUiResourceUri,
  uiResourceUriInResult,
  type AppCallSnapshot,
  type AppResultLike,
} from "./apps.js";
import type { AppMessageHookProps, McpAppMessageHookTarget } from "./app-message-hook.js";
import {
  MAX_TOOL_NAME_CHARS,
  type McpClient,
} from "./client.js";
import type { WithClientOptions } from "./connection.js";
import { isWholeEndpoint, type ToolScope } from "./scope.js";
import { toolQueryTerms, MAX_QUERY_CHARS, MAX_SEARCH_RESULTS } from "./tool-search.js";
import {
  codeSpan,
  describeCall,
  plainInline,
  toCallResult,
  toolInfo,
  toolSummary,
  type ClassifiedTool,
} from "./tools.js";
import type {
  McpCallResult,
  McpContent,
  McpToolInfo,
  McpToolListOptions,
  McpToolSummary,
} from "./types";

/**
 * A queued tool call, awaiting a decision. Persisted by the host in its own storage; the session
 * only ever reads one back by id.
 */
export type StoredAction = {
  id: number;
  toolName: string;
  args: Record<string, unknown>;
  /**
   * `applying` is the window between an approval arriving and the call returning. It exists so a
   * second `applyAction` for the same id cannot find the record still `pending` and call the tool a
   * second time; see `ActionStore.apply`.
   */
  state: "pending" | "applying" | "applied" | "rejected" | "failed";
  submittedAt: number;
  /** When the in-flight apply was claimed, for recovering a claim whose Durable Object died mid-call. */
  claimedAt?: number;
  /**
   * Whether a `failed` record may be sent again. Absent means yes, which is the reading for records
   * written before this field existed. False marks a failure that left the outcome unknown -- the
   * request may already have been carried out, so another attempt could duplicate a write that MCP
   * gives no way to undo -- or one the user discarded. See `ActionStore.apply` and `reject`.
   */
  retryable?: boolean;
  /** Populated once applied; delivered to the Gadget as an observation. */
  result?: Extract<McpCallResult, { status: "ok" }>;
  /**
   * The `ui://` resource the applied call's own result named, when it named one.
   *
   * The stored `result` is the flattened shape this host hands a Gadget, so a result's `_meta` never
   * reaches it: a server that declares its view on the result rather than on the tool would lose its
   * sidecar link between the approval and the collection. Read back by the applied arm of
   * `getActionResult`, which prefers the tool's own declaration when the catalog still has one.
   */
  appUri?: string;
  /** Terminal failure reason retained for later collection. */
  error?: string;
};

/**
 * What a session needs from the gatekeeper facet that owns it. Narrow: the session is handed to a
 * Gadget, so anything reachable from here is one `followPath` away from untrusted code.
 */
export interface McpSessionHost {
  readonly serverName: string;
  readonly endpoint: string;
  /** How much of the endpoint this binding may call. Only used to word the "no such tool" error. */
  readonly scope: ToolScope;

  /** Returns the bounded described catalog. */
  tools(): Promise<ClassifiedTool[]>;
  /** Searches bounded summaries across the granted endpoint scope. */
  searchTools(query: string): Promise<ClassifiedTool[]>;
  /** Finds one granted tool definition by exact wire name. */
  findTool(name: string): Promise<ClassifiedTool | undefined>;
  /** Runs `fn` against an initialized client for this binding's endpoint. */
  call<T>(
    fn: (client: McpClient) => Promise<T>,
    options?: WithClientOptions,
  ): Promise<T>;

  /**
   * Mints the sidecar link for one `ui://` resource on this binding, or undefined if it cannot.
   *
   * On the host rather than in the session because the facet is what knows the binding a link has
   * to be scoped to: its endpoint, server name, scope, and trust live there, and the session
   * reaching this interface is already in a Gadget's hands.
   *
   * What the link's view may send back is not decided here: a caller asks for that separately, with
   * `subscribeAppMessages()` (see `appMessageHook` and `appMessageHookProps`).
   */
  appLink(uri: string, call: AppCallSnapshot): Promise<string | undefined>;

  /**
   * The controller fetcher for one app link, minted by the connector's own `ctx.exports`.
   *
   * `props` are the link's own facts -- the resource its view renders, and this server's name --
   * merged with the two identifiers `subscribeAppMessages()` read off the link's URL, so the
   * controller describes itself and its deliveries without asking storage anything.
   */
  appMessageHook(props: AppMessageHookProps): Fetcher<HookController<McpAppMessageHookTarget>>;

  /**
   * The props of one live app link, or undefined when this binding's account minted no such link
   * (or no longer holds one).
   *
   * Asked before a subscription is bound: the account owns the token record, a session cannot read
   * storage, and a subscription to a link that cannot deliver is a promise this host cannot keep.
   * The pair is read for its own sake as well -- the token is what a registration is filed under,
   * and the account is what checks it belongs to the link's own deployment.
   */
  appMessageHookProps(accountId: string, token: string): Promise<AppMessageHookProps | undefined>;

  /** The approval-kind tag for one tool, namespaced so pre-approvals cannot cross servers. */
  actionKindFor(toolName: string): ActionKind;

  stageAction(toolName: string, args: Record<string, unknown>): StoredAction;
  discardStagedAction(id: number): void;
  lookupAction(id: number): StoredAction | undefined;
}

function requireToolName(method: string, name: unknown): asserts name is string {
  if (typeof name !== "string" || name.length === 0) {
    throw new Error(`${method}() requires a tool name.`);
  }
  if (name.length > MAX_TOOL_NAME_CHARS) {
    throw new Error(`${method}() tool name must be at most ${MAX_TOOL_NAME_CHARS} characters.`);
  }
}

/**
 * The instruction an app result carries for the agent: the one step that makes the link usable.
 *
 * It lives in the result rather than only in the generated session type, because that type is
 * reference material the agent read *before* it held a result -- and because the app's own content
 * often tells the model to ignore the result and wait for the app instead. Stated here the
 * consequence is concrete: an unsubscribed link renders perfectly well and can send nothing, which
 * stays invisible until the person picks something and nothing arrives.
 *
 * Subscribing twice is not free -- the Workshop allocates a hook record per `bindHook`, and a second
 * record is a second entry in Connections -- so the wording asks for one subscription per link
 * rather than one per result.
 */
function appLinkInstruction(url: string): Extract<McpContent, { type: "text" }> {
  return {
    type: "text",
    text:
      `ACTION REQUIRED before you relay this link: call subscribeAppMessages(${JSON.stringify(url)}, ` +
      `self) in this same turn. Until this link is subscribed the view cannot send anything back into ` +
      `this conversation, so relaying it without subscribing leaves the person unable to send what ` +
      `they pick. Subscribe once: skip this only if this exact url is already subscribed here.`,
  };
}

/**
 * The Gadget-facing session. A named method per tool is installed on a per-grant subclass (see
 * `session-methods.ts`), each a one-line delegate to `callTool`. Connectors subclass this and apply
 * `@validateRpc()` there, so the decorator is visible in the file that hands it to a Gadget.
 */
export class McpSessionBase extends RpcTarget {
  #host: McpSessionHost;
  #queue: RpcStub<ApprovalQueue>;

  constructor(host: McpSessionHost, queue: RpcStub<ApprovalQueue>) {
    super();
    this.#host = host;
    this.#queue = queue;
  }

  [Symbol.dispose](): void {
    (this.#queue as RpcStub<ApprovalQueue> & { [Symbol.dispose](): void })[Symbol.dispose]();
  }

  async listTools(
    options?: McpToolListOptions,
  ): Promise<McpToolInfo[] | McpToolSummary[]> {
    if (options === undefined) {
      const tools = await this.#host.tools();
      await this.#queue.authorizeObservation({
        title: `${this.#host.serverName}: list tools`,
        description:
          `Read the tool catalog of the MCP server **${this.#host.serverName}** ` +
          `(\`${this.#host.endpoint}\`).`,
      });
      return tools.map(toolInfo);
    }
    if (typeof options !== "object" || options === null) {
      throw new Error("listTools() options must select search or name.");
    }
    const hasName = options.name !== undefined;
    const hasSearch = options.search !== undefined;
    if (hasName === hasSearch) {
      throw new Error("listTools() options must select exactly one of search or name.");
    }
    if (hasName) {
      requireToolName("listTools", options.name);
      const tool = await this.#host.findTool(options.name);
      await this.#queue.authorizeObservation({
        title: `${this.#host.serverName}: find tool`,
        description:
          `Looked for ${codeSpan(options.name, MAX_TOOL_NAME_CHARS)} on the MCP server ` +
          `**${this.#host.serverName}** (\`${this.#host.endpoint}\`).`,
      });
      return tool ? [toolInfo(tool)] : [];
    }
    const trimmed = typeof options.search === "string" ? options.search.trim() : "";
    if (trimmed.length === 0) {
      throw new Error("listTools({ search }) requires a non-empty query.");
    }
    if (trimmed.length > MAX_QUERY_CHARS) {
      throw new Error(`listTools({ search }) query must be at most ${MAX_QUERY_CHARS} characters.`);
    }
    if (toolQueryTerms(trimmed).length === 0) {
      throw new Error("listTools({ search }) requires one or more search terms.");
    }
    const tools = await this.#host.searchTools(trimmed);
    await this.#queue.authorizeObservation({
      title: `${this.#host.serverName}: search tools`,
      description:
        `Searched the tool catalog of the MCP server **${this.#host.serverName}** ` +
        // The query is the agent's text, so it is flattened before being quoted: an observation is
        // read by a person, and a query is as able to forge structure as a tool description is.
        `(\`${this.#host.endpoint}\`) for \`${plainInline(trimmed)}\` ` +
        `and returned ${tools.length} match(es), up to a limit of ${MAX_SEARCH_RESULTS}.`,
    });
    return tools.map(toolSummary);
  }

  // Worded from the grant's point of view: on a scoped binding the tool may well exist on the server,
  // and "no such tool" would send an agent looking for a typo it will not find.
  #noSuchToolMessage(name: string): string {
    return isWholeEndpoint(this.#host.scope)
      ? `The MCP server "${this.#host.serverName}" has no tool named "${name}".`
      : `This binding does not grant a tool named "${name}".`;
  }

  // Decorates a result with the sidecar link for one `ui://` resource.
  //
  // Best-effort by construction: a link is a convenience on top of a result the agent already has,
  // so a host that cannot mint one, an endpoint that has gone away, or a server naming a resource
  // it does not serve all leave the result exactly as the server returned it. The resource is
  // resolved by the caller rather than here, because the two paths learn it from different places:
  // a read tool from the result it just received, and a queued one from what the store kept beside
  // it when the call was applied.
  async #withAppLink(
    result: Extract<McpCallResult, { status: "ok" }>,
    // The `ui://` resource this call renders, or undefined when nothing named one.
    uri: string | undefined,
    // The tool's own title, when the catalog the call was made from still has it.
    title: string | undefined,
    // The server's own result: what the sidecar is handed as the outcome of the call. Wire shape,
    // never the flattened one: the page relays it as the `tools/call` result a View parses with
    // MCP's own schema.
    serverResult: AppResultLike,
    // The tool call the sidecar replays. An app is told the input and the result, never the session.
    call: Omit<AppCallSnapshot, "result">,
  ): Promise<Extract<McpCallResult, { status: "ok" }>> {
    if (result.isError === true || uri === undefined) return result;
    let url: string | undefined;
    try {
      url = await this.#host.appLink(uri, { ...call, result: serverResult });
    } catch {
      return result;
    }
    if (url === undefined) return result;
    // The instruction leads the content: it is the step that makes the link do anything, and the
    // app's own content competes for that decision by telling the model to ignore the result and
    // wait. `text` is documented as the text blocks concatenated, so the block belongs there too --
    // an agent that reads only `text` would otherwise never see it.
    const instruction = appLinkInstruction(url);
    return {
      ...result,
      content: [instruction, ...result.content],
      text: result.text === "" ? instruction.text : `${instruction.text}\n\n${result.text}`,
      app: { uri, url, title },
    };
  }

  async callTool(name: string, args?: Record<string, unknown>): Promise<McpCallResult> {
    requireToolName("callTool", name);
    const toolArgs = args ?? {};
    if (typeof toolArgs !== "object" || Array.isArray(toolArgs)) {
      throw new Error("callTool() arguments must be an object.");
    }

    const host = this.#host;
    const entry = await host.findTool(name);
    if (!entry) throw new Error(this.#noSuchToolMessage(name));

    const { title, description: text, fields, descriptionIsComplete } = describeCall({
      serverName: host.serverName,
      endpoint: host.endpoint,
      tool: entry.tool,
      toolArgs,
      mode: entry.mode,
      classifiedBy: entry.classifiedBy,
    });

    if (entry.mode === "read") {
      const result = await host.call(client => client.callTool(name, toolArgs));
      // Authorize before the data is handed back, per the gatekeeper contract.
      await this.#queue.authorizeObservation({
        title, description: text, ...(fields ? { fields } : {}),
      });
      // The result is in hand here, so both places an association can live are read: the tool's own
      // declaration first, then the result's. A tool that names one describes every call it makes,
      // where a result describes only the call it came from.
      return this.#withAppLink(
        toCallResult(result),
        toolUiResourceUri(entry.tool) ?? uiResourceUriInResult(result),
        entry.tool.title,
        result,
        { toolName: name, input: toolArgs });
    }

    const staged = host.stageAction(name, toolArgs);
    const description: ActionDescription = {
      title,
      description: text,
      ...(fields ? { fields } : {}),
      // Absent unless the arguments were shown in full; the overseer reads presence as a claim.
      ...(descriptionIsComplete ? { descriptionIsComplete } : {}),
      // MCP describes no inverse operation for a tool call.
      implementsRevert: false,
      // Nothing about a queued call is simulated, so later reads would show a world in which it
      // never happened. Wait for the decision instead.
      awaitDecision: true,
      autoApprovable: entry.autoApprovable,
      actionKind: host.actionKindFor(name),
    };

    try {
      await this.#queue.submitAction(staged.id, description);
    } catch (err) {
      host.discardStagedAction(staged.id);
      throw err;
    }

    return {
      status: "pending",
      actionId: staged.id,
      message:
        `Calling "${name}" on ${host.serverName} needs approval. If this is running in an ` +
        `agent's executeCode call, return from this executeCode call now so the approval can ` +
        `appear in chat. After approval, call getActionResult(${staged.id}) for the outcome.`,
    };
  }

  async getActionResult(actionId: number): Promise<McpCallResult> {
    if (!Number.isInteger(actionId)) throw new Error("getActionResult() requires an action id.");
    const host = this.#host;
    const stored = host.lookupAction(actionId);
    if (!stored) throw new Error(`No MCP action with id ${actionId}.`);

    switch (stored.state) {
      case "pending":
      case "applying":
        return {
          status: "pending",
          actionId,
          message: stored.state === "applying"
            ? `Calling "${stored.toolName}" on ${host.serverName} was approved and is running.`
            : `Calling "${stored.toolName}" on ${host.serverName} is awaiting approval.`,
        };
      case "rejected":
        return {
          status: "rejected",
          message: `Calling "${stored.toolName}" on ${host.serverName} was not approved.`,
        };
      case "failed":
        return {
          status: "failed",
          message: stored.error
            ?? `Calling "${stored.toolName}" on ${host.serverName} failed.`,
        };
      case "applied": {
        const result = stored.result
          ?? { status: "ok" as const, content: [], text: "", isError: false };
        // The result was produced while the Gadget was not looking, so it becomes an observation at
        // the moment it is handed over rather than when the call was applied.
        await this.#queue.authorizeObservation({
          title: `${host.serverName}: result of ${stored.toolName}`,
          description:
            `Read the response from the approved call to \`${stored.toolName}\` on ` +
            `**${host.serverName}**.`,
        });
        // The stored copy is the flattened result, so the association is read from wherever it
        // survived: the catalog for a tool that declares a view, and the action record for one its
        // own result declared. `_meta` itself reaches neither.
        const tool = await host.findTool(stored.toolName)
          .then(entry => entry?.tool)
          .catch(() => undefined);
        // Rebuilt in the wire shape a View parses, since the store kept only the flattened result:
        // `status` and `text` are this host's vocabulary, `content` is the server's.
        const serverResult = {
          content: result.content,
          structuredContent: result.structuredContent,
          isError: result.isError,
        };
        return this.#withAppLink(
          result,
          (tool && toolUiResourceUri(tool)) ?? stored.appUri,
          tool?.title,
          serverResult,
          { toolName: stored.toolName, input: stored.args });
      }
    }
  }

  /**
   * Asks to receive the messages the view of `url`'s app link sends back.
   *
   * `url` is the `app.url` a result carried (see `McpCallResult.app`). Subscribing does not deliver
   * anything by itself: the subscription is a hook, born disabled, that the user enables in the
   * Workshop's Connections UI, and the view's own page puts each message in front of them before
   * anything is sent. Until then the app is told, when it tries, that the chat is not subscribed.
   *
   * `hook` is called once per message the person agreed to send, with the `ui://` resource that
   * sent it and the sender's idempotency key. It is normally `self`, which turns the call into an
   * ordinary callback in this chat and starts its turn; either way it must be a persistent stub,
   * since messages arrive long after this session is gone.
   */
  async subscribeAppMessages(
    url: string, hook: RpcStub<McpAppMessageHookTarget>,
  ): Promise<void> {
    // A link is identified by its path alone -- `/app/<account>/<token>` -- so nothing else in the
    // URL is read, and a query or fragment the caller carried along does not make a link that opens
    // in a browser unusable here. Anything else is refused before the account is asked, because an
    // agent that passed the wrong url is better told now than when a view tries to send.
    let segments: string[] = [];
    try {
      segments = new URL(url).pathname.split("/");
    } catch {
      // Not a URL at all: the empty list fails the same shape check as a wrong path.
    }
    const [, app, accountId, token] = segments;
    if (app !== "app" || segments.length !== 4 || accountId === undefined || token === undefined) {
      throw new Error(
        `subscribeAppMessages() takes one of this server's app links -- the app.url a tool result ` +
        `carried -- and ${JSON.stringify(url)} is not one.`);
    }

    // The account owns the link: it decides whether the token names a live link of its own, and
    // only it can say what the resource is. A link that is gone -- expired, superseded by a later
    // mint -- has nothing left to deliver, so subscribing to it is refused here.
    const props = await this.#host.appMessageHookProps(accountId, token);
    if (props === undefined) {
      throw new Error(
        `The app link in ${JSON.stringify(url)} is not one this account can deliver for. Ask for ` +
        `the tool result again and subscribe to the url it returns.`);
    }

    const controller = this.#host.appMessageHook(props);
    // The description is what the user reads in Connections before enabling, so it names the app
    // and the server rather than the hook: the resource is the only name the link itself carries.
    const description = {
      title: `Messages from ${props.uri}`,
      description:
        `Let the view of ${props.uri}, on the MCP server **${props.serverName}**, send messages ` +
        `into the conversation that opened its link. Each message is shown to you in the app ` +
        `before it is sent, and nothing is delivered while this hook is disabled.`,
    };
    // @ts-expect-error Workers' mapped stub types widen the controller's hook type across bindHook's
    // RPC boundary; the Google connector pins the same widening in `SharedApprovalQueue.bindHook()`.
    await this.#queue.bindHook(controller, hook, description);
  }
}
