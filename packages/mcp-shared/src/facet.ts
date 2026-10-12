// Shared mechanics of an MCP gatekeeper facet. Connector-owned subclasses retain their Wrangler
// identity, props, labels, trust source, and account lookup.

import { DurableObject, type RpcStub } from "cloudflare:workers";
import type {
 ActionKind,
 ApprovalQueue,
 Gatekeeper,
 GatekeeperUserVerifier,
 HookController,
 ResourceDescription,
} from "@gadgets/workshop-shared/gatekeeper";

import { ActionStore, REVERT_UNSUPPORTED_MESSAGE } from "./action-store.js";
import {
 type AppMessageHookExports,
 type AppMessageHookProps,
 type McpAppMessageHookTarget,
} from "./app-message-hook.js";
import { prefixedAppUri, toolVisibleToModel, type AppBinding, type AppCallSnapshot } from "./apps.js";
import {
 CATALOG_TTL_MS,
 HydratedTools,
 scopedCatalog,
 type ScopedCatalog,
} from "./catalog.js";
import type { McpClient } from "./client.js";
import {
 withClient,
 type ConnectionAccount,
 type ConnectionEnv,
 type WithClientOptions,
} from "./connection.js";
import type { McpLog } from "./log.js";
import { DEFAULT_REQUEST_TIMEOUT_MS } from "./fetch.js";
import { formatToolScope, scopeAllows, type ToolScope } from "./scope.js";
import { matchesToolQuery, toolQueryTerms, MAX_SEARCH_RESULTS } from "./tool-search.js";
import { McpSessionBase, type McpSessionHost, type StoredAction } from "./session.js";
import { installToolMethods } from "./session-methods.js";
import { observerRefusalMessage } from "./sharing-policy.js";
import {
 actionKindFor,
 classifyTool,
 type ClassifiedTool,
 type ServerTrust,
} from "./tools.js";

type FacetProps = {
 endpoint: string;
 scope: ToolScope;
};

// The app half of an account. Both connectors declare `account()` as the transport subset
// (`ConnectionAccount`) while returning the concrete account Durable Object, which is what mints
// links; this names only the method this file calls, so no connector's class is a dependency here.
type AppMintAccount = {
 mintAppLink(
  binding: AppBinding,
  resource: { uri: string; title?: string },
  call?: AppCallSnapshot,
 ): Promise<string>;

 /** The `ui://` resource one live app link renders, or undefined when it has none. */
 appLinkResource(accountId: string, token: string): Promise<{ uri: string } | undefined>;
};

type SessionConstructor<Session extends McpSessionBase> = new (
 host: McpSessionHost,
 queue: RpcStub<ApprovalQueue>,
) => Session;

const MAX_CONCURRENT_DISCOVERIES = 4;
const MAX_QUEUED_DISCOVERIES = 32;

/** Common session, catalog, action, and sharing behavior for connector-owned MCP facets. */
export abstract class McpFacetBase<
 Env extends ConnectionEnv,
 Props extends FacetProps,
 Session extends McpSessionBase,
> extends DurableObject<Env, Props> implements Gatekeeper<Session>, McpSessionHost {
 #catalogPromise: Promise<ScopedCatalog> | undefined;
 #toolsFetchedAt = 0;
 #toolsTrust: ServerTrust | undefined;
 #actionStore: ActionStore | undefined;
 #hydrated = new HydratedTools();
 #activeDiscoveries = 0;
 #waitingDiscoveries: Array<() => void> = [];

 #actions(): ActionStore {
  return this.#actionStore ??= new ActionStore(this.ctx.storage.sql);
 }

 // The MCP Apps visibility rule: a definition whose `_meta.ui.visibility` is present and omits
 // `"model"` is a tool for the app, not for the agent. Applied to every catalog the session can
 // reach, so the catalog it lists, the generated `.d.ts` a coding agent reads, and the per-tool
 // methods installed on a new session cannot disagree about which tools the agent has. The app
 // gateway is unaffected: it builds its own catalog from the endpoint, where an app-only tool is
 // still found.
 #agentTools(tools: ClassifiedTool[]): ClassifiedTool[] {
  return tools.filter(entry => toolVisibleToModel(entry.tool));
 }

 /** Connector-owned logger carrying the facet's safe identifying fields. */
 protected abstract get log(): McpLog;

 /** Current trust tier, read whenever catalog classification is used. */
 protected abstract get trust(): ServerTrust;

 /** Connector-decorated session class exposed through RPC. */
 protected abstract get sessionClass(): SessionConstructor<Session>;

 /** Namespace preventing approval policy from crossing resource boundaries. */
 protected abstract get actionScopeTag(): string;

 /** Human-readable resource named when refusing an observer. */
 protected abstract get observerName(): string;

 /** Connector-owned account capability used for endpoint calls. */
 protected abstract account(): ConnectionAccount;

 /** Human-readable server label used in observations and action prompts. */
 abstract get serverName(): string;

 /** Describes the connector-specific resource represented by this facet. */
 abstract describe(): Promise<ResourceDescription>;

 /** Generates the connector-specific TypeScript API for this facet. */
 abstract getTypeScriptTypes(): Promise<string>;

 /** The endpoint this facet is authorized to call. */
 get endpoint(): string {
  return this.ctx.props.endpoint;
 }

 /** The tool scope this facet is authorized to expose. */
 get scope(): ToolScope {
  return this.ctx.props.scope;
 }

 /**
  * Prefix this endpoint serves its resources under, when it renames them.
  *
  * Absent for a server that serves a resource under the URI it declared; a connector in front of an
  * endpoint that renames -- a portal -- overrides it, so links minted here read the resource under
  * the name that endpoint answers to.
  */
 protected get resourceUriPrefix(): string | undefined {
  return undefined;
 }

 /**
  * Names one app resource the way this facet's endpoint serves it.
  *
  * A resource URI a tool or a result carries in `_meta.ui.resourceUri` is the resource's own name.
  * An endpoint that fronts resources under a prefix -- a portal serves an upstream's
  * `ui://demo/dashboard` as `mcp-app-server_ui://demo/dashboard` -- addresses the same resource by
  * that prefixed name and only that one, so the declared name is prefixed here before it becomes a
  * link's identity and the name a read is sent under. Identity, with no prefix, for every endpoint
  * that serves a resource under the name it declared. Idempotent, so an already-prefixed URI (from
  * a result that carried the endpoint's own name) is returned unchanged.
  */
 normalizeAppResourceUri(uri: string): string {
  return prefixedAppUri(this.resourceUriPrefix, uri);
 }

 /** Canonical resource URL for this facet's endpoint and scope. */
 protected get resourceUrl(): string {
  return formatToolScope(this.endpoint, this.scope);
 }

 /** Returns this facet's scoped catalog and endpoint kind. */
 protected catalog(deadline?: number): Promise<ScopedCatalog> {
  const trust = this.trust;
  if (!this.#catalogPromise || this.#toolsTrust !== trust
   || Date.now() - this.#toolsFetchedAt > CATALOG_TTL_MS) {
   this.#toolsFetchedAt = Date.now();
   this.#toolsTrust = trust;
   const load = (operationDeadline: number) => scopedCatalog({
    store: this.ctx.storage.kv,
    log: this.log,
    env: this.env,
    account: this.account(),
    endpoint: this.endpoint,
    scope: this.scope,
    trust,
    deadline: operationDeadline,
   });
   const loading = deadline === undefined ? this.runDiscovery(load) : load(deadline);
   this.#catalogPromise = loading.catch(err => {
    this.#catalogPromise = undefined;
    throw err;
   });
  }
  return this.#catalogPromise;
 }

 /** Returns this facet's scoped and classified tool definitions, as the agent may see them. */
 async tools(): Promise<ClassifiedTool[]> {
  return this.#agentTools((await this.catalog()).tools);
 }

 /** Runs Gadget-triggered catalog I/O within one facet-wide concurrency bound. */
 protected async runDiscovery<T>(operation: (deadline: number) => Promise<T>): Promise<T> {
  const deadline = Date.now() + DEFAULT_REQUEST_TIMEOUT_MS;
  if (this.#activeDiscoveries >= MAX_CONCURRENT_DISCOVERIES) {
   if (this.#waitingDiscoveries.length >= MAX_QUEUED_DISCOVERIES) {
    throw new Error("Too many MCP discovery requests are already in progress.");
   }
   await new Promise<void>((resolve, reject) => {
    const resume = () => {
     clearTimeout(timer);
     resolve();
    };
    const timer = setTimeout(() => {
     const index = this.#waitingDiscoveries.indexOf(resume);
     if (index >= 0) this.#waitingDiscoveries.splice(index, 1);
     reject(new Error("Timed out waiting to discover MCP tools."));
    }, Math.max(0, deadline - Date.now()));
    this.#waitingDiscoveries.push(resume);
   });
  } else {
   this.#activeDiscoveries++;
  }

  try {
   return await operation(deadline);
  } finally {
   const next = this.#waitingDiscoveries.shift();
   if (next) next();
   else this.#activeDiscoveries--;
  }
 }

 /** Searches the endpoint for granted tools by name, title, and description. */
 async searchTools(query: string): Promise<ClassifiedTool[]> {
  const terms = toolQueryTerms(query);
  return this.runDiscovery(async deadline => {
   const catalog = await this.catalog(deadline);
   if (!catalog.truncated) {
    return this.#agentTools(catalog.tools)
     .filter(entry => matchesToolQuery(entry.tool, terms))
     .slice(0, MAX_SEARCH_RESULTS);
   }
   const { isPortal } = catalog;
   const tools = await this.call(
    client => client.listMatchingToolSummaries(
     MAX_SEARCH_RESULTS,
     tool => scopeAllows(this.scope, tool.name, isPortal) && matchesToolQuery(tool, terms),
    ),
    { deadline },
   );
   return this.#agentTools(
    tools.map(tool => classifyTool(tool, this.trust, this.scope.codeMode !== undefined)));
  });
 }

 /** Resolves one granted tool, fetching it when the described catalog omitted it. */
 async findTool(name: string): Promise<ClassifiedTool | undefined> {
  // Grant restrictions can be enforced without loading anything. A portal-native exclusion needs
  // the endpoint kind below, except for a server or code-mode scope, which by definition belong to
  // a portal.
  if (!scopeAllows(this.scope, name, this.scope.serverId !== undefined
   || this.scope.codeMode !== undefined)) return undefined;

  return this.runDiscovery(async deadline => {
   const catalog = await this.catalog(deadline);
   if (!scopeAllows(this.scope, name, catalog.isPortal)) return undefined;
   const described = catalog.tools.find(entry => entry.tool.name === name);
   // A described but app-only tool stays hidden, and hydrating past the catalog would fetch the
   // same definition again.
   if (described) return this.#agentTools([described]).at(0);
   if (!catalog.truncated) return undefined;

   const load = (candidate: string) =>
    this.call(client => client.findTool(candidate), { deadline });
   const tool = await this.#hydrated.resolve(name, load);
   return tool
    && this.#agentTools([
     classifyTool(tool, this.trust, this.scope.codeMode !== undefined),
    ]).at(0);
  });
 }

 /** Returns action kinds that this facet's current catalog permits auto-approving. */
 async getAutoApprovableActions(): Promise<ActionKind[]> {
  return (await this.tools())
   .filter(entry => entry.autoApprovable)
   .map(entry => actionKindFor(this.actionScopeTag, entry.tool.name));
 }

 /** Starts a session with generated per-tool methods when the catalog is available. */
 async startSession(approvalQueue: RpcStub<ApprovalQueue>): Promise<Session> {
  let SessionClass = this.sessionClass;
  try {
   SessionClass = installToolMethods(SessionClass, await this.tools());
  } catch (err) {
   this.log.warn("starting session without per-tool methods", {
    event: "session.tool-methods.unavailable", error: err,
   });
  }
  return new SessionClass(this, approvalQueue.dup());
 }

 /** Refuses observers so MCP bindings can only be opened by their owner. */
 async addObserver(_id: string, _user: Fetcher<GatekeeperUserVerifier>): Promise<void> {
  throw new Error(observerRefusalMessage(this.observerName));
 }

 /** Removes no observer state because observers are never admitted. */
 async removeObserver(_id: string): Promise<void> { }

 /** Stages an MCP action for approval. */
 stageAction(toolName: string, args: Record<string, unknown>): StoredAction {
  return this.#actions().stage(toolName, args);
 }

 /** Discards an action whose approval submission failed. */
 discardStagedAction(id: number): void {
  this.#actions().discard(id);
 }

 /** Looks up a staged or completed action. */
 lookupAction(id: number): StoredAction | undefined {
  return this.#actions().get(id);
 }

 /** Applies an approved action without retrying an outcome-unknown write. */
 async applyAction(action: number): Promise<void> {
  await this.#actions().apply(
   action, fn => this.call(fn, { retryOnExpiry: false }), this.log);
 }

 /** Rejects a pending action. */
 async rejectAction(action: number): Promise<void> {
  this.#actions().reject(action);
 }

 /** Reports that MCP actions cannot be reverted. */
 async revertAction(_action: number): Promise<{ message: string }> {
  return { message: REVERT_UNSUPPORTED_MESSAGE };
 }

 /** Runs a call against this facet's endpoint and account. */
 call<T>(
  fn: (client: McpClient) => Promise<T>,
  options?: WithClientOptions,
 ): Promise<T> {
  // The binding's own scope decides the connection flavor. A caller's options can never select it,
  // so a code-mode grant's calls always carry the mode and a plain grant's never do.
  return withClient(this.env, this.account(), this.endpoint, fn,
   { ...options, codeMode: this.scope.codeMode });
 }

 /** Mints the sidecar link for one `ui://` resource on this binding, or undefined if it cannot. */
 async appLink(uri: string, call: AppCallSnapshot): Promise<string | undefined> {
  try {
   // The link belongs to the account, which holds the token and the deployment's base URL.
   const account = this.account() as ConnectionAccount & AppMintAccount;
   return await account.mintAppLink({
    endpoint: this.endpoint,
    serverName: this.serverName,
    scope: this.scope,
    trust: this.trust,
    resourceUriPrefix: this.resourceUriPrefix,
   }, { uri }, call);
  } catch (err) {
   // A view is an extra on top of a result the agent is still waiting for, so this fails soft.
   this.log.warn("could not mint an app link", {
    event: "app.link.mint.failed", error: err,
   });
   return undefined;
  }
 }

 /**
  * Mints the controller one app link's view messages are delivered through.
  *
  * Built here rather than in the session because the connector's own exports are what mint a
  * loopback entrypoint, and the props are this facet's facts as much as the account's: the server
  * name is the one a person reads, and the request to subscribe arrived on this binding.
  */
 appMessageHook(props: AppMessageHookProps): Fetcher<HookController<McpAppMessageHookTarget>> {
  // `Cloudflare.Exports` in a shared package is the runtime's empty type, so the one export this
  // mints through is named by the shape the contract requires of the connector (see
  // `AppMessageHookExports`), not by the generated type of either Worker.
  const exports = this.ctx.exports as unknown as AppMessageHookExports;
  return exports.AppMessageHookController({ props });
 }

 /**
  * Resolves one app link's own facts, or undefined when this binding's account has no live link
  * for the token.
  *
  * The account is asked rather than any storage read here: it owns the token record, and it is the
  * only place that can say both what the link renders and whether the link still exists.
  */
 async appMessageHookProps(
  accountId: string, token: string,
 ): Promise<AppMessageHookProps | undefined> {
  const account = this.account() as ConnectionAccount & AppMintAccount;
  const resource = await account.appLinkResource(accountId, token);
  return resource === undefined
   ? undefined
   : { accountId, token, uri: resource.uri, serverName: this.serverName };
 }

 /** Namespaces one tool's approval kind to this facet. */
 actionKindFor(toolName: string): ActionKind {
  return actionKindFor(this.actionScopeTag, toolName);
 }
}
