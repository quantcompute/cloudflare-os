# MCP shared

The protocol client, policy decisions, and stateful machinery common to the two MCP-speaking
gatekeepers. Not a Worker: a library both of them import.

| Package | Endpoint comes from | Grant is scoped to |
| --- | --- | --- |
| [`gatekeeper-mcp`](../gatekeeper-mcp/README.md) | a user pastes a URL | the whole server, or named tools |
| [`gatekeeper-mcp-portal`](../gatekeeper-mcp-portal/README.md) | a deployment var, `MCP_PORTAL_URL` | one upstream server behind the portal, named tools, or the portal's Code Mode sandbox |

Code lives here when two copies of it would eventually disagree and the disagreement would be a
security bug: tool classification, the scope grammar, the OAuth lifecycle, the approval-queue
wiring. A Worker's own vendor entrypoint, Durable Object classes and migrations, `Env`, connect
form, and configurator UI stay in the connector. Where a connector must vary shared behaviour it
does so through a named hook (`staticToken`, `mintAccount`), not a private copy.

## Modules

| Module | Purpose |
| --- | --- |
| `client` | Bounded Streamable HTTP transport (`initialize`, `tools/list`, `tools/call`, `resources/read`) using official MCP wire types |
| `oauth` | Small adapter around the official MCP client's OAuth errors and token revocation gap |
| `tools` | The trust boundary: read/action classification, auto-approval eligibility, approval prompts, catalog fingerprinting |
| `schema-to-ts` | JSON Schema to TypeScript, strict `callTool` overloads plus progressive discovery |
| `session-methods` | Installs those methods at runtime, so the generated types are not a fiction |
| `tool-search` | The one query matcher every catalog search uses, so a query cannot mean two things |
| `portal` | Gateway detection, tool-name to upstream-server mapping, server listing, the Code Mode query parameter and its two tool names |
| `scope` | The resource-URL scope grammar, including the Code Mode fragment, and the check every call passes through |
| `endpoint` | Validation and host blocklist for a user-supplied endpoint |
| `fetch` | Every outbound request; redirects are followed by hand and each hop re-checked, including SDK OAuth fetches |
| `account` | Durable Object base and persisted SDK OAuth state: connect, refresh, revocation; transport sessions per connection flavor |
| `facet` | Common session, catalog, action, and sharing behavior for connector-owned Durable Object facets |
| `catalog` | One binding's tool list: fetched, cached, scoped to the grant, classified; plus the cache for tools hydrated past that list |
| `connection` | `withClient` — transport sessions, one per connection flavor, plus retries and credential-expiry reporting |
| `action-store` | Staged to applied/rejected/failed, with a bound on what is retained and a claim so one approval is never sent twice |
| `session` | The Gadget-facing capability, and the one path every tool call takes |
| `apps` | The MCP Apps boundary: `ui://` recognition, tool visibility, View CSP and permissions, bounded results |
| `app-tokens` | App links: what one authorizes, how long it lives, reuse, and the subscription key beside one |
| `app-message-hook` | The messages a view sends back: the contract it implements, and the `HookController` a connector exports to receive them |
| `app-gateway` | What an open sidecar page may ask for: the read-only rule, the text a `ui/message` may carry, and the JSON-RPC framing around both |
| `app-page` | The sidecar page: the Host half of MCP Apps, the consent strip a message must pass, the sandbox proxy nested inside it, and the sized window it offers |
| `app-http` | The `/app/...` HTTP routes both connectors serve: the page, and the JSON-RPC endpoint it calls |
| `sharing-policy` | The owner-only sharing rule |
| `html` | The connect-flow pages, so both connectors look like one product |
| `http` | Base-path, OAuth callback, connect-link, and app-link routing shared by both Workers |
| `log` | The field vocabulary both connectors log against |
| `user` | The common account description, revocation, and reconnect lifecycle |
| `util` | Hex encoding, host extraction, binding-name slugs; no policy |
| `types.d.ts` | Base types prepended to every generated per-server `.d.ts` |

Nothing outside `tools.ts` reads a tool's `annotations`.

## Scope grammar

The fragment of a resource URL is the grant, and the only place a grant's breadth is expressed:

| Fragment | Reaches |
| --- | --- |
| *(none)* | every tool the endpoint offers, now and later |
| `#server=<id>` | every tool of one portal upstream server |
| `#tool=<name>` (repeatable) | only those exact tools |
| `#codemode=<mode>` | the portal's Code Mode sandbox, a whole-portal breadth |

`#codemode=search_and_execute` is the one supported mode, and it stands alone: `formatToolScope`
emits `codemode=<mode>` and nothing else when it is set, `isWholeEndpoint` is false for such a scope,
and an unrecognized mode throws rather than failing open — an unknown value is not a narrower grant.
`scopeAllows` admits exactly `portal_codemode_search` and `portal_codemode_execute`, so every other
name is refused, portal-native or upstream. The fragment is narrow at the tool boundary precisely
because it cannot be narrow anywhere else: `portal_codemode_execute` runs JavaScript on the portal
and may call any upstream tool the portal enables, so a code-mode scope names no server and no tool
to pin that down.

## Trust tiers

A tier governs how far a server's own claims about its tools are believed. MCP's own guidance is
that a client must treat tool annotations as untrusted unless they come from a trusted server, and
the tier is where this deployment records which servers those are. It is named by provenance, is
deployment configuration rather than account state, and is read at each point of use so withdrawing
it takes effect at once.

- **`byo`** — a user typed the URL in. `readOnlyHint` classifies reads; nothing the server says can
  auto-apply a write.
- **`vetted`** — a deployment has asserted this endpoint's annotations can be relied on, so
  `destructiveHint: false` plus `idempotentHint: true` may drive auto-approval. Configuring an
  endpoint is not by itself enough to earn this: a portal aggregates upstream servers whose
  annotations the administrator never saw, which is why `gatekeeper-mcp-portal` defaults to `byo`
  and requires `MCP_PORTAL_TRUST_ANNOTATIONS=true`.

Honouring `readOnlyHint` on `byo` is a tradeoff, not a free win: a tool the server mislabels runs
with no approval, where an unlabelled one would have been queued. It is accepted because prompting
on every read makes the connector unusable for its main purpose, and because the owner chose to
connect the server. Auto-applying a write is not accepted on those terms.

Annotations are optional in MCP and most servers publish none. Every hint is compared with
`=== true` or `=== false`, so an unannotated tool is an action, needs approval, and can never
auto-apply, on either tier. That matches the spec's own defaults (`readOnlyHint: false`,
`destructiveHint: true`, `idempotentHint: false`).

Code Mode sits outside the tiers, because there is no server annotation to weigh. The connector
classifies `portal_codemode_search` as a read and `portal_codemode_execute` as an action, and neither
can auto-apply on any tier: `execute` runs JavaScript on the portal that may call tools no catalog
ever described, so there is nothing a trust setting could safely make automatic.

Neither tier can be shared. A Gadget bound to any MCP endpoint is owner-only, for reasons unrelated
to provenance — see [`sharing-policy.ts`](src/sharing-policy.ts).

What an account records instead of a tier is `provenance`, `"user"` or `"deployment"`, settled when
it connects. Provenance decides whether a server may rename itself over an administrator's chosen
label in an approval prompt, which is a question that should not move when an annotation setting
does.

## Applying an approved call

The guarantee is *at most once*, not exactly once. MCP has no idempotency key that would make a
repeated call harmless and no inverse operation that would undo one, so where the two conflict the
store prefers losing a result over repeating a write.

An approval is claimed in storage before the call is sent, which is what stops two concurrent
`applyAction` calls from both reaching the server. Once the call returns, the record is settled in
its own small write *before* the result is attached, so nothing about handling a server-controlled
payload — normalizing it, encoding it, or finding it too large for the Durable Object to store — can
lose the fact that the write already happened.

Failures are split by what the server is known to have done, because that is not something the
caller can work out afterwards. Only a `401` or `403` proves the tool was refused before dispatch.
Generic HTTP and JSON-RPC errors, dropped connections, malformed replies, and oversized bodies all
leave the outcome unknown; those are closed as failed and **not** retryable, since the request may
already have been carried out. The classification (`callMayHaveTakenEffect`) fails safe: anything it
cannot positively identify as declined counts as possibly performed.

The same rule covers an activation dying between sending the call and recording the reply. The claim
is not released for another attempt: after `APPLY_CLAIM_TIMEOUT_MS` the action is closed the same
way, saying it may or may not have taken effect.

So the cost of a network blip is a call someone has to stage again, deliberately. That is the trade
this module makes everywhere: an approval is never spent twice without a person saying so.

A failed call can always be discarded. The Workshop keeps a failed approval pending until the user
retries or discards it, and a call the agent awaits blocks its chat until then, so `reject` accepts a
`failed` record instead of refusing it. Discarding keeps the failure on record for the Gadget to
collect, so an unknown outcome is still reported as unknown, and rules out any further attempt.

## Sidecar apps

A tool result that names a `ui://` resource comes back carrying an `app` link, and opening that link
renders the server's own HTML in a sidecar page served by the connector that minted it. The page is
three nested documents, and the middle one is the point: the popup is the Host, an opaque-origin
sandbox proxy sits inside it, and the View sits inside that. A `srcdoc` frame that kept its parent's
origin would hand the View this deployment's own origin, which is exactly the escape the
specification's two-origin rule exists to prevent, so the sandbox is what stands in for the second
origin here. The View's own CSP travels as a `<meta http-equiv>` the proxy prepends to it, which is
the mechanism the specification names.

The page it opens is a tab, because no `target` can ask a browser for a window of a chosen size:
only `window.open` from a gesture can, and the chat's markdown renderer has no click of its own to
spend on that. So the page offers the one gesture it has — a button — and opens itself as
the sidecar the specification describes, marked with `?sidecar=1` so that the copy which lands in a
window offers nothing further and cannot open another. A browser that blocks the window says so in
the page and the app stays where it is: the tab a link opened is a working sidecar either way, and
the button only trades a click for the size.

The View reaches the deployment only through `POST /app/<account>/<token>/rpc`, and only via its own
page: the route answers a same-origin JSON post, reads a bounded body, and hands the message to the
account. `app-gateway.ts` owns what happens next, and the allowed surface is deliberately small — an
app may call a tool only if this binding classified it `mode: "read"`, only if the tool is inside the
grant the binding already holds, and only if the tool's own visibility admits apps; it may read
`ui://` resources and no others. Opening a link is the page's, not the endpoint's, and the page
passes `http(s)` to the browser and nothing else. Anything else is refused with `-32001` and a
sentence telling the user to ask the agent in the chat. Every request a View makes is recorded — the
tool it called or the resource it read, the outcome, and, for a read, how many items came back —
through the logger the host supplies (`AppGatewayHost.log`), because a window's own requests are the
one app surface no other log line covers.

One request is delivered rather than refused: `ui/message`, which asks the Host to put a text message
into the conversation that opened the link. Nothing in a link says which conversation opened it, so
delivery is a hook rather than a route the link carries. Whoever wants the app's messages — normally
the agent's `self`, in the `executeCode` call that shows the result — subscribes with
`subscribeAppMessages(app.url, self)`. The decorated result asks for that step itself, leading with
the instruction and naming the link: an agent decides whether to relay a result while reading it, and
the generated session type is reference material it read before it had one, so a link relayed without
subscribing renders perfectly well and sends nothing. The session has the account resolve the link,
mints an `AppMessageHookController` from the connector's own exports, and binds it on its approval
queue with a description naming the app and the server. The hook is born disabled and the user
enables it in Connections, the same way every other hook is enabled; only then does the controller
file the initiator the platform handed it, under `appMessageHook:<token>` beside the token record
rather than inside it, because a registration carries an RPC stub and the record is JSON measured
against a byte budget. A later `ui/message` for that token opens one firing (`startHook()`), files
the observation the hook contract asks for, and calls `receiveAppMessage({uri, text, key})` on the
callback.

The page declares the message capability, and renders its consent strip, only while a registration
exists — nothing the app or the server says can add one. The person sees the app's name and the text,
and nothing is posted until they press **Send**; the POST then carries a key the page chose once for
that send, so a repeat of the same request is one delivery. Delivery is at-least-once and the hook
does not dedupe, so a receiver keys its work on `McpAppMessage.key`. A non-text block is refused
before anyone is asked, a delivery the hook refused arrives as an error, and a link nobody has
subscribed to is told so in one sentence (`APP_MESSAGE_NOT_SUBSCRIBED`) that names the remedy: ask the
agent in the chat to subscribe. A registration does not outlive its link — a superseded token and an
expired one both take it with them — so a link that cannot deliver cannot be messaged.

The URI a tool or a result carries in `_meta.ui.resourceUri` is the resource's own `ui://` name. A
binding's endpoint may serve that same resource under a different name — a portal serves an upstream's
`ui://demo/dashboard` as `mcp-app-server_ui://demo/dashboard` and refuses the upstream's own — so the
host names it the way the endpoint serves it before it becomes a link's identity and the name its
window asks for. `McpFacetBase.normalizeAppResourceUri` applies `AppBinding.resourceUriPrefix` once,
idempotently (so a result that already carries the endpoint's name is left alone), and is the identity
for a binding that declares no prefix. `canonicalAppUri` then drops the routing parameters this
deployment owns (`APP_HOST_OWNED_URI_PARAMS`, today `server_id`), which a portal appends to the URIs it
advertises and which every endpoint this is built against refuses when a read carries one. The stored
name is therefore one the endpoint answers and that carries no host-owned parameter.

A resource is read under exactly one name: the resource's own `ui://` name for an endpoint that serves
it as declared, or the binding's prefixed name, `{prefix}{uri}` (see `AppBinding.resourceUriPrefix`),
for one that renames what it fronts. A portal answers a resource it fronts under its namespaced name
and refuses the URI the upstream declared with `-32602 Resource not found` — production logs and the
portal's own `resources/list` both show it — so when a prefix is declared the unprefixed name is not a
second chance, it is a request the endpoint has already said it will not serve, and `appResourceNames`
does not make it. A name is taken only when its read yields an app document, not merely any contents,
so a result the host cannot render is not mistaken for one it can. `appResourceName` on the view lines
records the name a read used.

A read that yields no document is not silent about why. It logs the reply's byte length
(`appResponseBytes`) and what the call returned — each item's URI and media type (`appContentUris`),
and, when none of them was a document, each item's URI, media type and body size (`appContentItems`),
the body itself never reaching a log line — and then asks the endpoint once, with a bounded
`resources/list`, what it does publish: `app.resource.list` carries `appResourceCount` and
`appResourceNames`, beside the full URI the read passed. So a link that will not open names what it
asked for, the size of the answer, and what was on offer, and a tiny empty answer is told apart from a
large one the host could not use. A listing that itself fails is logged and changes nothing the caller
already holds.

A mint that finds a live link whose stored binding names resources differently replaces it, since
that link can read nothing.

That rule is the whole design, not a setting. A sidecar window has no approval queue, and the
conversation behind its link — when there is one — receives only messages the person explicitly
approved, so there is nowhere for a queued write to be decided and nobody to tell the app it is
waiting. Never silently downgraded, never auto-approved: an app link is a second way to *see* what
the binding could already read, and not a grant of new authority.

What this host does not do:

- **No dedicated app origin.** The specification lets a resource declare `_meta.ui.domain`, so a
  host can serve each app from its own origin. This deployment has one origin per Worker, so the
  field is accepted and ignored, and the sandbox proxy carries the boundary instead.
- **No conversation of its own.** A window's messages go only where its link's subscription delivers
  them — the callback that asked to receive them, and only text the person approved in the page's
  consent strip. There is no chat to browse and no `ui/update-model-context`: a View is told exactly
  what it can do and nothing more.
- **No sampling, elicitation, or roots.** The host declares only what a window can honour, and a
  View feature-detects what is declared.
- **No app-provided tools.** The View calls this server's tools; it cannot add tools of its own.
- **No approval queue.** An app call is read-only by construction, never staged and never decided
  out of band.
- **No `resources/list`.** An app reads the `ui://` resource it is made of, by URI, and nothing
  else.

## Open gaps in the app route

Known and deliberately left, in the order they are most likely to matter:

- **One subscription per link.** `enable()` replaces whatever initiator was filed before it, so two
  chats that opened the same link cannot both receive its messages: the last subscription wins.
  Serving both means the registration holding a set, and delivering to each in turn.
- **Delivery is at-least-once, and nothing here dedupes.** The account opens a firing per request and
  passes the sender's key through; whether the same message arrives twice is the callback's to
  decide. `McpAppMessage.key` is what it keys on, and it is the page's random value rather than
  anything this deployment can verify.
- **The idempotency key covers only a repeat of the same POST.** The page posts once, on **Send**, and
  keeps no retry path, so the key it chooses guards a browser or proxy resend rather than a send this
  deployment could itself repeat. A page-side retry is the obvious next step, and the staged request
  already carries everything it would need.
- **`ui/message` carries text only.** A non-text content block is refused with `-32602` before a
  person is asked anything. Widening it means a content-block vocabulary in `McpAppMessage` and
  something the callback does with an image, neither of which exists today.
- **`ui/update-model-context` and `ui/download-file` are still refused by name.** The first is this
  route's natural sibling — context for future turns rather than a turn now — and would ride the same
  subscription; the second has no download path in a window that holds a bearer token.
- **Nothing drives the real connector end to end.**
  `integration-tests/__tests__/app-view-message-hook.test.ts` runs the real Workshop against a fixture
  gatekeeper playing the connector's part, and the connector's own enable/delivery path is unit-tested
  against a fake initiator. A fixture built on `@gadgets/mcp-shared` would close that seam.

## Limits

Fixed rather than configurable.

| Limit | Value | Where | Why |
| --- | --- | --- | --- |
| Described or individually granted tools per server | 200 | `tools.ts` | Bounds the picker and generated `.d.ts`; a server-wide grant can discover additional tools later |
| Catalog size | 96 KiB UTF-8 | `client.ts` | Leaves room below Durable Object's 128 KiB per-value limit for the cache wrapper and serialization overhead |
| Filtered discovery scan | 5,000 tools / 4 MiB | `client.ts` | Bounds work spent skipping unrelated tools while searching a large endpoint |
| Search query / results | 200 chars / 20 tools | `tool-search.ts` | Bounds agent-supplied matching work and the summaries returned to it |
| Hydrated definitions per facet | 200 tools / 1 MiB | `catalog.ts` | Bounds definitions fetched individually beyond the described catalog |
| Tool description | 4 KB | `client.ts` | As above, per tool, before it reaches storage |
| Tool input schema | 20 KB | `client.ts` | Dropped rather than clipped; half a schema is not a schema |
| `tools/list` pages | 50 | `client.ts` | Stops a cursor that never ends; exhaustion truncates catalogs and fails exact/search discovery as a scan limit |
| Response body | 1 MiB | `fetch.ts` | Every response is buffered whole before it can be parsed, and a `tools/call` result is otherwise unbounded |
| Bounded outbound operation | 30 seconds | `fetch.ts` | OAuth and discovery callers opt into one deadline covering redirects, pagination, body streaming, and session retry |
| Retained result | 128 KB | `action-store.ts` | Held until the Gadget collects it; oversized ones are replaced by a note |
| Retained actions | 100 | `action-store.ts` | Records are for collecting a result, not an audit log |
| Actions awaiting a decision | 50 | `action-store.ts` | These cannot be pruned, so uncapped they are an unbounded write |
| Tool description in a prompt | 600 chars | `tools.ts` | Server-controlled text in a security decision |
| Tool arguments in a prompt | 4000 chars | `tools.ts` | Agent-controlled text in the same decision |
| Server name | 60 chars | `account.ts` | As above; also stripped of Markdown |
| Redirect hops | 3 | `fetch.ts` | Each one re-checked; more is a loop, not a deployment |
| Connect link | 10 min | `connect-nonce.ts` | Single-use, and consumed on success |
| Unfinished connect | 1 hour | `connect-nonce.ts` | After which a half-built account deletes itself |
| App link (`APP_TOKEN_LIFETIME_MS`) | 24 hours | `app-tokens.ts` | Long enough to open a result from the conversation it appeared in, short enough that an old link stops working |
| App tool result (`MAX_APP_RESULT_BYTES`) | 64 KiB | `apps.ts` | What one View is handed per call; the agent's own copy of the same result is not bounded by this |
| Stored app call snapshot | 128 KiB | `app-tokens.ts` | The Durable Object's per-value limit, so a mint that would exceed it keeps the link and drops the result instead of failing |
| App JSON-RPC message | 64 KiB | `app-http.ts` | A `tools/call` with its arguments, not an upload: the data travels back in the reply |
| Sidecar window | 900 × 700 px | `app-page.ts` | A panel beside the conversation rather than a full window; the browser clamps it to the screen |
| App links per binding | one per `ui://` resource | `app-tokens.ts` | Reuse holds the key count at bindings × resources, the tightest bound reachable without `list()` |

## Build & test

```
pnpm --filter @gadgets/mcp-shared build   # tsc
pnpm --filter @gadgets/mcp-shared test:run    # vitest
```
