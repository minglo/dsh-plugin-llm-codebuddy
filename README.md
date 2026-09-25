# dsh-plugin-llm-codebuddy

Tencent CodeBuddy LLM adapter for DeepSeek Harness.

This plugin exposes Tencent CodeBuddy's model catalog and chat endpoint to DeepSeek
Harness (`dsh`) as an LLM provider route named `codebuddy`. It is read-only: it
reads the grant record and model catalog, streams chat completions, and refreshes
the bearer token in place — it never creates or deletes grant records on its own.

## Install

```sh
dsh plugin add dsh-plugin-llm-codebuddy
```

## Credentials

CodeBuddy authenticates with a browser-issued bearer token. The adapter reads the
grant record `plugin-llm-codebuddy/codebuddy` from the credentials seam
(`@deepseek-ai/dsh-credentials`); the bearer token is NOT provided as a config
value and is never persisted to disk by this plugin.

The token reaches that record through the **AuthorizationFlow** login: a
browser sign-in writes the `plugin-llm-codebuddy/codebuddy` grant record
directly (see `dsh-codebuddy` authorization flow).

If no grant record exists, model listing degrades to an empty list (browsing
semantics), while an actual request fails with `MISSING_CREDENTIAL`. When the
access token is near expiry the session refreshes it against the CodeBuddy auth
endpoint; refresh failures do not delete the record, and the record is only
reported missing once the refresh token itself has expired.

## Configuration

The plugin's `Config` schema (schemastery) accepts these optional fields:

| Field | Default | Meaning |
| --- | --- | --- |
| `baseURL` | `https://copilot.tencent.com/v2` | Chat-plane base URL (trailing slashes stripped). |
| `defaultContextWindow` | `128000` | Context window for models the catalog does not size. |
| `defaultMaxTokens` | `8192` | Max output tokens for models the catalog does not size. |
| `streamIdleTimeoutMs` | `300000` | Idle watchdog timeout for the chat stream. |

`baseURL` must be non-empty; the numeric fields must be positive (the context and
token defaults must be positive integers, `streamIdleTimeoutMs` a positive finite
number). Bad values fail loudly at load time. Requests are sent to
`<baseURL>/chat/completions` as SSE (`stream: true`) with
`stream_options.include_usage: true`.

## Web search and fetch backends

The plugin can back the stock `web_search` / `web_fetch` tools with the CodeBuddy
gateway's own `/agenttool/v1/search` and `/agenttool/v1/webfetch` endpoints,
reusing the same signed-in grant as chat. No extra credential is needed.

**Settings → Plugins → CodeBuddy → "Search with CodeBuddy"** turns this on. The
switch appears **only while signed in**: with no grant the plugin registers no
provider at all, so a switch there could not do anything.

| Aspect | Behaviour |
| --- | --- |
| Default | **Off.** Installing the plugin never silently takes over the search slot. |
| Effect timing | Live — no `dsh web` restart. |
| Scope | One switch controls both `web_search` and `web_fetch`. |
| Sign-out | Releasing is automatic: the backends unregister as soon as the grant is cleared. |
| Sign-in | Re-acquiring is automatic once a grant exists and the switch is on. |

### Confirming which backend a search actually used

The switch states **intent**; it does not prove the takeover happened. A badge on
the search switch row states **effect**, read from the seam's own
`searchProviderId` field — the exact value `web_search` / `web_fetch` dispatch on:

| Badge | Meaning |
| --- | --- |
| **CodeBuddy search active** (green) | The selection field points at this plugin: searches really go to the CodeBuddy gateway. |
| **Search not taken over** (grey) | Deliberate opt-out, or signed out — the field belongs to another provider (or to none). |
| **Takeover not in effect** (amber) | Enabled *and* signed in, yet the takeover did not happen: no `web` service, a host that does not expose the selection fields, or a rejected registration. |

The badge distinguishes the last two on purpose: without it, "the switch is on
but had no effect" is indistinguishable from "the switch is off". It is read on
every `status()` call and refreshed right after you move the switch, so it never
shows a stale backend. If a third party claims the slot while this plugin is
live, the badge stops claiming CodeBuddy — it follows the field, not the plugin's
own registration state.

The badge sits on the plugin's settings card (`Settings → Plugins → CodeBuddy`)
next to the switch, and appears only while signed in, the same condition under
which the search row itself is shown.

Reading `status()` also performs a **self-healing resync**: the plugin asks
whether the takeover is live, and if not, re-reads the login state before
reporting. This matters because the grant may already exist on disk at boot while
the credential service is not readable yet — and a pre-existing grant emits **no**
`credentials/record-updated` event, so nothing else would ever correct an
initially-wrong login reading. Without this, "switch on + signed in" could stick
at "not taken over" until the whole `dsh web` process restarted. The resync is a
no-op once live, and skipped entirely while the switch is off.

A per-result attribution label on the `web_search` tool cards is **not** possible
from this plugin: `WebSearchSource` (`url`/`title`/`snippet`/`publishedAt`) and
`WebSearchProvider` (`id`/`available()`/`search()`) carry no provider field into
the rendering layer, and `dsh-tool-web` exposes no decoration slot. That would
need an upstream change.

Selection is taken over at **runtime**, never by pinning `web.searchProvider` in
`cordis.patch.yml`. Pinning would replace the whole `web` row config and
permanently steal the default slot from other providers (for example a
free-search plugin); instead the plugin remembers whatever occupied the slot,
takes it over while enabled, and restores that exact value on release — without
hardcoding any provider id, so it cooperates with any third-party backend. If a
different provider claims the slot while this plugin is live, the release leaves
that newer choice alone.

Takeover writes `searchProviderId` / `fetchProviderId`, which upstream `dsh-web`
declares `private readonly`. That is a deliberate, documented reach past the type
system, not a supported upstream seam: every official provider package
(`web-search-exa`, `-deepseek`, `-perplexity`, `web-fetch-http`, `tool-web`) only
calls `registerXxxProvider` — none reads or writes these fields. It is necessary
here because the seam resolves selection as *pinned id first, else the single
available provider*, and `dsh-base` plus most provider plugins do pin
`web.config.searchProvider`, so a register-only backend would never be selected
at all.

If those fields are absent (a future host that truly seals them), the plugin
registers nothing rather than registering without taking over: in an unpinned
composition a second available provider makes the seam raise
`WEB_PROVIDER_AMBIGUOUS` for *everyone*, so register-only would turn this
plugin's own no-op into a global search outage. Not registering never harms
another provider — it only leaves this backend unusable, which is what it would
have been anyway.

When the `web` service is absent or registration is rejected (duplicate id), the
plugin likewise logs a warning and degrades gracefully rather than failing to
load.

Because the gateway relays fetches on the server side, an unresolvable or blocked
target surfaces as a gateway error code (for example `15018` for a blocked host)
rather than a local network error.

## Model catalog

Models are advertised from the advisory `/v3/config` catalog. An entry is only
shown when it discloses capacity (both `maxAllowedSize` and `maxOutputTokens` are
positive); entries without disclosed capacity are hidden from the picker but can
still be routed explicitly. Explicit ids outside the catalog resolve to a
conservative text-only shape using the configured defaults.

## User agent

Requests carry a white-label attribution header `dsh-codebuddy/<version>
(+https://github.com/minglo/dsh-plugin-codebuddy)`. The harness default identity is
deliberately not used (the upstream endpoint rejects it), and the plugin does not
impersonate the CodeBuddy CLI/IDE user agent.

## Usage metering (sidebar indicator)

The sidebar footer action shows one composite bar over **total remaining
credits** (`totalBalance`): the highlighted segment is the **remaining credits
that expire this month** (`monthPoolRemain` = sum of `CycleEndTime`-this-month,
unexpired packages). The figure beside it is the **monthly consumption rate**
(`monthPool.used / monthPool.size`), so early-month heavy use turns the color
from green to orange/red while a low rate late in the month reads green. Hover
reveals three absolute numbers: remaining this month, used/size this month, and
total remaining.

Hosts that predate `monthPool` (missing the field entirely) render the bar from
`totalBalance` alone and treat the monthly fields as zero — no crash, degraded
view. The legacy `monthly` bucket (which excluded the ≤7-day window) has been
removed: the settings card and the sidebar indicator both read `monthPool`, a
single accounting basis.

## Deferred

Not implemented in this MVP:

- **Usage metering** (`/v2/billing/meter/*`).
- **AuthorizationFlow login** — the grant record key is the intended write target;
  the codebuddy login flow requires an `authorization` seam (headless setups sign
  in through the client settings card instead).
- **Client settings page** (`dsh.client` + settings section).
- **CLI login command** (`dsh-codebuddy-login`).
- **Catalog/user-config merge** — merging the `/v3/config` cache with user-edited
  model entries (user wins) once settings are wired up.

## License

MIT — see [LICENSE](./LICENSE).
