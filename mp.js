/* ---------- ONLINE TABLES (client). The server decides everything; this only displays state and sends moves. ---------- */
let ws = null, online = false, myTurn = false, lastTop = '', onlineClock = null, selectedOnlineCard = null;
const announcedLastCards = new Set();
const tx = o => ws.send(JSON.stringify(o));
const backLobby = () => { online = false; voiceStop(); hideTracker(); $('table').classList.add('hidden'); $('roomBar').classList.add('hidden'); $('lobby').classList.remove('hidden'); };

function connect(then) {
  if (document.body.classList.contains('guest')) return $('mpNote').textContent = 'Log in to play online tables.';
  if (!navigator.onLine) return $('mpNote').textContent = 'You are offline. Computer games still work.';
  if (DEMO) return $('mpNote').textContent = 'Online tables need server.js running. Set API_BASE in app.js, then reload.';
  $('mpNote').textContent = '';
  if (ws && ws.readyState === 1) return then();
  if (ws && ws.readyState === 0) return ws.addEventListener('open', then, {once: true}); // still connecting
  ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws?token=' + encodeURIComponent(localStorage.getItem('whotToken')));
  ws.onopen = then;
  ws.onmessage = e => handle(JSON.parse(e.data));
  ws.onclose = () => { if (online) { alert('Connection lost. Your table will keep playing for you.'); backLobby(); } };
}
$('mpCreate').onclick = () => connect(() => tx({t: 'create', stake: +$('stake').value}));
$('mpJoin').onclick = () => connect(() => tx({t: 'join', code: $('mpCode').value.trim()}));
$('mpStart').onclick = () => tx({t: 'start'});
$('mpLeave').onclick = () => { tx({t: 'leave'}); backLobby(); };
$('drawPile').addEventListener('click', () => { if (online && myTurn) tx({t: 'draw'}); });

function handle(s) {
  if (s.t === 'voice') { announce(s.text); return; }
  if (social(s)) return;
  if (s.t === 'err') return alert(s.m);
  if (s.t === 'chips') { wallet.chips = s.chips; return show(); }
  if (s.t === 'end') {
    online = false; selectedOnlineCard = null; voiceStop(); sfx(s.you ? 'win' : 'lose');
    wallet.chips = s.chips; show();
    announce(s.you
      ? (s.byPoints ? 'Check up! You win on points!' : 'Check up! You win!')
      : (s.byPoints ? 'Check up! ' + s.winner + ' wins on points!' : 'Check up! ' + s.winner + ' wins!'), true);
    $('endTitle').textContent = s.byPoints
      ? (s.you ? 'You win on points!' : s.winner + ' wins on points!')
      : (s.you ? 'You won ' + s.prize.toLocaleString() + ' chips' : s.winner + ' wins');
    $('endText').textContent = (s.byPoints ? 'Draw pile empty. ' : '')
      + (s.you ? '' : 'Your stake went to the winner. ') + 'Hand totals: ' + s.pen + '. Current balance: '
      + wallet.chips.toLocaleString() + ' chips. Demo chips are not redeemable for naira.';
    renderScoreBreakdown(s.byPoints ? s.scores : null);
    showEndFriends(); hideTracker();
    return $('endDlg').showModal();
  }
  if (s.t === 'state') { G = null; online = true; renderOnline(s); voiceSync(s); renderInvite(); renderTracker(s); }
}
function renderOnline(s) {
  const me = localStorage.getItem('whotUser');
  if (!s.mine || !s.started || (selectedOnlineCard !== null && !s.playable.includes(selectedOnlineCard))) selectedOnlineCard = null;
  $('lobby').classList.add('hidden'); $('table').classList.remove('hidden');
  $('roomBar').classList.toggle('hidden', !!s.started);
  const names = s.players.map(p => p.name).join(', ');
  $('roomCode').textContent = s.public
    ? 'Public table · stake ₦' + s.stake + ' · ' + names + ' (' + s.players.length + '/' + s.target + '). Starts when full.'
    : 'Private table ' + s.code + ' · stake ₦' + s.stake + ' · ' + names + ' (' + s.players.length + '/4)';
  $('mpStart').classList.toggle('hidden', !s.host || !!s.public);
  ['seatNorth', 'seatWest', 'seatEast', 'opponents'].forEach(id => $(id).replaceChildren());
  const localSeat = Math.max(0, s.players.findIndex(player => player.name === me));
  const compass = ['opponents', 'seatWest', 'seatNorth', 'seatEast'];
  s.players.forEach(p => {
    const relativeSeat = (s.players.findIndex(player => player.name === p.name) - localSeat + s.players.length) % s.players.length;
    const d = document.createElement('div');
    d.className = 'opp' + (s.started && s.turn === p.name ? ' turn' : '') + (p.name === me ? ' self' : '');
    d.append(document.createTextNode((p.name === me ? 'You' : p.name) + (s.started ? ' · ' + p.n + (p.n === 1 ? ' card' : ' cards') : ' joined')));
    if (s.started && p.n === 1) {
      const badge = document.createElement('span'); badge.className = 'last-card'; badge.textContent = 'LAST CARD!'; d.append(badge);
      if (!announcedLastCards.has(p.name)) { announce('Last card!'); announcedLastCards.add(p.name); }
    } else if (p.n !== 1) announcedLastCards.delete(p.name);
    $(compass[relativeSeat] || 'seatNorth').append(d);
  });
  $('playPile').innerHTML = ''; $('hand').innerHTML = '';
  if (!s.started) { $('drawCount').textContent = ''; $('turnTimer').textContent = ''; $('pot').textContent = ''; return $('msg').textContent = 'Waiting for players. Share the code.'; }
  $('drawCount').textContent = s.drawCount + (s.drawCount === 1 ? ' card left' : ' cards left');
  if (onlineClock) clearInterval(onlineClock);
  onlineClock = setInterval(() => {
    const remaining = Math.max(0, Math.ceil((s.deadline - Date.now()) / 1000));
    $('turnTimer').textContent = s.mine ? 'Your turn · ' + remaining + 's' : s.turn + ' · ' + remaining + 's';
  }, 200);
  const t = cardEl(s.top, false), key = s.top.s + s.top.n;
  if (key !== lastTop) { t.classList.add('land'); lastTop = key; sfx('play'); }
  if (s.called) t.insertAdjacentHTML('beforeend', '<span class="callout">' + SYM[s.called] + '</span>');
  $('playPile').append(t);
  $('pot').textContent = 'Pot: ' + s.pot.toLocaleString() + ' chips';
  $('msg').textContent = s.msg + (s.pending ? ' Pick ' + s.pending.count + ' or play a ' + s.pending.rank + '.' : '') + (s.mine ? ' Your turn.' : '');
  if (s.mine && !myTurn) sfx('turn');
  myTurn = s.mine;
  s.hand.forEach((c, i) => {
    const ok = s.playable.includes(i), el = cardEl(c, ok); el.style.setProperty('--i', i);
    el.classList.toggle('selected', selectedOnlineCard === i);
    if (ok) {
      el.tabIndex = 0; el.setAttribute('role', 'button');
      const go = () => {
        if (selectedOnlineCard !== i) {
          selectedOnlineCard = i;
          $('hand').querySelectorAll('.card').forEach((card, index) => card.classList.toggle('selected', index === i));
          tx({t: 'pause'});
          return;
        }
        selectedOnlineCard = null;
        if (c.s === 'whot') return pickSuit(x => tx({t: 'play', i, suit: x}));
        tx({t: 'play', i});
      };
      el.onclick = go; el.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') go(); };
    }
    $('hand').append(el);
  });
}
function pickSuit(done) {
  const b = $('suitBtns'); b.innerHTML = '';
  SUITS.forEach(x => { const k = document.createElement('button'); k.textContent = SYM[x]; k.setAttribute('aria-label', x);
    k.onclick = () => { $('suitDlg').close(); done(x); }; b.append(k); });
  $('suitDlg').showModal();
}
