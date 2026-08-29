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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Identify the tool, so the site's operator sees what this traffic is and can
// ask us to stop, rather than just seeing an anonymous scraper.
const USER_AGENT =
  'werewolf-log-search/1.0 (fan-made log analyser; https://github.com/andorole/werewolf-log-search)';
// zinro.net is volunteer-run and will start serving pages without the message
// block if pushed. Space requests out and back off rather than racing.
const REQUEST_SPACING_MS = 120;

async function fetchLogMessages(id, attempts = 3) {
  let lastErr = null;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const res = await fetch(LOG_BASE + id, {
        headers: { 'User-Agent': USER_AGENT },
        signal: AbortSignal.timeout(20000),
      });
      const html = await res.text();
      const m = html.match(/var message = (\[.*?\]);/s);
      if (m) {
        const arr = JSON.parse(m[1]);
        arr.sort((a, b) => (a.created < b.created ? -1 : a.created > b.created ? 1 : 0));
        return arr;
      }
      lastErr = new Error('no message block (http ' + res.status + ', ' + html.length + ' bytes)');
    } catch (e) {
      lastErr = e;
    }
    if (attempt < attempts) await sleep(500 * attempt * attempt);
  }
  throw lastErr || new Error('failed');
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

const normTrip = (t) => String(t || '').replace(/^[◆◇]/, '');
// Identity is the trip when there is one, because display names are shared far
// more than you would guess: "嵐" alone was 59 different trips across 121 games.
// Aggregating by name merges unrelated people, which for a kick statistic means
// blaming the wrong person. Names stay in the key so a tripless player is still
// distinct from a tripped one.
const identityKey = (name, trip) => name + '\u0000' + normTrip(trip);

function getPlayer(players, name, trip) {
  const key = identityKey(name, trip);
  if (!players.has(key)) {
    players.set(key, {
      name,
      trip: normTrip(trip),
      gamesPlayed: 0,
      kicked: 0,
      kickedLogs: [],
      spamMessages: 0,
      noisyMessages: 0,
      keywordMessages: 0,
    });
  }
  return players.get(key);
}

// Reduce one log to just the facts the report needs. This is what gets cached,
// so a log is only ever downloaded once no matter how many reports include it.
function deriveLogFacts(roster, msgs) {
  const facts = { roster: [], kicks: [], speakers: {} };

  if (Array.isArray(roster) && roster.length) {
    for (const p of roster) {
      if (p && p.name && p.job !== '観戦者' && !SYSTEM_NAMES.has(p.name)) {
        facts.roster.push([p.name, normTrip(p.trip)]);
      }
    }
  } else {
    // --ids runs have no API roster; fall back to speakers, trip unknown.
    const seen = new Set();
    for (const m of msgs) {
      if (m.from_user === '鯖' || SYSTEM_NAMES.has(m.from_user)) continue;
      if (m.job && m.job !== '観戦者' && !seen.has(m.from_user)) {
        seen.add(m.from_user);
        facts.roster.push([m.from_user, '']);
      }
    }
  }

  const lastMsgByUser = new Map();
  const kicked = new Set();
  for (const m of msgs) {
    if (m.from_user === '鯖') {
      const km = KICK_RE.exec((m.message || '').trim());
      // The server can repeat the announcement; one kick per player per log.
      if (km && !kicked.has(km[1]) && !SYSTEM_NAMES.has(km[1])) {
        kicked.add(km[1]);
        facts.kicks.push(km[1]);
      }
      continue;
    }
    if (m.to_user !== 'ALL') continue; // public chat only
    if (SYSTEM_NAMES.has(m.from_user)) continue;
    const text = (m.message || '').trim();
    const s = facts.speakers[m.from_user] || (facts.speakers[m.from_user] = [0, 0, 0]);
    const prev = lastMsgByUser.get(m.from_user);
    if (prev && prev === text && text.length > 0) s[0]++; // spam
    if (isSymbolFlood(text)) s[1]++;                      // symbol flood
    if (TROLL_KEYWORDS.some((k) => text.includes(k))) s[2]++;
    lastMsgByUser.set(m.from_user, text);
  }
  // Most players trip none of these; dropping their all-zero rows keeps the
  // cache file small.
  for (const [k, v] of Object.entries(facts.speakers)) {
    if (!v[0] && !v[1] && !v[2]) delete facts.speakers[k];
  }
  return facts;
}

const CACHE_VERSION = 1;

async function loadCache(file) {
  if (!file) return null;
  const fs = await import('node:fs');
  try {
    const c = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (c && c.version === CACHE_VERSION && c.logs) return c;
    console.error('cache present but not version ' + CACHE_VERSION + '; starting fresh');
  } catch (e) { /* no cache yet */ }
  return { version: CACHE_VERSION, logs: {} };
}

async function saveCache(file, cache) {
  if (!file || !cache) return;
  const fs = await import('node:fs');
  const path = await import('node:path');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(cache));
}

async function run() {
  const args = parseArgs(process.argv.slice(2));
  const concurrency = Number(args.concurrency || 4);

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

  const players = new Map(); // keyed by name+trip — see identityKey
  const cache = await loadCache(args.cache);
  const analyzed = [];
  let idx = 0;
  let fromCache = 0;
  let downloaded = 0;

  async function worker() {
    while (idx < entries.length) {
      const e = entries[idx++];
      const cached = cache && cache.logs[e.id];
      if (cached) {
        analyzed.push({ id: e.id, facts: cached });
        fromCache++;
        continue; // the whole point: no request at all for a log we've seen
      }
      try {
        const msgs = await fetchLogMessages(e.id);
        const facts = deriveLogFacts(e.players, msgs);
        if (cache) cache.logs[e.id] = facts;
        analyzed.push({ id: e.id, facts });
        downloaded++;
      } catch (err) {
        console.error(`log ${e.id} failed: ${err.message}`);
      }
      await sleep(REQUEST_SPACING_MS);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  console.error(
    `analyzed ${analyzed.length}/${entries.length} logs` +
    (cache ? ` (${downloaded} downloaded, ${fromCache} from cache)` : '')
  );
  await saveCache(args.cache, cache);

  // Kick announcements carry only a name, and being kicked removes you from the
  // game — so 20 of 25 sampled kicks named someone absent from that log's
  // roster, and the log page has no trip anywhere. Recover the trip by looking
  // the name up across every roster we analysed: if the name belongs to exactly
  // one trip in this data set, the attribution is unambiguous.
  const tripsByName = new Map();
  for (const { facts } of analyzed) {
    for (const [name, trip] of facts.roster) {
      if (!trip) continue;
      if (!tripsByName.has(name)) tripsByName.set(name, new Set());
      tripsByName.get(name).add(trip);
    }
  }

  let ambiguousKicks = 0;
  for (const { id, facts } of analyzed) {
    // Names are unique within a single log — checked across 248 logs / 1440
    // player rows, zero duplicates — so a name present in the roster resolves
    // to exactly one person.
    const tripOf = new Map(facts.roster.map(([n, t]) => [n, t]));

    for (const [name, trip] of facts.roster) {
      getPlayer(players, name, trip).gamesPlayed++;
    }

    for (const name of facts.kicks) {
      let trip = tripOf.get(name);
      let countsAsGame = false;
      if (trip === undefined) {
        const candidates = tripsByName.get(name);
        if (candidates && candidates.size === 1) {
          trip = [...candidates][0]; // unique across the data set
        } else {
          trip = '';                 // genuinely ambiguous, or never seen with a trip
          ambiguousKicks++;
        }
        // They were removed from the roster, so this game is not counted yet.
        countsAsGame = true;
      }
      const p = getPlayer(players, name, trip);
      if (countsAsGame) p.gamesPlayed++;
      p.kicked++;
      p.kickedLogs.push(id);
    }

    for (const [name, [spam, noisy, keyword]] of Object.entries(facts.speakers)) {
      // A speaker with no roster entry was in the lobby but not in the game.
      const trip = tripOf.get(name);
      if (trip === undefined) continue;
      const p = getPlayer(players, name, trip);
      p.spamMessages += spam;
      p.noisyMessages += noisy;
      p.keywordMessages += keyword;
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
      trip: p.trip,
      // How many different trips were seen using this display name. >1 means the
      // name alone does not identify a person, so a tripless row under it may be
      // mixing people together.
      nameTrips: (tripsByName.get(p.name) || new Set()).size,
      games: p.gamesPlayed,
      kicked: p.kicked,
      kickRate: p.gamesPlayed ? Number(((p.kicked / p.gamesPlayed) * 100).toFixed(1)) : 0,
      spam: p.spamMessages,
      noisy: p.noisyMessages,
      keyword: p.keywordMessages,
    }));

  const rows = allRows.filter((r) => r.games >= minGames).sort(SORTS[sortKey]);

  const top = Number(args.top || 30);
  console.log('\n※ 同一人物の判定はトリップで行っています（トリップ無しの人は名前のみ）。');
  if (ambiguousKicks) {
    console.log(`※ 名簿に載る前に追放された ${ambiguousKicks} 件は、トリップを特定できていません。`);
  }
  console.log(`※ 並び=${sortKey} / 最低参加数=${minGames} / 対象 ${rows.length}人（全${allRows.length}人）\n`);
  console.table(
    rows.slice(0, top).map((r) => ({
      name: r.name,
      trip: r.trip || '(なし)',
      games: r.games,
      kicked: r.kicked,
      kickRate: r.kickRate + '%',
      spam: r.spam,
      noisy: r.noisy,
      keyword: r.keyword,
    }))
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
      ambiguousKicks,
      logsMatched: matchedCount,
      logsAnalyzed: analyzed.length,
      logsFromCache: fromCache,
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
