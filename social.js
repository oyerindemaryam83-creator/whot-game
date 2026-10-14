/* ---------- FRIENDS, INVITES, PAYOUT PREVIEW, VOICE CHAT ---------- */
// Voice is peer to peer (WebRTC). STUN works for most home Wi-Fi, but many phone networks need a TURN
// relay. Add one below (coturn, Twilio, Metered...) or some players won't hear each other.
const ICE = {iceServers: [{urls: 'stun:stun.l.google.com:19302'}
  /* , {urls: 'turn:your.turn.host:3478', username: 'user', credential: 'pass'} */]};

let friends = {friends: [], incoming: []}, curPlayers = [], curStarted = 0;
const req = o => connect(() => tx(o));
const row = text => { const d = document.createElement('div'); d.className = 'frow'; d.append(text); return d; };
const btn = (label, fn, cls) => { const b = document.createElement('button'); b.textContent = label; if (cls) b.className = cls; b.onclick = fn; return b; };

function social(s) {
  if (s.t === 'friends') { friends = s; renderFriends(); renderInvite(); return true; }
  if (s.t === 'invite') { toast(s); return true; }
  if (s.t === 'rtc') { onRtc(s); return true; }
  if (s.t === 'public_rooms') { renderPublic(s.rooms); return true; }
  if (s.t === 'queue_wait') return true;
  return false;
}
function renderFriends() {
  const L = $('frList'), Q = $('frReq'); L.innerHTML = ''; Q.innerHTML = '';
  friends.incoming.forEach(n => Q.append(row(n + ' wants to be friends'),
    ...[btn('Accept', () => req({t: 'friend_accept', name: n})), btn('Decline', () => req({t: 'friend_decline', name: n}), 'ghost')]));
  if (!friends.friends.length) L.textContent = 'No friends yet. Add one by username.';
  friends.friends.forEach(f => {
    const d = row((f.online ? '🟢 ' : '⚪ ') + f.name + (f.busy ? ' (at a table)' : ''));
    if (f.online && !f.busy) d.append(btn('Challenge', () => req({t: 'create', stake: +$('stake').value, invite: f.name})));
    L.append(d);
  });
}
function renderInvite() {
  const b = $('inviteList'); b.innerHTML = '';
  if (curStarted) return;
  friends.friends.filter(f => f.online && !f.busy && !curPlayers.includes(f.name))
    .forEach(f => b.append(btn('Invite ' + f.name, () => req({t: 'invite', name: f.name}), 'ghost')));
}
function toast(s) {
  const t = $('toast'); t.innerHTML = '';
  t.append(s.from + ' invites you to a table. Stake ₦' + s.stake + '.',
    btn('Join', () => { t.classList.add('hidden'); req({t: 'join', code: s.code}); }),
    btn('Dismiss', () => t.classList.add('hidden'), 'ghost'));
  t.classList.remove('hidden'); sfx('turn');
}
// Search any player by name, then send a friend request or (for friends) a play request
async function searchPlayers() {
  const q = $('frName').value.trim(), out = $('frSearchResults'); out.innerHTML = '';
  if (q.length < 2) return out.append('Type at least 2 letters.');
  try {
    const r = await fetch(API_BASE + '/api/search?q=' + encodeURIComponent(q), {headers: {Authorization: 'Bearer ' + localStorage.getItem('whotToken')}});
    const d = await r.json(); if (!r.ok) throw new Error(d.error || 'Search failed');
    if (!d.players.length) return out.append('No players found.');
    d.players.forEach(p => {
      const line = row((p.online ? '🟢 ' : '⚪ ') + p.name + (p.busy ? ' (at a table)' : '') + (p.friend ? ' · friend' : ''));
      if (!p.friend) line.append(btn('Add friend', e => { req({t: 'friend_add', name: p.name}); e.target.textContent = 'Request sent'; e.target.disabled = true; }));
      else if (p.online && !p.busy) line.append(btn('Play request', () => req({t: 'create', stake: +$('stake').value, invite: p.name})));
      out.append(line);
    });
  } catch (e) { out.append(e.message); }
}
$('frSearch').onclick = searchPlayers;
$('frName').addEventListener('keydown', e => { if (e.key === 'Enter') searchPlayers(); });

/* ---- public lobbies: pick 2 to 4 players and join active users ---- */
function renderPublic(list) {
  const box = $('publicLobbies'); box.innerHTML = '';
  if (!list.length) return box.append('No open lobbies right now. Tap Find public game to open one and wait for others.');
  list.forEach(l => {
    const d = row(l.target + '-player table · ₦' + l.stake.toLocaleString() + ' · ' + l.names.join(', ') + ' (' + l.players + '/' + l.target + ')');
    d.append(btn('Join', () => req({t: 'join_public', code: l.code})));
    box.append(d);
  });
}
$('mpQuick').onclick = () => req({t: 'quick', target: +$('publicSize').value, stake: +$('stake').value});
$('mpBrowse').onclick = () => req({t: 'browse'});
$('btnPlayOnline').onclick = () => {
  const status = $('onlineStatus');
  if (document.body.classList.contains('guest')) { status.textContent = 'Log in to play online.'; return openAuth(); }
  status.textContent = 'Finding a table…';
  $('mpQuick').click(); // same public matchmaking as the button further down
  if ($('mpNote').textContent) status.textContent = $('mpNote').textContent;
};

/* ---- deck tracker (paid unlock; the server only sends tracker data to buyers) ---- */
let trackerOwned = false;
const TRACK = {circle: [1,2,3,4,5,7,8,10,11,12,13,14], triangle: [1,2,3,4,5,7,8,10,11,12,13,14],
  cross: [1,2,3,5,7,10,11,13,14], square: [1,2,3,5,7,10,11,13,14], star: [1,2,3,4,5,7,8]};
function trackerUi() {
  const live = !DEMO && !document.body.classList.contains('guest');
  $('trackerBuy').classList.toggle('hidden', !live || trackerOwned);
  $('trackerNote').classList.toggle('hidden', !live);
  $('trackerNote').textContent = trackerOwned ? 'Deck tracker unlocked. It shows at online tables.' : 'One-time in-game unlock for 500 chips. This is not a cash payment.';
}
async function loadTrackerState() {
  try {
    const r = await fetch(API_BASE + '/api/account', {headers: {Authorization: 'Bearer ' + localStorage.getItem('whotToken')}});
    trackerOwned = !!(await r.json()).trackerUnlocked;
  } catch (e) {}
  trackerUi();
}
$('trackerBuy').onclick = async () => {
  if (!confirm('Unlock the online deck tracker for 500 chips?')) return;
  try {
    const r = await fetch(API_BASE + '/api/tracker/unlock', {method: 'POST', body: '{}',
      headers: {'Content-Type': 'application/json', Authorization: 'Bearer ' + localStorage.getItem('whotToken')}});
    const d = await r.json(); if (!r.ok) return alert(d.error || 'Could not unlock the tracker');
    wallet.chips = d.chips; show(); trackerOwned = true; trackerUi();
  } catch (e) { alert('Could not reach the server.'); }
};
function renderTracker(s) {
  const p = $('trackerPanel');
  if (!s.started || !s.played) return p.classList.add('hidden');
  const seen = new Set(s.played.filter(c => c.s !== 'whot').map(c => c.s + c.n)), box = $('trackerContent');
  box.innerHTML = '';
  Object.keys(TRACK).forEach(suit => {
    const line = document.createElement('div'); line.className = 'track-row'; line.append(SYM[suit] + ' ');
    TRACK[suit].forEach(n => { const c = document.createElement('span'); c.textContent = n; c.className = 'track-n' + (seen.has(suit + n) ? ' played' : ''); line.append(c); });
    box.append(line);
  });
  const w = document.createElement('div'); w.className = 'track-row';
  w.append('Whot ' + s.played.filter(c => c.s === 'whot').length + '/5 · ' + s.played.length + ' cards played so far');
  box.append(w); p.classList.remove('hidden');
}
function hideTracker() { $('trackerPanel').classList.add('hidden'); }

/* ---- after a game: add the people you just played as friends ---- */
function showEndFriends() {
  const box = $('endFriends'); box.replaceChildren();
  const known = new Set(friends.friends.map(f => f.name));
  curPlayers.filter(n => n !== myName() && !known.has(n)).forEach(n =>
    box.append(btn('Add ' + n + ' as friend', e => { req({t: 'friend_add', name: n}); e.target.textContent = 'Request sent to ' + n; e.target.disabled = true; }, 'ghost')));
}
$('btnAgain').addEventListener('click', () => $('endFriends').replaceChildren());
trackerUi();
function autoConnect() { if (!DEMO && !document.body.classList.contains('guest')) { connect(() => tx({t: 'browse'})); loadTrackerState(); } }
if (DEMO) $('friendsPanel').classList.add('hidden');

// Shows the winner's take at the minimum 10% table fee (same rounding as the server)
function payout() {
  const s = Math.floor(+$('stake').value);
  const win = n => { const p = s * n; return p - Math.floor(p * 0.1); };
  $('payout').textContent = s >= 200
    ? 'Winner takes ₦' + win(2).toLocaleString() + ' (2 players), ₦' + win(3).toLocaleString() + ' (3), ₦' + win(4).toLocaleString() + ' (4). 10% table fee.'
    : 'Minimum stake is ₦200.';
}
$('stake').addEventListener('input', payout); payout();

/* ---- voice: every player who turns their mic on sends audio to each other player at the table ---- */
let mic = null; const pcOut = {}, pcIn = {}, voiceEls = {};
const myName = () => localStorage.getItem('whotUser');
function mkPc(name, side) {
  const pc = new RTCPeerConnection(ICE); pc._q = [];
  pc.onicecandidate = e => { try { if (e.candidate) tx({t: 'rtc', to: name, k: 'cand', side, c: e.candidate}); } catch (x) {} };
  return pc;
}
const drain = async pc => { while (pc._q.length) await pc.addIceCandidate(pc._q.shift()); };
async function offerTo(name) {
  const pc = pcOut[name] = mkPc(name, 'out');
  mic.getTracks().forEach(t => pc.addTrack(t, mic));
  await pc.setLocalDescription(await pc.createOffer());
  tx({t: 'rtc', to: name, k: 'offer', sdp: pc.localDescription});
}
async function onRtc(m) {
  try {
    if (m.k === 'offer') {
      if (pcIn[m.from]) pcIn[m.from].close();
      const pc = pcIn[m.from] = mkPc(m.from, 'in');
      pc.ontrack = e => {
        const a = voiceEls[m.from] || (voiceEls[m.from] = new Audio());
        a.srcObject = e.streams[0]; a.play().catch(() => {});
      };
      await pc.setRemoteDescription(m.sdp); await drain(pc);
      await pc.setLocalDescription(await pc.createAnswer());
      tx({t: 'rtc', to: m.from, k: 'answer', sdp: pc.localDescription});
    } else if (m.k === 'answer' && pcOut[m.from]) {
      await pcOut[m.from].setRemoteDescription(m.sdp); await drain(pcOut[m.from]);
    } else if (m.k === 'cand') {
      const pc = (m.side === 'out' ? pcIn : pcOut)[m.from];
      if (pc) pc.remoteDescription ? await pc.addIceCandidate(m.c) : pc._q.push(m.c);
    }
  } catch (e) {}
}
function closePeer(n) {
  [pcOut, pcIn].forEach(m => { if (m[n]) { m[n].close(); delete m[n]; } });
  if (voiceEls[n]) { voiceEls[n].srcObject = null; delete voiceEls[n]; }
}
function voiceStop(keepHearing) {
  if (mic) mic.getTracks().forEach(t => t.stop());
  mic = null; Object.keys(pcOut).forEach(n => { pcOut[n].close(); delete pcOut[n]; });
  $('btnMic').textContent = '🎤 Mic off';
  if (!keepHearing) { Object.keys(pcIn).forEach(closePeer); $('voiceBar').classList.add('hidden'); }
}
function voiceSync(s) {
  curPlayers = s.players.map(p => p.name); curStarted = s.started;
  $('voiceBar').classList.remove('hidden');
  new Set([...Object.keys(pcOut), ...Object.keys(pcIn)]).forEach(n => { if (!curPlayers.includes(n)) closePeer(n); });
  if (mic) curPlayers.forEach(n => { if (n !== myName() && !pcOut[n]) offerTo(n); });
}
$('btnMic').onclick = async () => {
  if (mic) return voiceStop(true);
  if (!navigator.mediaDevices || !window.RTCPeerConnection) return alert('This browser does not support voice chat.');
  try { mic = await navigator.mediaDevices.getUserMedia({audio: {echoCancellation: true, noiseSuppression: true}}); }
  catch (e) { return alert('Microphone blocked. Allow mic access for this site (voice needs HTTPS).'); }
  $('btnMic').textContent = '🎤 Mic on';
  curPlayers.forEach(n => n !== myName() && offerTo(n));
};
if (localStorage.getItem('whotToken')) autoConnect();
