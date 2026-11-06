const express = require('express');
const path = require('path');
const admin = require('firebase-admin');

if (!process.env.FIREBASE_SERVICE_ACCOUNT) {
  console.error('FIREBASE_SERVICE_ACCOUNT yoxdur');
  process.exit(1);
}

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: process.env.FIREBASE_DB_URL || 'https://lotoaze-cd37c-default-rtdb.firebaseio.com'
});

const db = admin.database();
const app = express();
app.use(express.json({ limit: '16kb' }));
app.use(express.static(path.join(__dirname, 'public')));

const TABLES = [
  { id: 't020', price: 0.20 },
  { id: 't050', price: 0.50 },
  { id: 't1',   price: 1.00 },
  { id: 't3',   price: 3.00 },
  { id: 't5',   price: 5.00 },
  { id: 't20',  price: 20.00 }
];

const BOT_NAMES = [
  'Anar','Elvin','Rəşad','Kamran','Nigar','Leyla','Orxan','Emin','Günel','Tural',
  'Aysel','Samir','Fərid','İlqar','Nərmin','Rəvan','Aylin','Nicat','Elnur','Sevinc',
  'Cavid','Turan','Aygün','Elçin','Zaur','Səbinə','Ülvi','Rüfət','Ləman','Şəhriyar',
  'Emil','Xəyal','Aynur','Ramin','Sabir','Fəridə','Nail','Təranə','Vüqar','Afaq'
];

const COL_RANGES = [
  [1,9],[10,19],[20,29],[30,39],[40,49],[50,59],[60,69],[70,79],[80,90]
];

const RATE = {};
function rateLimit(uid, action, ms) {
  const key = uid + ':' + action;
  const now = Date.now();
  if (RATE[key] && now - RATE[key] < ms) return false;
  RATE[key] = now;
  return true;
}

function round2(n) { return Math.round(n * 100) / 100; }

function generateCard() {
  while (true) {
    const counts = [1,1,1,1,1,1,1,1,1];
    let extra = 6;
    while (extra > 0) {
      const i = Math.floor(Math.random() * 9);
      if (counts[i] < 3) { counts[i]++; extra--; }
    }
    const cols = counts.map((cnt, i) => {
      const [mn, mx] = COL_RANGES[i];
      const s = new Set();
      while (s.size < cnt) s.add(mn + Math.floor(Math.random() * (mx - mn + 1)));
      return [...s].sort((a, b) => a - b);
    });
    const grid = [
      [null,null,null,null,null,null,null,null,null],
      [null,null,null,null,null,null,null,null,null],
      [null,null,null,null,null,null,null,null,null]
    ];
    let ok = true;
    cols.forEach((nums, col) => {
      const rows = [0,1,2].sort(() => Math.random() - 0.5).slice(0, nums.length).sort((a, b) => a - b);
      nums.forEach((num, i) => { grid[rows[i]][col] = num; });
    });
    for (const row of grid) if (row.filter(x => x !== null).length !== 5) ok = false;
    if (ok) return grid;
  }
}

function validateGrid(grid) {
  if (!Array.isArray(grid) || grid.length !== 3) return false;
  const colSeen = {};
  for (let r = 0; r < 3; r++) {
    if (!Array.isArray(grid[r]) || grid[r].length !== 9) return false;
    let rowCount = 0;
    for (let c = 0; c < 9; c++) {
      const n = grid[r][c];
      if (n === null) continue;
      if (typeof n !== 'number' || !Number.isInteger(n)) return false;
      const [mn, mx] = COL_RANGES[c];
      if (n < mn || n > mx) return false;
      if (!colSeen[c]) colSeen[c] = new Set();
      if (colSeen[c].has(n)) return false;
      colSeen[c].add(n);
      rowCount++;
    }
    if (rowCount !== 5) return false;
  }
  return true;
}

function countCards(d) {
  let real = 0, bot = 0;
  if (d.cards) for (const u in d.cards) real += Object.keys(d.cards[u] || {}).length;
  if (d.bots) for (const b in d.bots) bot += Object.keys(d.bots[b].cards || {}).length;
  return { real, bot, total: real + bot };
}

function authMw(req, res, next) {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'no_token' });
  admin.auth().verifyIdToken(token)
    .then(dec => { req.uid = dec.uid; next(); })
    .catch(() => res.status(401).json({ error: 'bad_token' }));
}

app.get('/health', (req, res) => res.json({ ok: true, ts: Date.now() }));

app.post('/api/init', authMw, async (req, res) => {
  try {
    const uRef = db.ref('users/' + req.uid);
    const snap = await uRef.once('value');
    if (!snap.exists()) {
      await uRef.set({
        name: 'O' + Math.floor(1000 + Math.random() * 9000),
        balance: 100,
        isBot: false,
        createdAt: Date.now()
      });
    }
    res.json({ ok: true });
  } catch (e) {
    console.error('init', e.message);
    res.status(500).json({ error: 'init_failed' });
  }
});

app.post('/api/join', authMw, async (req, res) => {
  try {
    const { tableId } = req.body || {};
    const t = TABLES.find(x => x.id === tableId);
    if (!t) return res.status(400).json({ error: 'bad_table' });

    const userSnap = await db.ref('users/' + req.uid).once('value');
    const user = userSnap.val();
    if (!user) return res.status(400).json({ error: 'no_user' });

    const tRef = db.ref('tables/' + tableId);
    const tSnap = await tRef.once('value');
    let d = tSnap.val();
    if (!d) {
      await tRef.set({
        price: t.price,
        status: 'waiting',
        createdAt: Date.now(),
        players: {},
        bots: {},
        cards: {},
        drawnNumbers: {},
        winners: {}
      });
      d = (await tRef.once('value')).val();
    }

    if (d.status === 'waiting') {
      await tRef.child('players/' + req.uid).update({
        name: user.name,
        isBot: false,
        joinedAt: Date.now()
      });
    }

    res.json({ ok: true, status: d.status });
  } catch (e) {
    console.error('join', e.message);
    res.status(500).json({ error: 'join_failed' });
  }
});

app.post('/api/buy-card', authMw, async (req, res) => {
  try {
    if (!rateLimit(req.uid, 'buy', 400)) return res.status(429).json({ error: 'too_fast' });
    const { tableId } = req.body || {};
    const t = TABLES.find(x => x.id === tableId);
    if (!t) return res.status(400).json({ error: 'bad_table' });

    const tRef = db.ref('tables/' + tableId);
    const tSnap = await tRef.once('value');
    const d = tSnap.val();
    if (!d) return res.status(400).json({ error: 'no_table' });
    if (d.status !== 'waiting') return res.status(400).json({ error: 'not_waiting' });

    const myCount = d.cards && d.cards[req.uid] ? Object.keys(d.cards[req.uid]).length : 0;
    if (myCount >= 6) return res.status(400).json({ error: 'max_cards' });

    const balResult = await db.ref('users/' + req.uid + '/balance').transaction(bal => {
      if (bal === null || bal < t.price) return;
      return round2(bal - t.price);
    });
    if (!balResult.committed) return res.status(400).json({ error: 'no_balance' });

    const cardId = 'c' + Date.now() + Math.random().toString(36).slice(2, 6);
    await tRef.child(`cards/${req.uid}/${cardId}`).set({
      grid: generateCard(),
      won: false,
      boughtAt: Date.now()
    });

    res.json({ ok: true, cardId });
  } catch (e) {
    console.error('buy', e.message);
    res.status(500).json({ error: 'buy_failed' });
  }
});

app.post('/api/change-card', authMw, async (req, res) => {
  try {
    if (!rateLimit(req.uid, 'change', 500)) return res.status(429).json({ error: 'too_fast' });
    const { tableId, cardId } = req.body || {};
    if (!tableId || !cardId) return res.status(400).json({ error: 'bad_input' });

    const tRef = db.ref('tables/' + tableId);
    const tSnap = await tRef.once('value');
    const d = tSnap.val();
    if (!d || d.status !== 'waiting') return res.status(400).json({ error: 'not_waiting' });
    if (!d.cards || !d.cards[req.uid] || !d.cards[req.uid][cardId]) return res.status(400).json({ error: 'no_card' });

    await tRef.child(`cards/${req.uid}/${cardId}`).update({
      grid: generateCard(),
      won: false
    });
    res.json({ ok: true });
  } catch (e) {
    console.error('change', e.message);
    res.status(500).json({ error: 'change_failed' });
  }
});

app.post('/api/edit-card', authMw, async (req, res) => {
  try {
    if (!rateLimit(req.uid, 'edit', 600)) return res.status(429).json({ error: 'too_fast' });
    const { tableId, cardId, grid } = req.body || {};
    if (!tableId || !cardId || !grid) return res.status(400).json({ error: 'bad_input' });
    if (!validateGrid(grid)) return res.status(400).json({ error: 'bad_grid' });

    const tRef = db.ref('tables/' + tableId);
    const tSnap = await tRef.once('value');
    const d = tSnap.val();
    if (!d || d.status !== 'waiting') return res.status(400).json({ error: 'not_waiting' });
    if (!d.cards || !d.cards[req.uid] || !d.cards[req.uid][cardId]) return res.status(400).json({ error: 'no_card' });

    await tRef.child(`cards/${req.uid}/${cardId}`).update({ grid, won: false });
    res.json({ ok: true });
  } catch (e) {
    console.error('edit', e.message);
    res.status(500).json({ error: 'edit_failed' });
  }
});

function isCardWinner(grid, drawnSet, winCond) {
  const rows = winCond === 'full' ? [0, 1, 2] : [0];
  for (const r of rows) {
    for (let col = 0; col < 9; col++) {
      const n = grid[r][col];
      if (n !== null && !drawnSet.has(n)) return false;
    }
  }
  return true;
}

async function checkWinners(tId, price) {
  const snap = await db.ref('tables/' + tId).once('value');
  const d = snap.val();
  if (!d || d.status !== 'playing') return;
  if (d.winners && Object.keys(d.winners).length > 0) return;

  const drawnArr = Object.values(d.drawnNumbers || {});
  const drawnSet = new Set(drawnArr);
  const winCond = price === 0.20 ? 'full' : 'row1';

  const realCards = [];
  const botCards = [];
  for (const uid in d.cards || {}) {
    for (const cId in d.cards[uid]) {
      const c = d.cards[uid][cId];
      if (!c || !c.grid) continue;
      realCards.push({ uid, cId, isBot: false, name: d.players?.[uid]?.name || 'Oyunçu', grid: c.grid });
    }
  }
  for (const bId in d.bots || {}) {
    for (const cId in d.bots[bId].cards || {}) {
      const c = d.bots[bId].cards[cId];
      if (!c || !c.grid) continue;
      botCards.push({ uid: bId, cId, isBot: true, name: d.bots[bId].name, grid: c.grid });
    }
  }

  const realWinners = realCards.filter(c => isCardWinner(c.grid, drawnSet, winCond));
  const botWinners = botCards.filter(c => isCardWinner(c.grid, drawnSet, winCond));

  const playerWinsRound = d.playerWinsRound !== false;

  if (playerWinsRound) {
    if (realCards.length > 0 && realWinners.length === 0) return;
    if (realWinners.length === 0 && botWinners.length === 0) return;
  } else {
    if (botWinners.length === 0) return;
  }

  const realPot = round2(realCards.length * price);
  const numRealWinners = realWinners.length;
  const perWinner = numRealWinners > 0 ? round2(realPot / numRealWinners) : 0;

  for (const w of realWinners) {
    if (perWinner > 0) {
      await db.ref('users/' + w.uid + '/balance').transaction(b => round2((b || 0) + perWinner));
    }
    await db.ref(`tables/${tId}/cards/${w.uid}/${w.cId}`).update({ won: true });
  }
  for (const w of botWinners) {
    await db.ref(`tables/${tId}/bots/${w.uid}/cards/${w.cId}`).update({ won: true });
  }

  const winnersRecord = {};
  let idx = 0;
  for (const w of realWinners) {
    winnersRecord['w' + idx++] = {
      uid: w.uid,
      name: w.name,
      isBot: false,
      amount: perWinner
    };
  }
  for (const w of botWinners) {
    winnersRecord['w' + idx++] = {
      uid: w.uid,
      name: w.name,
      isBot: true,
      amount: perWinner
    };
  }

  await db.ref('tables/' + tId).update({
    status: 'finished',
    finishedAt: Date.now(),
    winners: winnersRecord,
    pot: realPot
  });

  try {
    await db.ref('stats/system').transaction(s => {
      const cur = s || { profit: 0, payouts: 0, contributions: 0 };
      cur.contributions = round2((cur.contributions || 0) + realPot);
      cur.payouts = round2((cur.payouts || 0) + perWinner * numRealWinners);
      cur.profit = round2(cur.contributions - cur.payouts);
      return cur;
    });
  } catch (e) {}
}

async function resetTable(tId) {
  const snap = await db.ref('tables/' + tId).once('value');
  const d = snap.val();
  if (!d) return;

  const players = {};
  for (const uid in d.players || {}) {
    if (!d.players[uid].isBot) players[uid] = d.players[uid];
  }

  await db.ref('tables/' + tId).update({
    status: 'waiting',
    players,
    bots: null,
    cards: null,
    drawnNumbers: null,
    winners: null,
    countdownStart: null,
    playStart: null,
    finishedAt: null,
    pot: null,
    playerWinsRound: null
  });
}

const LOCK = {};

async function processTable(t) {
  const tRef = db.ref('tables/' + t.id);
  const snap = await tRef.once('value');
  let d = snap.val();

  if (!d) {
    await tRef.set({
      price: t.price,
      status: 'waiting',
      createdAt: Date.now(),
      players: {},
      bots: {},
      cards: {},
      drawnNumbers: {},
      winners: {}
    });
    return;
  }

  const counts = countCards(d);
  const minCards = Math.ceil(40 / t.price);
  const realPlayers = Object.keys(d.players || {}).length;

  if (d.status === 'waiting') {
    if (realPlayers > 0 && counts.total < minCards) {
      const need = minCards - counts.total;
      const numBots = Math.ceil(need / 6);
      const updates = {};
      let filled = 0;
      for (let i = 0; i < numBots; i++) {
        const cardsForBot = Math.min(6, need - filled);
        if (cardsForBot <= 0) break;
        const botId = 'bot_' + Math.random().toString(36).slice(2, 12);
        const cards = {};
        for (let j = 0; j < cardsForBot; j++) {
          cards['c' + j] = { grid: generateCard(), won: false };
        }
        updates[botId] = {
          name: BOT_NAMES[Math.floor(Math.random() * BOT_NAMES.length)],
          isBot: true,
          cards,
          joinedAt: Date.now()
        };
        filled += cardsForBot;
      }
      await tRef.child('bots').update(updates);
      return;
    }
    if (counts.total >= minCards && realPlayers > 0) {
      await tRef.update({ status: 'countdown', countdownStart: Date.now() });
      return;
    }
    return;
  }

  if (d.status === 'countdown') {
    if (Date.now() - d.countdownStart >= 120000) {
      const playerWinsRound = counts.real > 0 && Math.random() < 0.40;
      await tRef.update({
        status: 'playing',
        playStart: Date.now(),
        drawnNumbers: null,
        playerWinsRound
      });
    }
    return;
  }

  if (d.status === 'playing') {
    const drawnCount = d.drawnNumbers ? Object.keys(d.drawnNumbers).length : 0;
    const elapsed = Date.now() - d.playStart;
    const expected = Math.floor(elapsed / 3000);

    if (drawnCount < expected && drawnCount < 90) {
      const used = new Set(Object.values(d.drawnNumbers || {}));
      const avail = [];
      for (let i = 1; i <= 90; i++) if (!used.has(i)) avail.push(i);
      if (avail.length > 0) {
        const num = avail[Math.floor(Math.random() * avail.length)];
        await tRef.child('drawnNumbers/' + drawnCount).set(num);
      }
    }

    await checkWinners(t.id, t.price);
    return;
  }

  if (d.status === 'finished') {
    if (Date.now() - d.finishedAt >= 120000) {
      await resetTable(t.id);
    }
    return;
  }
}

async function tickTable(t) {
  if (LOCK[t.id]) return;
  LOCK[t.id] = true;
  try {
    await processTable(t);
  } catch (e) {
    console.error('tick', t.id, e.message);
  } finally {
    LOCK[t.id] = false;
  }
}

setInterval(() => {
  for (const t of TABLES) tickTable(t);
}, 1000);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('AZELOTO on port ' + PORT);
});

process.on('uncaughtException', (e) => console.error('uncaught', e.message));
process.on('unhandledRejection', (e) => console.error('unhandled', e && e.message));