# dimhour-webmcp

`webmcp.js` — the [WebMCP](https://developer.chrome.com/docs/ai/webmcp) tool layer for
[dimhour.com](https://dimhour.com). Five **read-only** tools an on-page AI agent can call
instead of scraping the DOM.

MIT. One file, no build step, no dependencies.

---

## ⚠️ Prior work, stated plainly

Most of what makes these tools useful **existed before this challenge began**. This repo
contains the part that is new. Drawing that line explicitly, because the interesting claim
here is the thin layer, not the catalog underneath it:

| Component | Status | First commit |
| --- | --- | --- |
| The Dim Hour **MCP server** (`mcp.dimhour.com`) these tools call | **PRIOR WORK** | 2026-06-05 |
| The **catalog** they read — more than 19,000 places across 24 cities (the live site's own claim) | **PRIOR WORK**, built over months |
| The **booking-platform table** (`booking-prefill.js`) that resolves Resy / OpenTable / SevenRooms / Tock | **PRIOR WORK** | 2026-08-11 |
| The **`/tonight` rule** these tools reuse (`tonight-pool.cjs`) | **PRIOR WORK** | 2026-08-25 |
| **`webmcp.js`** — this file | **NEW** | 2026-09-03 |
| The `<script>` include in dimhour.com's `index.html` | **NEW** | 2026-09-03 |

So: the server, the data and the booking table are not new. The WebMCP adapter is. Every
commit in this repo is dated, and the two new pieces above are the whole of the submission.

The headline numbers are the live site's own public claim (dimhour.com: "more than 19,000
places" across 24 cities), so this README, the Devpost submission and the site all say the
same thing.

---

## What it does

Five tools, all read-only:

| Tool | What it answers |
| --- | --- |
| `search_venues` | "Find omakase in Dallas." One strong keyword beats a sentence. Returns numeric ids. |
| `get_venue` | The full record for one venue — hours, phone, address, score, awards. |
| `find_open_tonight` | "What's good tonight?" — happy hour or a late kitchen, the same rule the site's own tonight strip uses. |
| `build_itinerary` | Drafts a night out as ordered stops, each with why it's there and how to book. |
| `get_booking_link` | The reservation platform, and the booking URL where it's available. |

### It never writes

There is no `save_venue`, no `add_to_trip`, no write of any kind. An agent acting on a page
a user is looking at should not be able to change that user's data without them touching
anything. Saving a trip stays a human action; `build_itinerary` returns a draft and points
at `/trip.html`.

It also never calls `window.open`. A tool runs without a user gesture, so a popup is blocked
by the browser anyway — `get_booking_link` returns the URL and lets the agent present it.

### It is silent when unsupported

```js
var MC = document.modelContext || navigator.modelContext || null;
if (!MC || typeof MC.registerTool !== 'function') return;
```

No model context, no tools, no console output. A page that logs "WebMCP not supported" on
every load in every browser is noise in ~100% of sessions today.

**The API is mid-rename.** The proposal shipped as `navigator.modelContext` in Chrome
146–149; Chrome 150 deprecated that for `document.modelContext`. Both are resolved,
`document` first. That is one API under two names during a rename, not a fallback — delete
the `navigator` branch when 149 is out of support.

---

## Using it

```html
<script defer src="webmcp.js"></script>
```

That's the whole integration. The tools POST JSON-RPC `tools/call` to
`https://mcp.dimhour.com/mcp`. No auth — these are the same public read-only tools the MCP
server already serves to ChatGPT and Claude connectors.

---

## Two things worth knowing if you fork this

**1. The booking link is read locally, not from the server.** The Dim Hour MCP server carries
no `reserveUrl` anywhere, deliberately — it names the reservation *platform* as text and
promises nothing clickable, so a host can't advertise an action it can't perform. So
`get_booking_link` reads the URL from the page's own catalog when that city is loaded, and
when it isn't, it returns the platform plus the venue page and **explicitly refuses to
construct a URL**. Never invent a booking link.

**2. `find_open_tonight` reads `get_venue`, not search rows.** The search endpoint doesn't
return `hours` — only `get_venue` does — and the catalog calls happy hour `hh` while the
server renames it `happy_hour`. Filtering search rows therefore tests fields that aren't
there and returns an empty list *forever*, in a sentence that reads like a real answer. This
was a real bug in the first version: 0 of 25 candidates, every time.

**Known inherited defect:** the `/tonight` late-close rule matches any a.m. time, so an
*opening* time reads as a late close (a venue open `8am-6pm` counts as a late kitchen).
Measured across the catalog: 10,873 venues match the rule and 6,996 of them (64%) match only
on a morning opening. This file mirrors the site's rule faithfully rather than forking it, so
it inherits that until it is fixed upstream in one place.

---

## Testing notes

Verified 2026-09-03:

- **Live, against `mcp.dimhour.com`** — 13/13 checks, all five tools returning real results.
- **Real browser at 414px** — 8/8: with no `modelContext` it registers nothing and logs
  nothing (zero console output, zero JS errors); with one present, all five register with
  real schemas and a genuine cross-origin call from the page succeeds.
- **CORS** — `mcp.dimhour.com` answers preflight `204` with `access-control-allow-origin: *`,
  `Content-Type` allowed, `POST` allowed. Left at `*` on purpose: this is a public read-only
  server and ChatGPT and Claude connectors call it from origins that aren't ours.

To try it yourself: enable the WebMCP flag in `chrome://flags` (experimental since Chrome
146), open dimhour.com, and ask the agent for omakase in Dallas.
