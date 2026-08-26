#!/usr/bin/env node
// Fetches real village logs (search API + per-log message text) and reports
// players who are frequently kicked ("追放"), post spammy repeated messages,
// or post text dominated by unusual symbols. Run on demand (option "B" — no
// hosting/CORS workaround needed since this runs server-side via Node).
//
// Usage examples:
//   node scripts/troll-report.js --name しろ
//   node scripts/troll-report.js --trip Sr0w9k
//   node scripts/troll-report.js --room 村 --sdate 2026-07-10 --edate 2026-07-23 --limit 200
//   node scripts/troll-report.js --ids 1425497,1425322
//   node scripts/troll-report.js --name しろ --json reports/latest.json
//
// SCOPE LIMIT — please keep this.
// Always drive this from a search-API query (--name / --trip / --room), so the
// number of log pages fetched stays at what one player or one village actually
// produced (~120 logs for an active player). Do NOT add a mode that enumerates
// log ids to cover "everyone", and do not assume a short date range makes that
// safe — one day is already ~400 log pages. A sweep like that was tried once:
// ~1,150 fetches in a few minutes, after which zinro.net refused most requests
// and the operator's own access to the site degraded. It is a volunteer-run
// service. If a feature seems to need full coverage, treat that as a reason to
// say no, not as a reason to sweep; any such work would need a cache that never
// re-fetches a log before it could even be considered.

const API_BASE = 'https://ss1.xrea.com/zinrostats.s205.xrea.com/log_search';
const LOG_BASE = 'https://zinro.net/m/log.php?id=';

const KICK_RE = /^(.+?)さんを村から追放しました$/;
// Not real people: 鯖 is the server's announcer, 初日犠牲者 is the placeholder the
// game fills the first-night victim slot with. Both would otherwise show up in
// the rankings with a game count.
const SYSTEM_NAMES = new Set(['鯖', '初日犠牲者']);
const TROLL_KEYWORDS = ['荒らし', 'キック', '蹴り'];

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const key = argv[i].slice(2);
      const val = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
      args[key] = val;
    }
  }
  return args;
}

async function searchLogs(params) {
  const url = new URL(API_BASE);
  for (const [k, v] of Object.entries(params)) if (v) url.searchParams.set(k, v);
  const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
  const json = await res.json();
  if (json.error) throw new Error('search API error: ' + json.error);
  return json.log_data || [];
}

async function fetchLogMessages(id) {
  const res = await fetch(LOG_BASE + id, { signal: AbortSignal.timeout(15000) });
  const html = await res.text();
  const m = html.match(/var message = (\[.*?\]);/s);
  if (!m) return [];
  const arr = JSON.parse(m[1]);
  arr.sort((a, b) => (a.created < b.created ? -1 : a.created > b.created ? 1 : 0));
  return arr;
}

// Flags messages dominated by long runs of a single repeated character (e.g.
// flooding with the same symbol dozens/hundreds of times). Short casual
// expressions like "ｗｗｗｗｗｗ" or normal kaomoji are intentionally left alone —
// only long messages that are *mostly* one repeated run count as noisy.
function isSymbolFlood(text) {
  if (!text || text.length < 15) return false;
  const runs = text.match(/(.)\1{4,}/g); // 5+ consecutive identical characters
  if (!runs) return false;
  const covered = runs.reduce((sum, r) => sum + r.length, 0);
  return covered / text.length > 0.5;
}

function getPlayer(players, name) {
  if (!players.has(name)) {
    players.set(name, {
      name,
      gamesPlayed: 0,
      kicked: 0,
      kickedLogs: [],
      spamMessages: 0,
      noisyMessages: 0,
      keywordMessages: 0,
      keywordLogs: new Set(),
    });
  }
  return players.get(name);
}

async function run() {
  const args = parseArgs(process.argv.slice(2));
  const concurrency = Number(args.concurrency || 8);

  let entries;
  let matchedCount;
  if (args.ids) {
    entries = String(args.ids).split(',').map((s) => s.trim()).filter(Boolean).map((id) => ({ id }));
    matchedCount = entries.length;
  } else {
    const params = {};
    if (args.name) params.name = args.name;
    if (args.trip) params.trip = args.trip;
    if (args.room) params.room_name = args.room;
    if (args.sdate) params.s_date = args.sdate + ' 00:00:00';
    if (args.edate) params.e_date = args.edate + ' 23:59:59';
    if (!params.name && !params.trip && !params.room_name) {
      console.error('Need one of: --name, --trip, --room, or --ids');
      process.exit(1);
    }
    entries = await searchLogs(params);
    matchedCount = entries.length;
    console.error(`search matched ${entries.length} logs`);
  }

  const limit = args.limit ? Number(args.limit) : entries.length;
  entries = entries.slice(0, limit);

  const players = new Map(); // keyed by display name only (kick messages carry no trip)
  const fetched = [];
  let idx = 0;

  async function worker() {
    while (idx < entries.length) {
      const e = entries[idx++];
      try {
        const msgs = await fetchLogMessages(e.id);
        fetched.push({ id: e.id, room: e.room_name, players: e.players, msgs });
      } catch (err) {
        console.error(`log ${e.id} failed: ${err.message}`);
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  console.error(`fetched ${fetched.length}/${entries.length} logs`);

  for (const { id, players: roster, msgs } of fetched) {
    // Who actually played this game. The search API hands us the real roster, so
    // use it: a log page also carries lobby chat from people who never ended up
    // in the game, and counting speakers instead badly overcounts — across ten
    // sampled logs that was 221 "participants" against a true roster of 103,
    // including a 4-player game credited to 31 people. Inflated denominators
    // would quietly depress everyone's kick rate.
    const participants = new Set();
    if (Array.isArray(roster) && roster.length) {
      for (const p of roster) {
        if (p && p.name && p.job !== '観戦者' && !SYSTEM_NAMES.has(p.name)) participants.add(p.name);
      }
    } else {
      // --ids runs have no API roster; fall back to speakers.
      for (const m of msgs) {
        if (m.from_user === '鯖') continue;
        if (m.job && m.job !== '観戦者' && !SYSTEM_NAMES.has(m.from_user)) participants.add(m.from_user);
      }
    }
    // A kicked player is removed from the game and so can be missing from the
    // roster; without this their kick would have no game to divide by.
    for (const m of msgs) {
      if (m.from_user !== '鯖') continue;
      const km = KICK_RE.exec((m.message || '').trim());
      if (km && !SYSTEM_NAMES.has(km[1])) participants.add(km[1]);
    }
    for (const name of participants) getPlayer(players, name).gamesPlayed++;

    const lastMsgByUser = new Map();
    const kickedThisLog = new Set();
    for (const m of msgs) {
      if (m.from_user === '鯖') {
        const km = KICK_RE.exec((m.message || '').trim());
        // The server can repeat the announcement; count one kick per player per log
        // so kicked can never exceed gamesPlayed.
        if (km && !kickedThisLog.has(km[1]) && !SYSTEM_NAMES.has(km[1])) {
          kickedThisLog.add(km[1]);
          const p = getPlayer(players, km[1]);
          p.kicked++;
          p.kickedLogs.push(id);
        }
        continue;
      }
      if (m.to_user !== 'ALL') continue; // public chat only
      if (SYSTEM_NAMES.has(m.from_user)) continue;
      const text = (m.message || '').trim();
      const p = getPlayer(players, m.from_user);

      if (TROLL_KEYWORDS.some((k) => text.includes(k))) {
        p.keywordMessages++;
        p.keywordLogs.add(id);
      }
      if (isSymbolFlood(text)) p.noisyMessages++;

      const prev = lastMsgByUser.get(m.from_user);
      if (prev && prev === text && text.length > 0) p.spamMessages++;
      lastMsgByUser.set(m.from_user, text);
    }
  }

  // Everything below is pure post-processing of what we already fetched —
  // no extra requests to zinro.net.
  const SORTS = {
    kicked: (a, b) => b.kicked - a.kicked || b.kickRate - a.kickRate || b.games - a.games,
    rate: (a, b) => b.kickRate - a.kickRate || b.kicked - a.kicked || b.games - a.games,
    spam: (a, b) => b.spam - a.spam || b.kicked - a.kicked,
    noisy: (a, b) => b.noisy - a.noisy || b.kicked - a.kicked,
    keyword: (a, b) => b.keyword - a.keyword || b.kicked - a.kicked,
    games: (a, b) => b.games - a.games || b.kicked - a.kicked,
  };
  const sortKey = SORTS[args.sort] ? String(args.sort) : 'kicked';
  // One game, one kick reads as "100%" and buries the real repeat offenders,
  // so allow raising the floor.
  const minGames = Number(args['min-games'] || 1);

  const allRows = [...players.values()]
    .filter((p) => p.gamesPlayed > 0)
    .map((p) => ({
      name: p.name,
      games: p.gamesPlayed,
      kicked: p.kicked,
      kickRate: p.gamesPlayed ? Number(((p.kicked / p.gamesPlayed) * 100).toFixed(1)) : 0,
      spam: p.spamMessages,
      noisy: p.noisyMessages,
      keyword: p.keywordMessages,
    }));

  const rows = allRows.filter((r) => r.games >= minGames).sort(SORTS[sortKey]);

  const top = Number(args.top || 30);
  console.log('\n※ 追放は名前のみで名寄せしているため、同名の別人が混ざる可能性があります。');
  console.log(`※ 並び=${sortKey} / 最低参加数=${minGames} / 対象 ${rows.length}人（全${allRows.length}人）\n`);
  console.table(
    rows.slice(0, top).map((r) => ({ ...r, kickRate: r.kickRate + '%' }))
  );

  if (args.json) {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const report = {
      version: 1,
      generatedAt: new Date().toISOString(),
      query: {
        name: args.name || '',
        trip: args.trip || '',
        room: args.room || '',
        sdate: args.sdate || '',
        edate: args.edate || '',
        ids: args.ids || '',
      },
      sortedBy: sortKey,
      minGames,
      logsMatched: matchedCount,
      logsAnalyzed: fetched.length,
      // The site re-sorts and filters this list in the browser, so publish a
      // generous slice rather than only the console's top-N. Costs no extra
      // requests — these rows are already computed.
      players: rows.slice(0, Number(args['json-top'] || 300)),
    };
    fs.mkdirSync(path.dirname(args.json), { recursive: true });
    fs.writeFileSync(args.json, JSON.stringify(report, null, 2));
    console.error(`wrote ${args.json}`);
  }
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
