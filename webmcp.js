/*!
 * webmcp.js — Dim Hour's tools for on-page AI agents (WebMCP).
 *
 * Registers five READ-ONLY tools on the browser's model context so an agent on
 * dimhour.com can search the catalog, read a venue, filter to tonight, draft an
 * itinerary, and hand back a booking link — without scraping the DOM.
 *
 * ── WHAT THIS IS NOT ────────────────────────────────────────────────────────
 * Every tool here READS. There is deliberately no save_venue, no add_to_trip,
 * no write of any kind: an agent acting on a page the user is looking at should
 * not be able to change that user's data without them touching anything. Saving
 * stays a human action on /trip.html, and build_itinerary points there rather
 * than doing it.
 *
 * It also never calls window.open. A tool runs without a user gesture, so a
 * popup is blocked by the browser anyway — get_booking_link returns the URL and
 * lets the agent present it.
 *
 * ── FEATURE DETECTION ───────────────────────────────────────────────────────
 * No model context, no tools, no console output. A page that logs "WebMCP not
 * supported" on every load in every browser is noise in 99.99% of sessions.
 *
 * ⚠️ THE API IS MID-RENAME AND BOTH SPELLINGS ARE LIVE. The proposal shipped as
 * `navigator.modelContext` in Chrome 146-149 and Chrome 150 deprecated that for
 * `document.modelContext`. This resolves `document` first and falls back to
 * `navigator` — not a second lane, one API under two names during a rename, and
 * the flag has been available since 146 so both are reachable today. When 149 is
 * out of support the navigator branch should be deleted, not kept "just in case".
 */
(function () {
  'use strict';

  var MC = (typeof document !== 'undefined' && document.modelContext)
        || (typeof navigator !== 'undefined' && navigator.modelContext)
        || null;
  if (!MC || typeof MC.registerTool !== 'function') return;   // silent no-op

  var ENDPOINT = 'https://mcp.dimhour.com/mcp';

  /** Hard ceiling on rows returned to an agent. A tool result is context the
   *  model pays for; 25 venues is already a long answer. */
  var MAX_RESULTS = 25;

  /* ── the tonight rules, mirrored from scripts/lib/tonight-pool.cjs ─────────
   * The /tonight surface already defines what "tonight" means on this site —
   * a food-and-drink venue with a happy hour or a late close, best score first.
   * Inventing a second definition here would let the agent and the page
   * disagree about the same city on the same evening.
   *
   * They are MIRRORED rather than imported because this file ships standalone
   * (it is also the whole of the public dimhour-webmcp repo) and tonight-pool is
   * CommonJS. scripts/guard-webmcp-tonight-parity.cjs fails if the two drift. */
  var FB_KINDS = { restaurant: 1, bar: 1, cafe: 1 };
  /* Corrected 2026-09-03 with the module (#1583): the old pattern asked whether
     an a.m. hour appeared ANYWHERE in the hours string, which an OPENING time
     also is — "Mon-Sun 8AM-5PM" read as a late kitchen. 6,698 of 10,873 flagged
     venues were wrong, and 476 genuinely late ones were missed because
     "12:00am" never matched. An a.m. hour now counts only where it CLOSES a
     range, and only 12am-5am. */
  var LATE_RE = /(?:[-–—]|\bto\b|\buntil\b|\btill?\b)\s*(?:12|[1-5])(?::[0-5]\d)?\s*a\.?m\.?\b|\bmidnight\b|\b(?:24\s*h(?:ou)?rs?|open\s*24)\b|\blate\b/i;
  /* ⚠️ TWO FIELD NAMES FOR ONE FACT. The catalog calls it `hh`; the MCP server
     renames it `happy_hour` on the way out. Reading only `hh` — which is what
     tonight-pool does, correctly, against the catalog — made this filter match
     NOTHING through the API: 0 of 25 candidates, every time, reported as a
     confident "nothing is open tonight". Both spellings are read here because
     both are real. */
  var hasHappyHour = function (x) {
    var v = x && (x.hh !== undefined ? x.hh : x.happy_hour);
    return !!(v && String(v).trim().length > 2);
  };
  var closesLate = function (x) { return !!(x && x.hours && LATE_RE.test(String(x.hours))); };
  function openTonight(x) {
    if (!x) return false;
    /* `kind` is a catalog field the MCP server does not emit, so through the API
       this never excludes anything. Kept because it is the /tonight rule and the
       parity guard checks it; stated so nobody reads the filter as tighter than
       it is over this transport. */
    if (x.kind && !FB_KINDS[x.kind]) return false;
    return hasHappyHour(x) || closesLate(x);
  }

  /* ── the transport ────────────────────────────────────────────────────────
   * One JSON-RPC POST per call. No auth: these are the same public read-only
   * tools the MCP server already serves to ChatGPT and Claude connectors.
   *
   * The server answers a tools/call with its payload as JSON inside
   * content[0].text, so a caller that reads `result` alone gets an envelope and
   * no data. Unwrapped here once, rather than in five tools. */
  function rpc(name, args, signal) {
    return fetch(ENDPOINT, {
      method: 'POST',
      credentials: 'omit',
      signal: signal,
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: Date.now(), method: 'tools/call',
        params: { name: name, arguments: args },
      }),
    }).then(function (r) {
      if (!r.ok) throw new Error('Dim Hour MCP returned HTTP ' + r.status);
      return r.json();
    }).then(function (j) {
      /* An RPC-level error is a real failure and must not read as an empty
         result — an agent told "no venues" when the server actually refused
         will confidently tell the user the city has nothing. */
      if (j && j.error) throw new Error(j.error.message || 'Dim Hour MCP error');
      var c = j && j.result && j.result.content;
      var text = c && c[0] && c[0].text;
      if (typeof text !== 'string') return (j && j.result) || {};
      try { return JSON.parse(text); } catch (e) { return { text: text }; }
    });
  }

  /** Tool results are strings per the WebMCP imperative API. */
  var out = function (o) { return JSON.stringify(o, null, 1); };
  var num = function (v) { var n = parseInt(v, 10); return isNaN(n) ? undefined : n; };
  /** Drop undefined/empty keys — the server treats an absent filter and an
   *  empty one differently, and an agent passing "" should mean "no filter". */
  function clean(o) {
    var r = {};
    for (var k in o) if (o[k] !== undefined && o[k] !== null && o[k] !== '') r[k] = o[k];
    return r;
  }

  /* ── 1. search_venues ─────────────────────────────────────────────────── */
  MC.registerTool({
    name: 'search_venues',
    description:
      'Search Dim Hour\'s curated catalog of restaurants and bars across 24 cities. '
      + 'Query terms are matched individually, so ONE strong keyword ("omakase", "patio", '
      + '"natural wine") works far better than a sentence. Omit city to search everywhere. '
      + 'Returns venues with their numeric id, which get_venue and get_booking_link take.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'One strong keyword. Not a sentence.' },
        city: { type: 'string', description: 'City key, e.g. dallas, nyc, sf. Omit to search all cities.' },
        neighborhood: { type: 'string' },
        cuisine: { type: 'string' },
        min_score: { type: 'number', description: 'Dim Hour score floor, 0-100.' },
        max_price: { type: 'number', description: 'Price tier ceiling, 1-4.' },
        limit: { type: 'number', description: 'Max rows, capped at ' + MAX_RESULTS + '.' },
      },
    },
    execute: function (input, ctx) {
      var i = input || {};
      return rpc('search_venues', clean({
        query: i.query, city: i.city, neighborhood: i.neighborhood, cuisine: i.cuisine,
        min_score: num(i.min_score), max_price: num(i.max_price),
        limit: Math.min(num(i.limit) || 10, MAX_RESULTS),
      }), ctx && ctx.signal).then(function (d) { return out(d); });
    },
  });

  /* ── 2. get_venue ─────────────────────────────────────────────────────── */
  MC.registerTool({
    name: 'get_venue',
    description:
      'Get the full Dim Hour record for one venue: hours, phone, address, cuisine, '
      + 'neighborhood, score, awards, and how to book it. Takes the numeric id from '
      + 'search_venues.',
    inputSchema: {
      type: 'object',
      properties: {
        city: { type: 'string', description: 'City key the venue belongs to.' },
        id: { type: 'number', description: 'Numeric venue id from search_venues.' },
      },
      required: ['city', 'id'],
    },
    execute: function (input, ctx) {
      var i = input || {};
      return rpc('get_venue', clean({ city: i.city, id: num(i.id) }), ctx && ctx.signal)
        .then(function (d) { return out(d); });
    },
  });

  /* ── 3. find_open_tonight ─────────────────────────────────────────────── */
  MC.registerTool({
    name: 'find_open_tonight',
    description:
      'Find venues worth going to TONIGHT in a city — the ones with a happy hour or a '
      + 'late kitchen, best score first. This is the same definition the site\'s own '
      + '"tonight" strip uses, so the agent and the page agree.',
    inputSchema: {
      type: 'object',
      properties: {
        city: { type: 'string', description: 'City key, e.g. dallas.' },
        query: { type: 'string', description: 'Optional single keyword to narrow the candidates.' },
        limit: { type: 'number', description: 'How many to return. Default 5, capped at ' + MAX_RESULTS + '.' },
      },
      required: ['city'],
    },
    execute: function (input, ctx) {
      var i = input || {};
      var want = Math.min(num(i.limit) || 5, MAX_RESULTS);
      var signal = ctx && ctx.signal;
      /* ⚠️ search_venues DOES NOT RETURN `hours` — only get_venue does. Filtering
         on the search rows therefore tested a field that was never there and
         returned an empty list for every city, forever, in a sentence that read
         like a real answer. So: rank by score with one search, then read the top
         CANDIDATES individually. That is the "client-side over get_venue hours,
         top N candidates only" shape, and the N exists because it costs one
         request each. */
      var CANDIDATES = Math.min(Math.max(want * 3, 9), 15);
      return rpc('search_venues', clean({
        city: i.city, query: i.query, limit: CANDIDATES,
      }), signal).then(function (d) {
        var rows = (d && d.venues) || [];
        return Promise.all(rows.map(function (r) {
          return rpc('get_venue', { city: i.city, id: r.id }, signal)
            .then(function (g) { var v = (g && (g.venue || g)) || {}; v.id = v.id || r.id; return v; })
            .catch(function () { return null; });          // one unreadable venue must not empty the night
        }));
      }).then(function (full) {
        var rows = full.filter(Boolean);
        var open = rows.filter(openTonight).slice(0, want);
        return out({
          city: i.city,
          definition: 'happy hour or a late close, food-and-drink venues only — the /tonight rule',
          candidates_considered: rows.length,
          open_tonight: open.length,
          venues: open.map(function (v) {
            return {
              id: v.id, name: v.name, cuisine: v.cuisine, neighborhood: v.neighborhood,
              score: v.score, hours: v.hours || null,
              happy_hour: (v.hh !== undefined ? v.hh : v.happy_hour) || null,
              why: hasHappyHour(v) ? 'happy hour' : 'late close',
            };
          }),
          note: open.length ? undefined
            : 'None of the top candidates advertise a happy hour or a late close. That is a gap in our hours data as often as it is the truth about the city — say so rather than reporting the city as shut.',
        });
      });
    },
  });

  /* ── 4. build_itinerary ───────────────────────────────────────────────── */
  MC.registerTool({
    name: 'build_itinerary',
    description:
      'Draft a night out in one city as an ordered list of stops, each with why it is '
      + 'there and how to book it. READ-ONLY: this returns a plan, it does not save '
      + 'anything. To keep it, the user saves it themselves at /trip.html.',
    inputSchema: {
      type: 'object',
      properties: {
        city: { type: 'string', description: 'City key, e.g. dallas.' },
        stops: {
          type: 'array',
          description: 'Ordered venue ids from search_venues. 2-5 works best.',
          items: { type: 'number' },
        },
        occasion: { type: 'string', description: 'Optional, e.g. "anniversary", "first date".' },
      },
      required: ['city', 'stops'],
    },
    execute: function (input, ctx) {
      var i = input || {};
      var signal = ctx && ctx.signal;
      var ids = (Array.isArray(i.stops) ? i.stops : []).map(num).filter(function (n) { return n !== undefined; });
      if (!ids.length) return Promise.resolve(out({ error: 'build_itinerary needs at least one venue id in `stops`. Use search_venues first.' }));
      return Promise.all(ids.map(function (id) {
        return rpc('get_venue', { city: i.city, id: id }, signal)
          .then(function (d) { return d && (d.venue || d); })
          /* One unreadable stop must not lose the other four. The failure is
             carried INTO the plan so the agent can say which stop it could not
             read, instead of silently returning a shorter night. */
          .catch(function (e) { return { id: id, unavailable: String(e && e.message || e) }; });
      })).then(function (venues) {
        return out({
          city: i.city,
          occasion: i.occasion || undefined,
          saved: false,
          how_to_save: 'This is a draft. Open https://dimhour.com/trip.html to save it — Dim Hour never saves a trip on an agent\'s behalf.',
          stops: venues.map(function (v, n) {
            if (v && v.unavailable) return { stop: n + 1, id: v.id, unavailable: v.unavailable };
            return {
              stop: n + 1,
              id: v.id, name: v.name,
              why: [v.cuisine, v.neighborhood, v.score ? 'Dim Hour ' + v.score : null, v.awards || null]
                .filter(Boolean).join(' · '),
              hours: v.hours || null,
              booking: v.reserveUrl || null,
              platform: v.reservation || null,
            };
          }),
        });
      });
    },
  });

  /* ── 5. get_booking_link ──────────────────────────────────────────────────
   *
   * ⚠️ THIS ONE IS NOT A THIN ADAPTER, AND IT CANNOT BE. The MCP server carries
   * NO booking URL — deliberately. Its own venue-card resource says so: it names
   * the reservation PLATFORM as text and promises nothing clickable, because a
   * host that advertised a booking link the server could not produce would be
   * advertising an action it cannot perform. That decision is not mine to
   * reverse from a browser script.
   *
   * So the link is read from the page's OWN catalog when it is there. index.html
   * loads exactly one city's *-data.js at a time, so `reserveUrl` is available
   * for the city the user is actually looking at and for no other. Both answers
   * are honest and neither invents a URL:
   *   · city loaded  -> the real reserveUrl, from the same catalog row the page's
   *                     own Book button uses
   *   · not loaded   -> the platform by name plus the Dim Hour venue page, where
   *                     that button lives
   */
  var CITY_GLOBALS = { dallas: 'DALLAS_DATA', nyc: 'NYC_DATA', austin: 'AUSTIN_DATA',
    houston: 'HOUSTON_DATA', chicago: 'CHICAGO_DATA', la: 'LA_DATA', miami: 'MIAMI_DATA',
    sf: 'SF_DATA', seattle: 'SEATTLE_DATA', vegas: 'LV_DATA', phoenix: 'PHX_DATA',
    dc: 'DC_DATA', toronto: 'TORONTO_DATA', nashville: 'NASHVILLE_DATA', slc: 'SLC_DATA',
    charlotte: 'CHARLOTTE_DATA', sandiego: 'SD_DATA', sanantonio: 'SANANTONIO_DATA',
    neworleans: 'NEWORLEANS_DATA', mexicocity: 'MEXICOCITY_DATA', portland: 'PORTLAND_DATA',
    newmexico: 'NM_DATA' };

  /** The catalog row for city/id, if this page happens to have that city loaded. */
  function localRow(city, id) {
    try {
      var g = CITY_GLOBALS[String(city || '').toLowerCase()];
      var arr = g && typeof window !== 'undefined' && window[g];
      if (!Array.isArray(arr)) return null;
      for (var i = 0; i < arr.length; i++) if (Number(arr[i].id) === Number(id)) return arr[i];
      return null;
    } catch (e) { return null; }
  }

  MC.registerTool({
    name: 'get_booking_link',
    description:
      'Get the reservation platform (Resy, OpenTable, SevenRooms, Tock, walk-in) and, '
      + 'where available, the direct booking URL for one venue — so you can present it '
      + 'to the user. Returns the link; it does not open it and it never books anything.',
    inputSchema: {
      type: 'object',
      properties: {
        city: { type: 'string' },
        id: { type: 'number', description: 'Numeric venue id from search_venues.' },
      },
      required: ['city', 'id'],
    },
    execute: function (input, ctx) {
      var i = input || {};
      var id = num(i.id);
      return rpc('get_venue', clean({ city: i.city, id: id }), ctx && ctx.signal)
        .then(function (d) {
          var v = (d && (d.venue || d)) || {};
          var local = localRow(i.city, id);
          var url = local && local.reserveUrl ? local.reserveUrl : null;
          var platform = (local && local.reservation) || v.reservation || null;
          return out({
            id: v.id || id,
            name: v.name || (local && local.name) || null,
            platform: platform,
            booking_url: url,
            bookable_online: !!url,
            venue_page: v.url || null,
            phone: v.phone || (local && local.phone) || null,
            /* An empty booking link is a real and common answer — plenty of good
               rooms are walk-in only, and plenty more we simply have no link for.
               Each note says which of those it is rather than blurring them. */
            note: url
              ? 'Present this link to the user. Dim Hour does not book on anyone\'s behalf.'
              : (platform && platform !== 'Walk-ins only'
                  ? 'This venue books via ' + platform + ', but the direct link is not available to this tool from here — send the user to the Dim Hour venue page above, where the Book button is. Do not construct a booking URL.'
                  : 'No online booking on file — it may be walk-in only. Do not invent a reservation link.'),
          });
        });
    },
  });
})();
