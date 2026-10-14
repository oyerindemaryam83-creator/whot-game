/* Whot multiplayer server. Requires Node 22.13+; install with npm install and run npm start.
 * SQLite data is stored outside this public folder under LOCALAPPDATA, or at WHOT_DB_PATH.
 * Configure SMTP_HOST, SMTP_PORT, SMTP_SECURE, SMTP_USER, SMTP_PASS and SMTP_FROM for email OTPs.
 * Configure TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and TWILIO_FROM for phone OTPs.
 * Without providers, OTPs are returned/logged only outside NODE_ENV=production.
 * Deposits/withdrawals are stubs: connect payment-provider webhooks before production use. */
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto'), os = require('os');
const {DatabaseSync} = require('node:sqlite');
const nodemailer = require('nodemailer');
const {WebSocketServer} = require('ws');
const START = +process.env.STARTING_CHIPS || 0;
const WELCOME_BONUS = 200, CONTACT_BONUS = 50;
const MIN_STAKE = 200, FEE = 0.10, TRACKER_PRICE = 500; // table fee and tracker sales both go to the house (you)
const sessions = Object.create(null), rooms = {}, online = {};
const house = {chips: 0, games: 0}, ledger = [];
const dataDir = process.env.LOCALAPPDATA || process.env.XDG_DATA_HOME || path.join(os.homedir(), '.whot-game');
fs.mkdirSync(dataDir, {recursive: true});
const database = new DatabaseSync(process.env.WHOT_DB_PATH || path.join(dataDir, 'whot-game.sqlite'));
database.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY,
    username TEXT NOT NULL,
    username_key TEXT NOT NULL UNIQUE,
    salt TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    chips INTEGER NOT NULL,
    contact_type TEXT,
    contact_value TEXT UNIQUE,
    contact_bonus_awarded INTEGER NOT NULL DEFAULT 0,
    tracker_unlocked INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS contact_verifications (
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    contact_type TEXT NOT NULL,
    contact_value TEXT NOT NULL,
    code_hash TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    sent_at INTEGER NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS recovery_codes (
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    code_hash TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    sent_at INTEGER NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`);
try { database.exec('ALTER TABLE users ADD COLUMN tracker_unlocked INTEGER NOT NULL DEFAULT 0'); } catch (error) {
  if (!String(error.message).includes('duplicate column')) throw error;
}
// Your earnings are stored in the database so a restart never loses them.
database.exec(`CREATE TABLE IF NOT EXISTS house_ledger (
  id INTEGER PRIMARY KEY, time INTEGER NOT NULL, kind TEXT NOT NULL, room TEXT, username TEXT, amount INTEGER NOT NULL)`);
{
  const t = database.prepare("SELECT COALESCE(SUM(amount), 0) AS chips, COALESCE(SUM(kind = 'table_fee'), 0) AS games FROM house_ledger").get();
  house.chips = t.chips; house.games = t.games;
}
function recordHouse(kind, amount, room, username) {
  database.prepare('INSERT INTO house_ledger (time, kind, room, username, amount) VALUES (?, ?, ?, ?, ?)')
    .run(Date.now(), kind, room || null, username || null, amount);
  house.chips += amount; if (kind === 'table_fee') house.games++;
}
const users = Object.create(null);
for (const row of database.prepare('SELECT * FROM users').all()) {
  users[row.username_key] = {
    id: row.id, name: row.username, salt: row.salt, hash: row.password_hash, chips: row.chips,
    contactType: row.contact_type, contactValue: row.contact_value,
    contactBonusAwarded: Boolean(row.contact_bonus_awarded), trackerUnlocked: Boolean(row.tracker_unlocked),
    friends: new Set(), reqs: new Set()
  };
}
const saveChips = user => database.prepare('UPDATE users SET chips = ? WHERE id = ?').run(user.chips, user.id);
let otpSecret = database.prepare('SELECT value FROM settings WHERE key = ?').get('otp_secret')?.value;
if (!otpSecret) {
  otpSecret = crypto.randomBytes(32).toString('hex');
  database.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('otp_secret', otpSecret);
}
const otpHash = code => crypto.createHmac('sha256', otpSecret).update(code).digest('hex');
const SUITS = ['circle', 'triangle', 'cross', 'square', 'star'];
const R = [1,2,3,4,5,7,8,10,11,12,13,14], R2 = [1,2,3,5,7,10,11,13,14];
const RANKS = {circle: R, triangle: R, cross: R2, square: R2, star: [1,2,3,4,5,7,8]};
const FILES = {'/': 'index.html', '/style.css': 'style.css', '/app.js': 'app.js', '/extras.js': 'extras.js', '/mp.js': 'mp.js', '/social.js': 'social.js', '/sw.js': 'sw.js', '/manifest.json': 'manifest.json', '/icon-192.png': 'icon-192.png', '/icon-512.png': 'icon-512.png', '/admin': 'admin.html', '/admin.html': 'admin.html'};
const TYPES = {'.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.json': 'application/json', '.png': 'image/png'};
const hits = new Map();
// Simple in-memory rate limiter. Behind a proxy the first X-Forwarded-For entry is the client; login is also limited per username.
function limited(req, bucket, max, windowMs, who) {
  const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  const k = bucket + ':' + (who || ip), now = Date.now();
  let h = hits.get(k); if (!h || h.reset < now) h = {n: 0, reset: now + windowMs};
  h.n++; hits.set(k, h); return h.n > max;
}
setInterval(() => { const now = Date.now(); for (const [k, h] of hits) if (h.reset < now) hits.delete(k); }, 60000).unref();
const sha = v => crypto.createHash('sha256').update(String(v)).digest();
const adminOk = req => !!process.env.ADMIN_KEY && crypto.timingSafeEqual(sha(process.env.ADMIN_KEY), sha(req.headers['x-admin-key'] || ''));
if (process.env.ADMIN_KEY && process.env.ADMIN_KEY.length < 16) console.warn('WARNING: ADMIN_KEY is short. Use 24+ random characters.');
if (process.env.NODE_ENV === 'production' && !process.env.WHOT_DB_PATH) console.warn('WARNING: set WHOT_DB_PATH to a persistent disk, or accounts and chips are lost on redeploy.');
const json = (res, c, o) => { res.writeHead(c, {'Content-Type': 'application/json'}); res.end(JSON.stringify(o)); };
const send = (ws, o) => ws.readyState === 1 && ws.send(JSON.stringify(o));
const authUser = req => sessions[(req.headers.authorization || '').slice(7)];
const publicRoomList = () => Object.values(rooms).filter(room => room.public && !room.g)
  .map(room => ({code: room.code, players: room.seats.length, target: room.target, stake: room.stake, names: room.seats.map(s => s.user.name)}));
function broadcastPublicRooms() {
  const message = {t: 'public_rooms', rooms: publicRoomList()};
  wss?.clients.forEach(ws => { if (ws.user) send(ws, message); });
}
function normalizeContact(type, raw) {
  const value = String(raw || '').trim();
  if (type === 'email' && value.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return value.toLowerCase();
  if (type === 'phone') {
    const phone = value.replace(/[ ()-]/g, '');
    if (/^\+[1-9]\d{7,14}$/.test(phone)) return phone;
  }
  return null;
}
function codeMatches(code, hash) {
  if (!/^\d{6}$/.test(String(code || '')) || !hash) return false;
  return crypto.timingSafeEqual(Buffer.from(otpHash(String(code)), 'hex'), Buffer.from(hash, 'hex'));
}
async function deliverCode(type, contact, code) {
  if (type === 'email' && process.env.SMTP_HOST && process.env.SMTP_FROM) {
    const transport = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: +(process.env.SMTP_PORT || 587),
      secure: process.env.SMTP_SECURE === 'true',
      auth: process.env.SMTP_USER ? {user: process.env.SMTP_USER, pass: process.env.SMTP_PASS || ''} : undefined
    });
    await transport.sendMail({from: process.env.SMTP_FROM, to: contact, subject: 'Whot account verification',
      text: `Your Whot verification code is ${code}. It expires in 10 minutes.`});
    return true;
  }
  if (type === 'phone' && process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_FROM) {
    const sid = process.env.TWILIO_ACCOUNT_SID;
    const response = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
      method: 'POST',
      headers: {Authorization: 'Basic ' + Buffer.from(`${sid}:${process.env.TWILIO_AUTH_TOKEN}`).toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded'},
      body: new URLSearchParams({To: contact, From: process.env.TWILIO_FROM, Body: `Your Whot verification code is ${code}. It expires in 10 minutes.`})
    });
    if (!response.ok) throw new Error('SMS delivery failed');
    return true;
  }
  if (process.env.NODE_ENV === 'production') throw new Error('Contact delivery is not configured');
  console.log(`[development verification code] ${type} ${contact}: ${code}`);
  return false;
}

const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0], f = FILES[url];
  if (url === '/healthz') { res.writeHead(200, {'Content-Type': 'text/plain'}); return res.end('ok'); }
  if (process.env.NODE_ENV === 'production' && req.headers['x-forwarded-proto'] === 'http') { res.writeHead(301, {Location: 'https://' + req.headers.host + req.url}); return res.end(); }
  res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin'); res.setHeader('Permissions-Policy', 'microphone=(self)');
  if (req.method === 'GET' && f && fs.existsSync(path.join(__dirname, f))) {
    res.writeHead(200, {'Content-Type': TYPES[path.extname(f)], 'Cache-Control': 'no-cache'});
    return fs.createReadStream(path.join(__dirname, f)).pipe(res);
  }
  if (req.method === 'GET' && url === '/api/admin/earnings') // your 10%: set ADMIN_KEY and send it as the x-admin-key header
    return !limited(req, 'admin', 20, 900000) && adminOk(req) ? json(res, 200, {house, byKind: database.prepare('SELECT kind, COUNT(*) AS n, SUM(amount) AS chips FROM house_ledger GROUP BY kind').all(),
      ledger: database.prepare('SELECT time, kind, room, username, amount FROM house_ledger ORDER BY id DESC LIMIT 100').all()}) : json(res, 403, {});
  if (req.method === 'GET' && url === '/api/balance') { const u = authUser(req); return u ? json(res, 200, {chips: u.chips}) : json(res, 401, {}); }
  if (req.method === 'GET' && url === '/api/account') {
    const u = authUser(req);
    return u ? json(res, 200, {name: u.name, recoveryType: u.contactType, recoveryContact: u.contactValue,
      contactBonusAwarded: u.contactBonusAwarded, trackerUnlocked: u.trackerUnlocked}) : json(res, 401, {error: 'Log in first'});
  }
  if (req.method === 'GET' && url === '/api/search') {
    const u = authUser(req);
    if (!u) return json(res, 401, {error: 'Log in first'});
    const query = String(new URL(req.url, 'http://localhost').searchParams.get('q') || '').trim().toLowerCase();
    if (query.length < 2) return json(res, 200, {players: []});
    const players = Object.values(users).filter(player => player.id !== u.id && player.name.toLowerCase().includes(query))
      .slice(0, 20).map(player => ({name: player.name, online: !!online[key(player.name)],
        friend: u.friends.has(key(player.name)), busy: !!(online[key(player.name)] && online[key(player.name)].room)}));
    return json(res, 200, {players});
  }
  if (req.method !== 'POST') return json(res, 404, {});
  let b = ''; req.on('data', d => { if (b.length < 1e4) b += d; });
  req.on('end', async () => {
    let o = {}; try { o = JSON.parse(b); } catch {}
    if (url === '/api/register' || url === '/api/login') {
      const name = String(o.name || ''), pw = String(o.password || '');
      if (limited(req, 'auth', 30, 900000) || (url === '/api/login' && limited(req, 'login', 10, 900000, name.toLowerCase())))
        return json(res, 429, {error: 'Too many attempts. Wait a few minutes and try again.'});
      if (!/^[A-Za-z0-9_]{3,16}$/.test(name) || Buffer.byteLength(pw) < 8 || Buffer.byteLength(pw) > 72)
        return json(res, 400, {error: 'Username or password is invalid. Passwords must be 8 to 72 bytes.'});
      let u = users[name.toLowerCase()];
      if (url === '/api/register') {
        if (u) return json(res, 409, {error: 'That username is taken'});
        const salt = crypto.randomBytes(16).toString('hex');
        const hash = crypto.scryptSync(pw, salt, 32).toString('hex'), chips = START + WELCOME_BONUS;
        try {
          const result = database.prepare('INSERT INTO users (username, username_key, salt, password_hash, chips) VALUES (?, ?, ?, ?, ?)')
            .run(name, name.toLowerCase(), salt, hash, chips);
          u = users[name.toLowerCase()] = {id: Number(result.lastInsertRowid), name, salt, hash, chips,
            contactType: null, contactValue: null, contactBonusAwarded: false, trackerUnlocked: false,
            friends: new Set(), reqs: new Set()};
        } catch (error) {
          if (String(error.message).includes('UNIQUE')) return json(res, 409, {error: 'That username is taken'});
          console.error('Account registration failed:', error);
          return json(res, 500, {error: 'Could not create account'});
        }
      } else if (!u || !crypto.timingSafeEqual(Buffer.from(u.hash, 'hex'), crypto.scryptSync(pw, u.salt, 32)))
        return json(res, 401, {error: 'Wrong username or password'});
      const token = crypto.randomBytes(24).toString('hex'); sessions[token] = u;
      return json(res, url === '/api/register' ? 201 : 200, {token, name: u.name, chips: u.chips,
        welcomeBonus: url === '/api/register' ? WELCOME_BONUS : 0});
    }
    if (url === '/api/logout') {
      const token = (req.headers.authorization || '').replace(/^Bearer /, '');
      const user = sessions[token];
      delete sessions[token];
      if (user && online[key(user.name)]) online[key(user.name)].close(1008, 'Logged out');
      return json(res, 200, {ok: true});
    }
    const user = authUser(req);
    if (!user && url !== '/api/recovery/request' && url !== '/api/recovery/reset') return json(res, 401, {error: 'Log in first'});
    if (url === '/api/contact/request') {
      if (user.contactValue) return json(res, 409, {error: 'A recovery contact is already verified for this account'});
      const type = String(o.type || ''), value = normalizeContact(type, o.contact);
      if (!value) return json(res, 400, {error: 'Enter a valid email address or phone number in international format'});
      if (database.prepare('SELECT id FROM users WHERE contact_value = ?').get(value))
        return json(res, 409, {error: 'That contact is already linked to an account'});
      const now = Date.now(), previous = database.prepare('SELECT sent_at FROM contact_verifications WHERE user_id = ?').get(user.id);
      if (previous && now - previous.sent_at < 60000) return json(res, 429, {error: 'Wait one minute before requesting another code'});
      const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
      try { await deliverCode(type, value, code); }
      catch (error) { console.error('Contact verification delivery failed:', error.message); return json(res, 503, {error: 'Could not send a verification code'}); }
      database.prepare(`INSERT OR REPLACE INTO contact_verifications
        (user_id, contact_type, contact_value, code_hash, expires_at, sent_at, attempts) VALUES (?, ?, ?, ?, ?, ?, 0)`)
        .run(user.id, type, value, otpHash(code), now + 600000, now);
      return json(res, 200, {ok: true, expiresIn: 600,
        ...(process.env.NODE_ENV === 'production' ? {} : {devCode: code})});
    }
    if (url === '/api/contact/verify') {
      const pending = database.prepare('SELECT * FROM contact_verifications WHERE user_id = ?').get(user.id);
      if (!pending || pending.expires_at <= Date.now() || pending.attempts >= 5) {
        database.prepare('DELETE FROM contact_verifications WHERE user_id = ?').run(user.id);
        return json(res, 400, {error: 'Code expired or invalid. Request a new code.'});
      }
      if (!codeMatches(o.code, pending.code_hash)) {
        database.prepare('UPDATE contact_verifications SET attempts = attempts + 1 WHERE user_id = ?').run(user.id);
        return json(res, 400, {error: 'Code expired or invalid. Request a new code.'});
      }
      try {
        database.prepare('UPDATE users SET contact_type = ?, contact_value = ?, contact_bonus_awarded = 1, chips = chips + ? WHERE id = ? AND contact_value IS NULL')
          .run(pending.contact_type, pending.contact_value, CONTACT_BONUS, user.id);
      } catch (error) {
        if (String(error.message).includes('UNIQUE')) return json(res, 409, {error: 'That contact is already linked to an account'});
        throw error;
      }
      database.prepare('DELETE FROM contact_verifications WHERE user_id = ?').run(user.id);
      user.contactType = pending.contact_type; user.contactValue = pending.contact_value;
      user.contactBonusAwarded = true; user.chips += CONTACT_BONUS;
      return json(res, 200, {ok: true, chips: user.chips, bonus: CONTACT_BONUS,
        recoveryType: user.contactType, recoveryContact: user.contactValue});
    }
    if ((url === '/api/recovery/request' || url === '/api/recovery/reset') && limited(req, 'recovery', 10, 900000))
      return json(res, 429, {error: 'Too many attempts. Wait a few minutes and try again.'});
    if (url === '/api/recovery/request') {
      const type = String(o.type || ''), value = normalizeContact(type, o.contact);
      if (!value) return json(res, 400, {error: 'Enter a valid email address or phone number'});
      const found = database.prepare('SELECT id FROM users WHERE contact_type = ? AND contact_value = ?').get(type, value);
      const response = {ok: true, message: 'If an account uses that verified contact, a recovery code has been sent.'};
      if (!found) return json(res, 200, response);
      const now = Date.now(), previous = database.prepare('SELECT sent_at FROM recovery_codes WHERE user_id = ?').get(found.id);
      if (previous && now - previous.sent_at < 60000) return json(res, 200, response);
      const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
      try { await deliverCode(type, value, code); }
      catch (error) { console.error('Account recovery delivery failed:', error.message); return json(res, 503, {error: 'Could not send a recovery code'}); }
      database.prepare(`INSERT OR REPLACE INTO recovery_codes
        (user_id, code_hash, expires_at, sent_at, attempts) VALUES (?, ?, ?, ?, 0)`)
        .run(found.id, otpHash(code), now + 600000, now);
      if (process.env.NODE_ENV !== 'production') response.devCode = code;
      return json(res, 200, response);
    }
    if (url === '/api/recovery/reset') {
      const type = String(o.type || ''), value = normalizeContact(type, o.contact), password = String(o.password || '');
      if (!value || Buffer.byteLength(password) < 8 || Buffer.byteLength(password) > 72)
        return json(res, 400, {error: 'Enter a valid contact and a password of 8 to 72 bytes'});
      const found = database.prepare('SELECT * FROM users WHERE contact_type = ? AND contact_value = ?').get(type, value);
      const pending = found && database.prepare('SELECT * FROM recovery_codes WHERE user_id = ?').get(found.id);
      if (!found || !pending || pending.expires_at <= Date.now() || pending.attempts >= 5) {
        if (found) database.prepare('DELETE FROM recovery_codes WHERE user_id = ?').run(found.id);
        return json(res, 400, {error: 'Recovery code expired or invalid'});
      }
      if (!codeMatches(o.code, pending.code_hash)) {
        database.prepare('UPDATE recovery_codes SET attempts = attempts + 1 WHERE user_id = ?').run(found.id);
        return json(res, 400, {error: 'Recovery code expired or invalid'});
      }
      const salt = crypto.randomBytes(16).toString('hex'), hash = crypto.scryptSync(password, salt, 32).toString('hex');
      database.prepare('UPDATE users SET salt = ?, password_hash = ? WHERE id = ?').run(salt, hash, found.id);
      database.prepare('DELETE FROM recovery_codes WHERE user_id = ?').run(found.id);
      const account = users[found.username_key]; account.salt = salt; account.hash = hash;
      for (const [token, session] of Object.entries(sessions)) {
        if (session.id === account.id) {
          delete sessions[token];
          const socket = online[key(account.name)];
          if (socket) socket.close(1008, 'Password reset');
        }
      }
      return json(res, 200, {ok: true, message: 'Password reset. Log in with your new password.'});
    }
    if (url === '/api/tracker/unlock') {
      if (user.trackerUnlocked) return json(res, 200, {ok: true, alreadyUnlocked: true, chips: user.chips});
      if (user.chips < TRACKER_PRICE) return json(res, 400, {error: 'You need ' + TRACKER_PRICE + ' chips to unlock the tracker'});
      let result;
      database.exec('BEGIN IMMEDIATE');
      try {
        result = database.prepare('UPDATE users SET chips = chips - ?, tracker_unlocked = 1 WHERE id = ? AND tracker_unlocked = 0 AND chips >= ?').run(TRACKER_PRICE, user.id, TRACKER_PRICE);
        if (result.changes) recordHouse('tracker', TRACKER_PRICE, null, user.name); // the chips go to you
        database.exec('COMMIT');
      } catch (error) { database.exec('ROLLBACK'); throw error; }
      if (!result.changes) return json(res, 409, {error: 'Tracker unlock has already been claimed'});
      user.chips -= TRACKER_PRICE; user.trackerUnlocked = true;
      return json(res, 200, {ok: true, chips: user.chips, trackerUnlocked: true});
    }
    if (!user) return json(res, 401, {error: 'Log in first'});
    if (url === '/api/withdraw') return json(res, 501, {error: 'Withdrawals are disabled until a licensed Nigerian payout provider and account-name verification are configured.'});
    if (url === '/api/deposit') return json(res, 501, {error: 'Deposits are disabled until a payment provider is configured.'});
    json(res, 404, {});
  });
});

/* ---------- game engine (server side) ---------- */
function shuffle(a) { for (let i = a.length - 1; i > 0; i--) { const j = crypto.randomInt(i + 1); [a[i], a[j]] = [a[j], a[i]]; } return a; }
function deck() {
  const d = []; for (const s in RANKS) RANKS[s].forEach(n => d.push({s, n}));
  for (let i = 0; i < 5; i++) d.push({s: 'whot', n: 20});
  return shuffle(d);
}
const legal = (g, c) => { const t = g.pile.at(-1);
  if (g.pending) return c.n === g.pending.rank;
  return c.s === 'whot' || c.s === (g.called || t.s) || (t.s !== 'whot' && c.n === t.n); };
const adv = (room, k = 1) => room.g.turn = (room.g.turn + k) % room.seats.length;
function pick(g, s, k) {
  for (let i = 0; i < k && g.draw.length; i++) s.hand.push(g.draw.pop());
  return g.draw.length === 0;
}
function view(room, seat) {
  const g = room.g, base = {t: 'state', code: room.code, stake: room.stake, host: room.seats[0] === seat, public: room.public, target: room.target,
    players: room.seats.map(s => ({name: s.user.name, n: s.hand.length, lastCard: s.hand.length === 1}))};
  if (!g) return base;
  const mine = room.seats[g.turn] === seat;
  return {...base, started: 1, hand: seat.hand, top: g.pile.at(-1), called: g.called, pending: g.pending,
    turn: room.seats[g.turn].user.name, mine, playable: mine ? seat.hand.map((c, i) => legal(g, c) ? i : -1).filter(i => i >= 0) : [],
    drawCount: g.draw.length, deadline: g.deadline, played: seat.user.trackerUnlocked ? g.played : undefined, // tracker data is only sent to players who bought it
    lastCardPlayer: g.lastCardPlayer,
    pot: room.stake * room.seats.length, msg: g.msg};
}
const broadcast = room => room.seats.forEach(s => send(s.ws, view(room, s)));
const broadcastVoice = (room, text) => room.seats.forEach(s => send(s.ws, {t: 'voice', text}));
function start(room) {
  room.seats.forEach(s => { s.user.chips -= room.stake; saveChips(s.user); s.hand = []; send(s.ws, {t: 'chips', chips: s.user.chips}); });
  const d = deck(); for (let r = 0; r < 6; r++) room.seats.forEach(s => s.hand.push(d.pop()));
  let first = d.pop(); while (first.s === 'whot') { d.unshift(first); first = d.pop(); }
  room.g = {draw: d, pile: [first], played: [first], turn: 1 % room.seats.length, called: null, pending: null,
    continueAfterAction: false, selectionPaused: false, pendingDraw: null, msg: 'Game started.', lastCardPlayer: null};
  next(room);
}
function next(room) {
  clearTimeout(room.timer);
  room.g.deadline = Date.now() + 8000;
  room.g.selectionPaused = false;
  broadcast(room);
  room.g.lastCardPlayer = null;
  room.timer = setTimeout(() => auto(room), 8000);
}
function auto(room) {
  const g = room.g, s = room.seats[g.turn];
  queueDraw(room, s, true);
}
function pauseSelection(room, seat) {
  const g = room.g;
  if (!g || room.seats[g.turn] !== seat || g.selectionPaused || g.pendingDraw) return;
  g.selectionPaused = true; clearTimeout(room.timer); g.deadline += 3000;
  room.timer = setTimeout(() => auto(room), Math.max(0, g.deadline - Date.now()));
  broadcast(room);
}
function queueDraw(room, seat, automatic) {
  const g = room.g;
  if (!g || room.seats[g.turn] !== seat || g.pendingDraw) return 'Not your turn';
  clearTimeout(room.timer);
  const count = g.pending ? g.pending.count : 1;
  g.pending = null; g.continueAfterAction = false; g.pendingDraw = {seat, count}; g.deadline = Date.now() + 3000;
  g.msg = automatic ? 'Time is up. A card will be drawn in 3 seconds.' : seat.user.name + ' is drawing a card.';
  broadcast(room);
  room.timer = setTimeout(() => {
    if (!room.g || !room.g.pendingDraw) return;
    const pending = room.g.pendingDraw; room.g.pendingDraw = null;
    pick(room.g, pending.seat, pending.count);
    if (!room.g.draw.length) return endByPoints(room);
    room.g.msg = pending.seat.user.name + ' picked ' + pending.count + '.';
    adv(room); next(room);
  }, 3000);
}
function play(room, seat, i, suit) {
  const g = room.g, c = seat.hand[i];
  if (!c || room.seats[g.turn] !== seat || g.pendingDraw || !legal(g, c)) return 'Illegal move';
  if (c.s === 'whot' && !SUITS.includes(suit)) return 'Call a shape';
  clearTimeout(room.timer);
  const continuing = g.continueAfterAction;
  g.continueAfterAction = false;
  const isAction = c.s === 'whot' || [1, 2, 8, 14].includes(c.n); // no "Continue" before another action card
  if (continuing && !isAction) broadcastVoice(room, 'Continue.');
  seat.hand.splice(i, 1); g.pile.push(c); g.played.push(c); g.called = null;
  g.msg = seat.user.name + ' played ' + (c.s === 'whot' ? 'Whot' : c.s + ' ' + c.n) + '.';
  if (!seat.hand.length) return win(room, seat);
  if (seat.hand.length === 1) g.lastCardPlayer = seat.user.name;
  if (c.s === 'whot') { broadcastVoice(room, 'I need ' + suit + '.'); g.called = suit; g.msg += ' Called ' + suit + '.'; adv(room); }
  else if (c.n === 1) {
    broadcastVoice(room, 'Hold on.');
    g.continueAfterAction = true;
    g.msg += ' Hold on! Play another legal card or draw one card.';
  }
  else if (c.n === 2) {
    broadcastVoice(room, g.pending ? 'Defended.' : 'Pick 2.');
    g.pending = {rank: 2, count: 2}; adv(room);
  }
  else if (c.n === 8) {
    broadcastVoice(room, 'Suspension.');
    g.msg += ' Suspension! ' + room.seats[(g.turn + 1) % room.seats.length].user.name + ' skips a turn.';
    adv(room, 2);
  }
  else if (c.n === 14) {
    broadcastVoice(room, 'General Market.');
    for (let step = 1; step < room.seats.length; step++) {
      pick(g, room.seats[(g.turn + step) % room.seats.length], 1);
      if (!g.draw.length) return endByPoints(room);
    }
    g.continueAfterAction = true;
    g.msg += ' General market! Everyone else drew one in turn order. Play again or draw.';
  }
  else adv(room);
  next(room);
}
function draw(room, seat) {
  return queueDraw(room, seat, false);
}
function scoreSheet(seat) {
  const cards = seat.hand.map(c => {
    const value = c.s === 'whot' ? 20 : c.s === 'star' ? c.n * 2 : c.n;
    return {label: c.s === 'whot' ? 'Whot (20)' : c.s + ' ' + c.n,
      calculation: c.s === 'star' ? c.n + ' x 2 = ' + value : String(value), value};
  });
  return {name: seat.user.name, cards, total: cards.reduce((sum, c) => sum + c.value, 0)};
}
function handPoints(seat) {
  return scoreSheet(seat).total;
}
function endByPoints(room) {
  const seats = room.seats, scores = seats.map(scoreSheet), totals = scores.map(score => score.total), lowest = Math.min(...totals);
  const winners = seats.filter((s, i) => totals[i] === lowest);
  const pot = room.stake * seats.length, fee = Math.floor(pot * FEE), prize = pot - fee;
  const eachPrize = Math.floor(prize / winners.length);
  winners.forEach((s, i) => { s.user.chips += eachPrize + (i === 0 ? prize % winners.length : 0); saveChips(s.user); });
  recordHouse('table_fee', fee, room.code, winners.map(s => s.user.name).join(','));
  clearTimeout(room.timer);
  const winnerNames = winners.map(s => s.user.name).join(' and ');
  const pen = seats.map((s, i) => s.user.name + ': ' + totals[i] + ' pts').join(', ');
  seats.forEach(s => {
    send(s.ws, {t: 'end', winner: winnerNames, prize: winners.includes(s) ? eachPrize : 0,
      pen, scores, you: winners.includes(s), chips: s.user.chips, byPoints: true});
    send(s.ws, {t: 'chips', chips: s.user.chips}); s.ws.room = null; notifyFriends(s.user);
  });
  delete rooms[room.code];
}
function win(room, seat) {
  clearTimeout(room.timer);
  const pot = room.stake * room.seats.length, fee = Math.floor(pot * FEE), prize = pot - fee; seat.user.chips += prize; saveChips(seat.user);
  recordHouse('table_fee', fee, room.code, seat.user.name);
  const pts = c => c.s === 'whot' ? 20 : c.s === 'star' ? c.n * 2 : c.n;
  const pen = room.seats.filter(s => s !== seat).map(s => s.user.name + ': ' + s.hand.reduce((a, c) => a + pts(c), 0) + ' pts').join(', ');
  room.seats.forEach(s => { send(s.ws, {t: 'end', winner: seat.user.name, prize, pen, you: s === seat, chips: s.user.chips});
    send(s.ws, {t: 'chips', chips: s.user.chips}); s.ws.room = null; notifyFriends(s.user); });
  delete rooms[room.code];
}
function drop(ws) {
  const r = ws.room; if (!r) return; const s = r.seats.find(x => x.ws === ws); ws.room = null; notifyFriends(ws.user);
  if (!r.g) { r.seats = r.seats.filter(x => x !== s); r.seats.length ? broadcast(r) : delete rooms[r.code]; broadcastPublicRooms(); }
  else { s.left = 1; if (r.seats[r.g.turn] === s) next(r); }
}

/* ---------- friends and invites ---------- */
const key = n => String(n).toLowerCase();
const friendsView = u => ({t: 'friends',
  friends: [...u.friends].map(k => ({name: users[k].name, online: !!online[k], busy: !!(online[k] && online[k].room)})),
  incoming: [...u.reqs].map(k => users[k].name)});
const sendFriends = u => online[key(u.name)] && send(online[key(u.name)], friendsView(u));
const notifyFriends = u => u.friends.forEach(k => sendFriends(users[k]));
function invite(u, room, name) {
  if (!users[key(name)] || !u.friends.has(key(name))) return 'Add them as a friend first';
  const w = online[key(name)];
  if (!w) return name + ' is offline';
  if (w.room) return name + ' is already at a table';
  send(w, {t: 'invite', from: u.name, code: room.code, stake: room.stake});
}
function social(u, o) {
  if (o.t === 'friends') return sendFriends(u);
  const k = key(o.name), me = key(u.name), t = users[k];
  if (!t || t === u) return 'No player with that username';
  if (o.t === 'friend_add') {
    if (u.friends.has(k)) return 'Already friends';
    if (u.reqs.has(k)) return social(u, {t: 'friend_accept', name: o.name});
    t.reqs.add(me);
  } else if (o.t === 'friend_accept' && u.reqs.has(k)) { u.reqs.delete(k); u.friends.add(k); t.friends.add(me); }
  else if (o.t === 'friend_decline') u.reqs.delete(k);
  else if (o.t === 'invite') { const r = online[me] && online[me].room; return r && !r.g ? invite(u, r, o.name) : 'Create a table first'; }
  sendFriends(u); sendFriends(t);
}

/* ---------- sockets ---------- */
const wss = new WebSocketServer({server, path: '/ws', maxPayload: 16384});
wss.on('connection', (ws, req) => {
  const u = sessions[new URL(req.url, 'http://x').searchParams.get('token')];
  if (!u) return ws.close();
  const old = online[key(u.name)]; if (old && old !== ws) old.close(4000, 'Signed in elsewhere'); // one seat per account
  ws.user = u; ws.room = null; online[key(u.name)] = ws; notifyFriends(u); sendFriends(u);
  ws.on('close', () => { drop(ws); if (online[key(u.name)] === ws) { delete online[key(u.name)]; notifyFriends(u); } });
  ws.on('message', m => {
    let o; try { o = JSON.parse(m); } catch { return; }
    const r = ws.room; let err;
    const join = room => {
      room.seats.push({user: u, ws, hand: []}); ws.room = room; notifyFriends(u); broadcast(room); broadcastPublicRooms();
      if (room.public && room.seats.length === room.target) start(room);
    };
    const makeRoom = (stake, options = {}) => {
      let code; do code = crypto.randomBytes(2).toString('hex').toUpperCase(); while (rooms[code]);
      return rooms[code] = {code, stake, seats: [], g: null, public: !!options.public, target: options.target || 4};
    };
    if (o.t === 'browse') { send(ws, {t: 'public_rooms', rooms: publicRoomList()}); return; }
    if (o.t === 'quick' && !r) {
      const target = Math.floor(+o.target), stake = Math.floor(+o.stake);
      if (!(target >= 2 && target <= 4)) err = 'Choose 2 to 4 players.';
      else if (stake < MIN_STAKE) err = 'Minimum stake is ₦' + MIN_STAKE;
      else if (u.chips < stake) err = 'Not enough chips for this stake';
      else {
        const room = publicRoomList().map(item => rooms[item.code]).find(item => item.target === target && item.stake === stake && !item.seats.some(s => s.user === u));
        if (room) join(room);
        else { join(makeRoom(stake, {public: true, target})); send(ws, {t: 'queue_wait', target}); }
      }
    } else if (o.t === 'create_public' && !r) {
      const target = Math.floor(+o.target), stake = Math.floor(+o.stake);
      if (!(target >= 2 && target <= 4)) err = 'Choose 2 to 4 players.';
      else if (stake < MIN_STAKE) err = 'Minimum stake is ₦' + MIN_STAKE;
      else if (u.chips < stake) err = 'Not enough chips for this stake';
      else { join(makeRoom(stake, {public: true, target})); send(ws, {t: 'queue_wait', target}); }
    } else if (o.t === 'join_public' && !r) {
      const room = rooms[String(o.code).toUpperCase()];
      if (!room || !room.public || room.g || room.seats.length >= room.target) err = 'Lobby is no longer available';
      else if (room.seats.some(s => s.user === u)) err = 'You are already in this lobby';
      else if (u.chips < room.stake) err = 'Not enough chips for this stake';
      else join(room);
    } else if (o.t === 'create' && !r) {
      const stake = Math.floor(+o.stake);
      if (!(stake >= MIN_STAKE)) err = 'Minimum stake is ₦' + MIN_STAKE;
      else if (stake > u.chips) err = 'Not enough chips for this stake';
      else {
        const room = makeRoom(stake);
        join(room);
        if (o.invite) err = invite(u, room, o.invite);
      }
    } else if (o.t === 'join' && !r) {
      const room = rooms[String(o.code).toUpperCase()];
      if (!room || room.g || room.seats.length >= 4) err = 'Table not available';
      else if (room.seats.some(s => s.user === u)) err = 'You are already seated';
      else if (u.chips < room.stake) err = 'Not enough chips for this stake';
      else join(room);
    } else if (o.t === 'leave' && r && !r.g) drop(ws);
    else if (o.t === 'start' && r && !r.g && !r.public && r.seats[0].ws === ws) {
      if (r.seats.length < 2) err = 'Need at least 2 players';
      else if (r.seats.some(s => s.user.chips < r.stake)) err = 'A player cannot cover the stake';
      else start(r);
    } else if (o.t === 'rtc' && r) { // voice signalling: relay only to someone at the same table
      const t = r.seats.find(s => s.user.name === o.to && !s.left);
      if (t) send(t.ws, {t: 'rtc', from: u.name, k: o.k, sdp: o.sdp, c: o.c, side: o.side});
    } else if (/^(friends|friend_|invite)/.test(o.t)) { err = social(u, o);
    } else if (r && r.g) {
      const seat = r.seats.find(s => s.ws === ws);
      if (o.t === 'pause') pauseSelection(r, seat);
      else err = o.t === 'play' ? play(r, seat, o.i, o.suit) : o.t === 'draw' ? draw(r, seat) : null;
    }
    if (err) send(ws, {t: 'err', m: err});
  });
});
server.listen(process.env.PORT || 3000, () => console.log('Whot server on port ' + (process.env.PORT || 3000)));

// Deploys and restarts clear in-memory tables. Stakes are charged when a game starts, so refund live games on shutdown.
function shutdown() {
  for (const room of Object.values(rooms)) if (room.g) room.seats.forEach(s => {
    s.user.chips += room.stake; saveChips(s.user);
    send(s.ws, {t: 'chips', chips: s.user.chips}); send(s.ws, {t: 'err', m: 'Server restarting. Your stake was refunded.'});
  });
  try { database.close(); } catch {}
  setTimeout(() => process.exit(0), 300);
}
process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
