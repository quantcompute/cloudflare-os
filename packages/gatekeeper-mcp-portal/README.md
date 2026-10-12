# MCP Server Portals gatekeeper

Connects the deployment's own MCP portal as a Gadgets capability. An administrator configures one
URL; everyone in the organization then reaches every MCP server the organization has approved
through it, and no user ever types an endpoint. Runs as its own Cloudflare Worker and is
auto-discovered by the backend from its `GATEKEEPER_MCP_PORTAL` binding.

The intended deployment is a
[Cloudflare MCP server portal](https://developers.cloudflare.com/cloudflare-one/access-controls/ai-controls/mcp-portals/):
Access decides who may connect, Cloudflare Gateway logs and inspects what crosses, and this
connector turns what is behind it into typed capabilities that Gadgets can grant one server at a
time, or reach as a whole through the portal's own Code Mode sandbox.

For endpoints a user supplies themselves, use [`gatekeeper-mcp`](../gatekeeper-mcp/README.md).

## What it provides

One resource type, **MCP portal server**, at three grant breadths. A **server** or **named-tools**
grant names one upstream server; a **Code Mode** grant hands the Gadget the portal's own Code Mode
sandbox instead. "Everything the portal offers" as a bare-endpoint server grant is still not
offered, since it would hand a Gadget every tool of every system the organization has connected in
one click.

| Granularity | Resource URL | Session type |
| --- | --- | --- |
| **Server** — every tool of one upstream server, including ones it adds later | `<endpoint>#server=github` | `Mcp<Name><tag>Session` |
| **Named tools** — only the listed tools of that server | `<endpoint>#server=github&tool=github_a&tool=github_b` | `Mcp<Name><tag>Session` |
| **Code Mode** — the portal's two Code Mode tools, whose sandbox reaches every upstream tool the portal enables | `<endpoint>#codemode=search_and_execute` | `Mcp<Name><tag>Session` |

`<tag>` is four hex characters derived from the resource URL. It matters most here: two grants
pinning different tools of one upstream server share both the name and the endpoint, so the scope is
the only thing that distinguishes them.

A **Code Mode** grant is the one breadth that is *not* server-scoped, and cannot be made so. The
sandbox runs on the portal, so its `portal_codemode_execute` can call every upstream tool the portal
currently enables; the fragment asks the portal for Code Mode and nothing narrower. See
[Granting](#granting).

The session API — a typed method per described tool, plus `callTool`, `getActionResult`, and
`listTools` with progressive search/name options — is the same as
[`gatekeeper-mcp`](../gatekeeper-mcp/README.md#what-it-provides).

A server-wide grant can cover more tools than one catalog describes, so its authority is not limited
to the ones with generated signatures. `listTools({ search })` searches beyond the bounded preview
and returns up to 20 compact matches within the shared 5,000-tool / 4 MiB discovery scan;
`listTools({ name })` loads one exact bounded definition, and `callTool` resolves that name under the
same bound before dispatch. Every path rejects names outside the
binding's scope before loading the catalog or contacting the endpoint. Discovery and read results are
recorded as observations; writes retain the ordinary approval flow.

Scoping to one server also shrinks what the agent reads: only that server's tools are rendered as
signatures, and only as many as the budget describes. Additional tools are discovered on demand
within the explicit scan limits above; exceeding a limit fails rather than pretending a tool is absent.

## Configuration

| Variable | Meaning |
| --- | --- |
| `MCP_PORTAL_URL` | The portal's MCP endpoint. Unset means the connector hides itself. |
| `MCP_PORTAL_NAME` | Display name in the connector list and every approval prompt. Defaults to `MCP Server Portal (<host>)`. |
| `MCP_PORTAL_AUTH` | `oauth` (default), `none`, or `token`. |
| `MCP_PORTAL_TOKEN` | Secret bearer token, for `MCP_PORTAL_AUTH: "token"`. |
| `MCP_PORTAL_TRUST_ANNOTATIONS` | `true` to let upstream tool annotations drive auto-approval. Off by default; see below. |
| `MCP_PORTAL_HIDDEN_SERVER_IDS` | Comma-separated upstream server IDs to hide from the configurator and refuse at the grant boundary of a **server** grant. |
| `MCP_ALLOW_INSECURE` | `"true"` to disable the endpoint checks entirely: permits `http://` **and** private, loopback, link-local, and cloud-metadata hosts, for the portal and every OAuth URL discovered from it. Local dev only. |

A **server** or **named-tools** grant needs the portal to expose upstream tools directly. Use a
portal where Code Mode is off or opt-in, or append `?codemode=off` when its policy is default-on;
a portal that *enforces* Code Mode leaves no upstream tools to scope, so it offers nothing to a
server grant. `MCP_PORTAL_URL` is used exactly as configured and never carries a code-mode query
parameter.

A **Code Mode** grant is the connector's own use of that feature rather than a property of the
configured endpoint: the grant connects to the portal with `?codemode=search_and_execute`, which is
what its resource URL records. The connector assumes the portal's `code_mode` policy is `opt_in`
(or `default_on`) and never detects it — the policy is not discoverable over MCP — so where Code Mode
is off the two sandbox tools never appear and the grant fails at validation with a message naming the
portal's Code Mode policy, rather than silently behaving differently.

Only `MCP_ALLOW_INSECURE` is set in the repo's `cloudflare.config.ts`, pinned to `"false"` so the default
is explicit rather than merely absent. None of the others is, and a portal URL committed there would
become the default for every deployment of this repo and would send their users' OAuth flows to
whichever host it named, so it belongs in the deployment's own configuration — for Cloudflare's
internal deployment, the per-package overrides in `gadgets-internal`.

Unconfigured, `getSupportedResources()` returns nothing and the Workshop drops the vendor. A
`MCP_PORTAL_URL` that cannot be used — a non-`https` typo or a URL containing `username:password`,
say — is treated the same way, so a misconfiguration hides the connector rather than producing one
that fails on first use or copying URL credentials into account state and configurator fields.

Changing `MCP_PORTAL_URL` on a deployment that already has connected accounts is a **repoint**.
Existing bindings fail closed at once: the minting path checks facet props against current
configuration, and an already-minted facet must name its endpoint when asking the account for
credentials, which the account refuses after it has moved. The user recovers by reconnecting, which
is the one endpoint change an account will accept. It is accepted only because the new endpoint
comes from this Worker's configuration rather than from a form. Nothing held for the old portal
survives the move: tokens, the transport session, and any in-progress authorization are dropped, so
the user re-authorizes against the new host. The account advances a persisted generation before
probing; refreshes, expiry notifications, and session writes that started under the old generation
are ignored when they eventually return. Always-approve action kinds also include the exact endpoint,
so consent for the old portal does not carry over to the new one.

`MCP_PORTAL_TRUST_ANNOTATIONS` is read at each point of use (`portalTrust(env)`) and never
persisted on an account or a binding's props, so clearing it de-escalates every existing connection
on the next call. Setting it does not retroactively auto-apply anything; the user must still enable
a rule for each action kind.

## Local development

`pnpm dev-server` — and therefore `pnpm run-local`, which drives it — passes `MCP_PORTAL_*` through
from the shell and the repo-root `.dev.vars`, so a local portal is configured without editing a
tracked file:

```
MCP_PORTAL_URL=http://localhost:9000/mcp
MCP_ALLOW_INSECURE=true
```

`MCP_ALLOW_INSECURE=true` relaxes the connector's SSRF checks for a plain-`http://` portal on this
machine; without it such a portal is unreachable and the connector advertises no resources.
`MCP_PORTAL_AUTH`, `MCP_PORTAL_TOKEN`, `MCP_PORTAL_NAME`, `MCP_PORTAL_TRUST_ANNOTATIONS`, and
`MCP_PORTAL_HIDDEN_SERVER_IDS` travel the same way. The dev server copies these into the generated,
gitignored `wrangler.dev.jsonc`. None of this changes what a deployment ships: the committed
`wrangler.jsonc` still names no portal, and a deployment without `MCP_PORTAL_URL` still hides this
connector.

## How the connect flow works

There is no connect form: the endpoint is a deployment setting, so pressing "connect" goes straight
to the portal's own sign-in. Under `MCP_PORTAL_AUTH: "oauth"` the gatekeeper runs the same
discovery chain as [`gatekeeper-mcp`](../gatekeeper-mcp/README.md#how-the-connect-flow-works)
against the portal; under `"token"` it presents `MCP_PORTAL_TOKEN` and no user interaction is
needed; under `"none"` it connects unauthenticated.

The account records `provenance: "deployment"`, which is what keeps an upstream server from renaming
itself over `MCP_PORTAL_NAME` in every approval prompt.

## Granting

The configurator first asks what kind of grant this is — one server behind the portal, or the
portal's Code Mode sandbox:

```
Grant type · How this Gadget should reach the portal.
(•) Server behind the portal   Grant one upstream server, or a subset of its tools.
( ) Code Mode                  Hand the Gadget the portal's search-and-execute sandbox instead.
```

Choosing **Code Mode** hides the server and tool questions and emits
`<endpoint>#codemode=search_and_execute`, which is the whole grant. Otherwise it asks which server
behind the portal, how broad the grant is, and — if it is pinned — which tools:

```
Server · Which server behind this portal to grant. Its tools appear next.
[ 🔍 GitHub ]

Tools · Choose how much of this server the Gadget may call.
(•) All tools      Every tool this server offers, including ones it adds later.
( ) Choose tools   Only the tools you tick. Anything else is refused, including tools added later.

Allowed tools · Read-only tools return data straight away. The rest queue for your approval.
[ 🔍 Filter tools... ]
12 of 12 selected                                                                     Clear
☑ List issues                                                                     read-only
☑ Create issue                                                               needs approval
```

**All tools** is the default. The breadth is asked outright rather than inferred from whether every
box is ticked, since the two look identical and diverge as soon as the server publishes another
tool. A portal with one server behind it collapses to the tool questions alone, because the choice
is made for the user rather than skipped — the grant still records that server.

A **server** grant always names exactly one upstream server; there is no server-grant breadth that
spans the portal. A configured endpoint with no upstream servers — a plain MCP server, or a portal
that currently fronts nothing — therefore has no server grant to offer. Point a plain MCP endpoint
at the **MCP** connector (`gatekeeper-mcp`) instead, which is built for exactly that and offers
endpoint-wide and per-tool grants.

**Code Mode** is the deliberate exception, and the only grant here that reaches the whole portal. It
hands the Gadget the portal's own sandbox, whose `portal_codemode_execute` can call any upstream tool
the portal enables, including servers and tools added later. That breadth cannot be narrowed: the
sandbox runs on the portal, so no `#server=` or `#tool=` scope could confine it, and the connector
does not pretend otherwise. It also is not a bare-endpoint grant of the portal's direct tools — it
exposes exactly the two Code Mode tools and nothing else. `MCP_PORTAL_HIDDEN_SERVER_IDS` cannot
constrain it: that setting filters the server picker and refuses a server grant, and a Code Mode
grant has no server to filter or refuse.

## How upstream servers are recovered

A portal flattens every upstream server's tools into one `tools/list`, so the seam has to be
recovered from two facts in the portal's documented contract:

1. Every tool is named `{server_id}_{original_name}`, split on the first underscore only, and an
   alias replaces the tool name but never the server-id prefix. Membership is therefore a pure
   string test needing no network call, so a server scope cannot fail open on a transient error.
2. `portal_list_servers` is available in every portal session that is not in Code Mode, and returns
   each upstream server's id, name, and enabled state. A Code Mode session exposes only the two
   `portal_codemode_*` tools, so a code-mode grant is recognised from its scope fragment rather than
   from a server listing.

Detection of a **server** grant is a capability probe — does the endpoint offer
`portal_list_servers`? — not a hostname match, so it works for a custom portal hostname and for any
other aggregator adopting the convention. A *truncated* listing counts as a portal whether or not the
probe tool is in it: `tools/list` is unordered, so concluding "not a portal" because the evidence
fell past the cut would fail open on the `portal_*` exclusion below. Truncation is reported by the
client rather than inferred from the tool count, because either cap can stop a listing — the count
the caller asked for, or the 96 KiB UTF-8 budget, and the latter can cut a listing of verbose tools
short while leaving an array that looks complete. The byte budget leaves 32 KiB below Durable
Object's per-value limit for
the cache wrapper and serialization overhead; if storage nevertheless rejects the cache value, the
fresh catalog is still used for that operation rather than turning a cache miss into a failure.

### Surveying a portal too large for one catalog

The configurator normally gets server names directly from `portal_list_servers`, without surveying
every upstream tool. If that response is unavailable or only partly understood, it falls back to a
**name-only tool index** of up to 1,000 entries. The index detects the portal and recovers server
membership from tool-name prefixes; it carries no descriptions, schemas, or policy claims, so the
96 KiB result budget covers as many names as possible. A truncated fallback cannot establish the
complete server list and blocks the form rather than presenting a partial list as complete.

After a server is selected, a separate filtered scan returns up to 200 compact summaries from that
server. Each summary carries its bounded title, description, and annotations, and is classified
through the shared `tools.ts` trust boundary before it becomes a read-versus-approval label. The
filter is applied before result budgets, so unrelated servers cannot crowd the selected one out.
Only the returned prefix is offered for an individual-tool grant; additional tools require the
server-wide grant, and a call resolves the full definition before approval or dispatch.

Index entries are typed separately (`IndexedTool`) to distinguish name-only survey results from tool
definitions rendered into approval prompts or handed to an agent.

The server list is advisory: it supplies display names and ordering while tool-name prefixes remain
the authority on membership, and a failed call degrades to bare ids recovered from tool prefixes.
The gatekeeper makes that call
while building a form, so it does not pass through the approval queue. Failing to reach the portal
at all is different, and blocks the grant rather than falling back to the bare endpoint — the
configurator reports it and stays unsubmittable.

`portal_*` tools are excluded from every server grant at every scope: `portal_toggle_servers` and
friends change which upstream servers the session can reach, so granting one would let a Gadget widen
its own authority. This is a capability-boundary rule, not a policy preference, and is not
configurable. A **Code Mode** grant is the deliberate exception and does not go through that
exclusion: its scope admits exactly `portal_codemode_search` and `portal_codemode_execute`, and
refuses every other portal-native tool and every upstream tool alike. The authority the sandbox
behind `execute` wields is the portal's own, not something this connector grants tool-by-tool.

## Approvals and sharing

Identical to [`gatekeeper-mcp`](../gatekeeper-mcp/README.md#approvals-and-sharing), except for the
trust tier. A portal is an aggregator: `destructiveHint` and `idempotentHint` are written by
whichever upstream server it fronts, servers the administrator who chose the portal never reviewed,
and any one of them could self-declare both and get writes that skip the approval prompt. So the
tier is `byo` unless a deployment sets `MCP_PORTAL_TRUST_ANNOTATIONS=true`. That flag is the
"trusted server" assertion MCP's guidance asks for, and it has to be about the upstreams themselves,
not just the portal in front of them.

A **Code Mode** grant is outside the tier entirely. Its two tools are classified by this connector
rather than by any server's annotations: `portal_codemode_search` is a read and
`portal_codemode_execute` is an action, on either tier, and neither can be auto-approved. The
sandbox behind `execute` can call any upstream tool the portal enables — including ones no catalog
ever described — so no annotation and no trust setting could make spending it automatic.

`addObserver` refuses everyone, as it does for user-supplied endpoints. Reaching the portal is not
the same as being allowed to see a particular tool result, and the Gadget runs on the owner's
credentials regardless. A sharper check is available here than for a bare endpoint —
`portal_list_servers` is per-user and Access-filtered, so it could confirm a collaborator may reach
the same server — but that is still server-granular, not record-granular. See
[`sharing-policy.ts`](../mcp-shared/src/sharing-policy.ts).

## Sidecar apps

Identical to [`gatekeeper-mcp`](../gatekeeper-mcp/README.md#sidecar-apps), with the grant in force
being this binding's: a `ui://` result from an upstream server opens with that server's scope and
through the portal's own session, so nothing else behind the portal becomes reachable by opening a
link. Hidden upstream servers are refused at the grant boundary, so no app link can reach past
`MCP_PORTAL_HIDDEN_SERVER_IDS` either. The read-only rule is enforced in `@gadgets/mcp-shared`, so
the two connectors cannot serve two different policies for the same link.

Sending a message back is the same subscription described there, minted from this Worker's own
`AppMessageHookController` export: the agent calls `subscribeAppMessages(app.url, self)`, the user
enables the resulting hook in the Workshop's Connections UI, and only then does **Send** in the
page deliver the app's text into that conversation. The upstream server's name is what the hook's
description shows, so a reader of the Connections list sees which server behind the portal asked.

The portal **renames the resources it fronts**, exactly as it namespaces tools and prompts: it lists
an upstream's `ui://demo/dashboard` as `mcp-app-server_ui://demo/dashboard`, and the view a tool
declares in `_meta.ui.resourceUri` is the upstream's plain `ui://` name. This connector supplies
`resourceUriPrefix`, so that declared name is prefixed once —
`ui://SuiteApps/…/prompt-library-app/mcp-app.html` becomes
`netsuite-sb1_ui://SuiteApps/…/prompt-library-app/mcp-app.html`, the name the portal's own
`resources/list` publishes — and that prefixed name is the app's identity and the name its window asks
for. The portal also *decorates* advertised URIs with a `?server_id=` routing parameter; that is not
part of a resource's identity and a read carrying it is refused, so `canonicalAppUri` drops it. The
read then goes out under the prefixed name — the one production logs and `resources/list` both show
the portal answers — and the resource's own `ui://` name is never tried, because the portal has already
answered it with `-32602 Resource not found` and a second read of it would only repeat that. A name is
taken only when its read yields an app document; when it yields none, the call's result is logged and
the endpoint is asked once, with a bounded `resources/list`, what it does publish. The minted link logs
both names (`appUri`, `resourceUri`), and `appResourceName` on the view lines records the name the read
used, which is the pair to read when a link fails to open.

The same prefix resolves the tools an app calls: a window's `tools/call` names the tool the way its
own document knows it — the upstream's own name, e.g. `ns_getSuiteQLMetadata` — and the binding
prefixes it once so the call reaches the endpoint under the name it answers, `netsuite-sb1_ns_getSuiteQLMetadata`
(see `appToolNames` and `boundTool`). Without that, a working app would be refused with "this binding
does not grant it" for a tool the grant plainly allows, because it belongs to the scoped server only
under its namespaced name.

A **Code Mode** grant names no single upstream server, so it supplies no `resourceUriPrefix`: there
is no one server name for this connector to prefix a resource with, and the portal's own naming is
whatever the sandbox result carried.

Links minted before that prefix existed name a resource the portal will not serve, so a mint replaces
one rather than reusing it when the binding's resource naming has changed; an untouched link still
expires after its 24 hours.

## Notes and current limitations

The limitations in
[`gatekeeper-mcp`](../gatekeeper-mcp/README.md#notes-and-current-limitations) apply here too: no
simulation, no revert, no notification hooks, no scoping below tool names, and `tools/*` only. SSRF
is enforced the same way, by `global_fetch_strictly_public` rather than by hostname patterns. In
addition:

- **One portal per deployment.** `MCP_PORTAL_URL` is a single value; a second portal needs a
  second Worker.
- **Server ids come from tool-name prefixes.** An aggregator that flattens tools without prefixing
  them exposes no upstream seam, so this connector finds no server to scope a **server** grant to and
  that form stays unsubmittable. It is not granted as a bare-endpoint server grant — that breadth
  does not exist here. A **Code Mode** grant reaches the whole portal if the portal offers it, but
  through the portal's own sandbox rather than by exposing the endpoint's tools directly. For an
  endpoint-wide grant over the tools themselves, use the **MCP** connector (`gatekeeper-mcp`), where
  that breadth is an explicit, reviewable choice.

## Layout

| File | Purpose |
| --- | --- |
| `src/portal.ts` | Vendor, account DO, user, gatekeeper facet, session, configurator RPC, app-message hook |
| `src/config.ts` | Reading and validating the deployment's portal configuration |
| `src/configurator/` | The grant UI (compiled into `src/generated/`) |

Everything else comes from [`@gadgets/mcp-shared`](../mcp-shared/README.md).

## Build & test

```
pnpm exec vp run -F @gadgets/mcp-portal-gatekeeper build   # build:configurator + tsc
pnpm --filter @gadgets/mcp-portal-gatekeeper test:run    # vitest
```

The Worker is run via the root `pnpm dev-server`, not directly.
