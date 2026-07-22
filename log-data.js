function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(20260721);
const pick = (arr) => arr[Math.floor(rand() * arr.length)];
const randInt = (min, max) => min + Math.floor(rand() * (max - min + 1));
const pad = (n) => (n < 10 ? '0' + n : '' + n);
const randTrip = () => {
  const cs = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  for (let i = 0; i < 6; i++) s += cs[Math.floor(rand() * cs.length)];
  return s;
};

const MODES = ['通常', 'ワンナイト', 'ワードウルフ'];
const FACTIONS = ['村人陣営', '人狼陣営', '妖狐陣営', '多数派陣営', '少数派陣営'];
const ROLES = ['村人', '占い師', '霊媒師', '狩人', '共有者', '猫又', 'パン屋', '役人', '人狼', '狂人', '妖狐', '背徳者', '多数派', '少数派'];

const ROLE_STD = ['村人', '占い師', '霊媒師', '狩人', '共有者', '猫又', 'パン屋', '役人', '人狼', '狂人', '妖狐', '背徳者'];
const ROLE_WW = ['多数派', '少数派'];
const ROLE_FACTION = {
  村人: '村人陣営', 占い師: '村人陣営', 霊媒師: '村人陣営', 狩人: '村人陣営', 共有者: '村人陣営', 猫又: '村人陣営', パン屋: '村人陣営', 役人: '村人陣営',
  人狼: '人狼陣営', 狂人: '人狼陣営',
  妖狐: '妖狐陣営', 背徳者: '妖狐陣営',
  多数派: '多数派陣営', 少数派: '少数派陣営',
};

const RECURRING = [
  { name: 'しろ', trip: 'Sr0w9k' },
  { name: '月見', trip: 'Tk2m8p' },
  { name: '灯', trip: 'AkR5qz' },
  { name: 'kuro', trip: 'Kr9xLm' },
  { name: 'ナナシ', trip: 'Nn4vBq' },
  { name: '白湯', trip: 'Yz7Wpa' },
  { name: 'rin', trip: 'Rn3jXe' },
  { name: 'あおい', trip: 'Ao8Ktn' },
];
const FILLER_NAMES = ['たぬき', 'こねこ', 'yuki', 'midori', 'はち', 'ろん', 'sara', 'つき', 'kaede', 'はる', '冬子', 'あかね', 'える', 'hiro', 'すず', 'yamane', 'ao', 'べに', '梅', 'one', 'つばき', 'red', 'naco', 'shiba', 'ゆず', 'てん', 'くも', 'sumi', '萌', 'ren'];
const VILLAGE_WORDS = ['深緑', '月光', '常夜', '白銀', '黄昏', '紅葉', '霧', '星空', '桜', '雪解', '朝霧', '夜長', '群青', '早苗', '菖蒲', '狐火', '薄明', '蜃気楼', '蒼月', '残雪'];

function weightedMode() {
  const r = rand();
  return r < 0.68 ? '通常' : r < 0.88 ? 'ワンナイト' : 'ワードウルフ';
}

function randomDate() {
  const daysAgo = randInt(0, 330);
  const base = new Date(2026, 6, 21, 20, 0);
  const d = new Date(base.getTime() - daysAgo * 86400000);
  d.setHours(randInt(20, 23), pick([0, 10, 15, 20, 30, 40, 45, 50]), 0, 0);
  const iso = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const label = `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return { iso, label };
}

function buildRoster(mode, size) {
  const pool = mode === 'ワードウルフ' ? ROLE_WW : ROLE_STD;
  const roles = [];
  if (mode !== 'ワードウルフ') {
    roles.push('人狼');
    if (size > 3) roles.push('占い師');
  }
  while (roles.length < size) roles.push(pick(pool));
  for (let i = roles.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [roles[i], roles[j]] = [roles[j], roles[i]];
  }
  const used = new Set();
  const players = [];
  for (let i = 0; i < size; i++) {
    let identity = null;
    if (rand() < 0.4) {
      const candidates = RECURRING.filter((r) => !used.has(r.name));
      if (candidates.length) identity = pick(candidates);
    }
    if (!identity) {
      const base = pick(FILLER_NAMES);
      identity = { name: rand() < 0.3 ? base + randInt(1, 99) : base, trip: randTrip() };
    }
    used.add(identity.name);
    const role = roles[i];
    players.push({ name: identity.name, trip: identity.trip, role, faction: ROLE_FACTION[role] });
  }
  return players;
}

function finalizeOutcome(players) {
  const factions = Array.from(new Set(players.map((p) => p.faction)));
  let winner;
  if (factions.includes('村人陣営')) {
    winner = rand() < 0.55 ? '村人陣営' : pick(factions.filter((f) => f !== '村人陣営')) || '村人陣営';
  } else {
    winner = pick(factions);
  }
  players.forEach((p) => { p.result = p.faction === winner ? 'win' : 'lose'; });
  return `${winner}勝利`;
}

const COUNT = 72;
const villages = [];
for (let i = 0; i < COUNT; i++) {
  const mode = weightedMode();
  const size = mode === '通常' ? randInt(9, 15) : mode === 'ワンナイト' ? randInt(5, 9) : randInt(4, 8);
  const players = buildRoster(mode, size);
  const outcome = finalizeOutcome(players);
  const { iso, label } = randomDate();
  const messageCount = mode === '通常' ? randInt(420, 1450) : mode === 'ワンナイト' ? randInt(70, 320) : randInt(140, 520);
  villages.push({
    id: 'v' + (1000 + i),
    name: `${pick(VILLAGE_WORDS)}村 #${randInt(120, 9999)}`,
    mode,
    date: iso,
    dateLabel: label,
    logUrl: `https://zinro.net/m/log.php?id=${randInt(100000, 999999)}`,
    messageCount,
    totalPlayers: size,
    outcome,
    hadTimeoutDeath: rand() < 0.14,
    players,
  });
}
villages.sort((a, b) => b.date.localeCompare(a.date));

window.WEREWOLF_SAMPLE_LOGS = villages;
