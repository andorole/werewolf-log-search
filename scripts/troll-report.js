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

const API_BASE = 'https://ss1.xrea.com/zinrostats.s205.xrea.com/log_search';
const LOG_BASE = 'https://zinro.net/m/log.php?id=';

const KICK_RE = /^(.+?)さんを村から追放しました$/;
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
        fetched.push({ id: e.id, room: e.room_name, msgs });
      } catch (err) {
        console.error(`log ${e.id} failed: ${err.message}`);
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  console.error(`fetched ${fetched.length}/${entries.length} logs`);

  for (const { id, msgs } of fetched) {
    const participants = new Set();
    for (const m of msgs) if (m.job && m.job !== '観戦者' && m.from_user !== '鯖') participants.add(m.from_user);
    for (const name of participants) getPlayer(players, name).gamesPlayed++;

    const lastMsgByUser = new Map();
    for (const m of msgs) {
      if (m.from_user === '鯖') {
        const km = KICK_RE.exec((m.message || '').trim());
        if (km) {
          const p = getPlayer(players, km[1]);
          p.kicked++;
          p.kickedLogs.push(id);
        }
        continue;
      }
      if (m.to_user !== 'ALL') continue; // public chat only
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

  const rows = [...players.values()]
    .filter((p) => p.gamesPlayed > 0)
    .map((p) => ({
      name: p.name,
      games: p.gamesPlayed,
      kicked: p.kicked,
      kickRate: p.gamesPlayed ? Number(((p.kicked / p.gamesPlayed) * 100).toFixed(1)) : 0,
      spam: p.spamMessages,
      noisy: p.noisyMessages,
      keyword: p.keywordMessages,
    }))
    .sort((a, b) => b.kicked - a.kicked || b.spam - a.spam || b.noisy - a.noisy);

  const top = Number(args.top || 30);
  console.log('\n※ 追放は名前のみで名寄せしているため、同名の別人が混ざる可能性があります。\n');
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
      logsMatched: matchedCount,
      logsAnalyzed: fetched.length,
      players: rows.slice(0, top),
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
