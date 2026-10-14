/* ---------- WALLET / SERVER LAYER ----------
 * IMPORTANT: real money must never be handled in browser code. Anyone can edit JS in
 * their browser. For real deposits, bets and withdrawals, set API_BASE to your backend
 * and have the SERVER own the balance, shuffle, deal, validate moves and settle pots.
 * Expected endpoints (you build these):
 *   GET  /api/balance                -> {chips}
 *   POST /api/deposit  {amount}      -> {checkoutUrl}  (Paystack / Flutterwave hosted checkout)
 *   POST /api/withdraw {amount,acct} -> {ok}           (bank transfer after KYC checks)
 *   POST /api/stake    {stake,n}     -> {ok}           (locks stake before a game)
 *   POST /api/settle   {winner}      -> {chips}        (server pays pot minus fee)
 * Until API_BASE is set, everything runs in DEMO mode with play chips.
 */
// Offline demo only when the page is opened as a file or from VS Code Live Server (port 5500).
// On any real host (https://yourdomain.com) the Node server serves the page, so the API lives on the same origin.
const API_BASE = (location.protocol === 'file:' || ['5500', '5501'].includes(location.port)) ? '' : location.origin;
const DEMO = !API_BASE;
const RATE = 1; // chips per naira
const wallet = {
  chips: 0,
  async load() {
    if (DEMO || document.body.classList.contains('guest')) this.chips = +(localStorage.getItem('whotChips') ?? 1000);
    else {
      const token = localStorage.getItem('whotToken');
      const r = await fetch(API_BASE + '/api/balance', {headers: {Authorization: 'Bearer ' + token}});
      if (!r.ok) throw new Error('Could not load account balance');
      this.chips = (await r.json()).chips;
    }
    show();
  },
  save() { if (DEMO || document.body.classList.contains('guest')) localStorage.setItem('whotChips', this.chips); show(); },
  async post(path, body) {
    const r = await fetch(API_BASE + path, {method: 'POST',
      headers: {'Content-Type': 'application/json', Authorization: 'Bearer ' + localStorage.getItem('whotToken')},
      body: JSON.stringify(body)});
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'Request failed');
    return data;
  }
};
const $ = id => document.getElementById(id);
const show = () => $('bal').textContent = wallet.chips.toLocaleString();

/* ---------- DECK (pack composition from the rules) ---------- */
const SYM = {circle: '●', triangle: '▲', cross: '✚', square: '■', star: '★', whot: 'W'};
const SUITS = ['circle', 'triangle', 'cross', 'square', 'star'];
const RANKS = {
  circle: [1,2,3,4,5,7,8,10,11,12,13,14], triangle: [1,2,3,4,5,7,8,10,11,12,13,14],
  cross: [1,2,3,5,7,10,11,13,14], square: [1,2,3,5,7,10,11,13,14], star: [1,2,3,4,5,7,8]
};
function newDeck() {
  const d = [];
  SUITS.forEach(s => RANKS[s].forEach(n => d.push({s, n})));
  for (let i = 0; i < 5; i++) d.push({s: 'whot', n: 20});
  for (let i = d.length - 1; i > 0; i--) { const j = Math.random() * (i + 1) | 0; [d[i], d[j]] = [d[j], d[i]]; }
  return d;
}
const points = c => c.s === 'whot' ? 20 : c.s === 'star' ? c.n * 2 : c.n;
function scoreSheets(players) {
  return players.map(player => {
    const cards = player.hand.map(card => {
      const value = points(card);
      return {label: card.s === 'whot' ? 'Whot (20)' : card.s + ' ' + card.n,
        calculation: card.s === 'star' ? card.n + ' x 2 = ' + value : String(value), value};
    });
    return {name: player.name, cards, total: cards.reduce((sum, card) => sum + card.value, 0)};
  });
}
function renderScoreBreakdown(scores) {
  const container = $('endBreakdown');
  container.replaceChildren();
  container.classList.toggle('hidden', !scores || !scores.length);
  if (!scores || !scores.length) return;
  scores.forEach(score => {
    const player = document.createElement('section'); player.className = 'score-player';
    const heading = document.createElement('h3'); heading.textContent = score.name; player.append(heading);
    score.cards.forEach(card => {
      const row = document.createElement('div'); row.className = 'score-line';
      const label = document.createElement('span'); label.textContent = card.label;
      const calculation = document.createElement('span'); calculation.textContent = card.calculation;
      row.append(label, calculation); player.append(row);
    });
    const total = document.createElement('div'); total.className = 'score-total';
    const values = document.createElement('span'); values.textContent = 'Sum';
    const sum = document.createElement('span'); sum.textContent = (score.cards.length ? score.cards.map(card => card.value).join(' + ') : '0') + ' = ' + score.total + ' points';
    total.append(values, sum); player.append(total); container.append(player);
  });
}

/* ---------- GAME STATE ---------- */
let G = null;
let turnClock = null;
let turnDeadline = 0, selectionPause = null, delayedDraw = null, selectedPracticeCard = null;
let speechGeneration = 0;
const topCard = () => G.pile[G.pile.length - 1];
const reqSuit = () => G.called || topCard().s;
function announce(text, interrupt = false) {
  if (!('speechSynthesis' in window)) return;
  if (interrupt) { speechGeneration++; speechSynthesis.cancel(); }
  const generation = speechGeneration;
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = 'en-NG'; utterance.rate = .94; utterance.pitch = 1.12;
  const selectVoice = () => {
    if (generation !== speechGeneration) return;
    const voices = speechSynthesis.getVoices();
    utterance.voice = voices.find(v => /female|samantha|zira|victoria|hazel|susan|aria|jenny/i.test(v.name))
      || voices.find(v => v.lang.startsWith('en')) || null;
    speechSynthesis.speak(utterance);
  };
  if (speechSynthesis.getVoices().length) selectVoice();
  else speechSynthesis.addEventListener('voiceschanged', selectVoice, {once: true});
}
function stopAnnouncements() {
  if (!('speechSynthesis' in window)) return;
  speechGeneration++; speechSynthesis.cancel();
}
function clearTurnClock() {
  if (turnClock) clearInterval(turnClock);
  if (selectionPause) clearTimeout(selectionPause);
  if (delayedDraw) clearTimeout(delayedDraw);
  turnClock = null; selectionPause = null; delayedDraw = null; turnDeadline = 0;
  selectedPracticeCard = null; $('turnTimer').textContent = '';
}
function runTurnClock(player) {
  if (turnClock) clearInterval(turnClock);
  turnClock = setInterval(() => {
    const remaining = Math.max(0, Math.ceil((turnDeadline - Date.now()) / 1000));
    $('turnTimer').textContent = 'Your turn · ' + remaining + 's';
    if (!remaining) queueDrawTurn(player, 'Time is up. A card will be drawn in 3 seconds.');
  }, 200);
}
function pauseTurnForSelection() {
  if (!turnClock || selectionPause) return;
  clearInterval(turnClock); turnClock = null; turnDeadline += 3000;
  $('turnTimer').textContent = 'Timer paused · 3s';
  selectionPause = setTimeout(() => {
    selectionPause = null;
    if (G && !G.over && G.players[G.turn].human) runTurnClock(G.players[G.turn]);
  }, 3000);
}
function queueDrawTurn(player, message) {
  if (delayedDraw || !G || G.over || G.players[G.turn] !== player) return;
  if (turnClock) clearInterval(turnClock);
    if (selectionPause) clearTimeout(selectionPause);
    turnClock = null; selectionPause = null; turnDeadline = 0;
  $('turnTimer').textContent = 'Drawing in 3s';
  if (message) say(message);
  delayedDraw = setTimeout(() => {
    delayedDraw = null;
    if (G && !G.over && G.players[G.turn] === player) drawTurn(player);
  }, 3000);
}

function startGame() {
  const stake = 0, opponents = +$('opps').value, n = opponents + 1; // practice games are free: no chips move
  const deck = newDeck();
  const players = Array.from({length: n}, (_, i) => ({name: i ? 'Player ' + (i + 1) : 'You', human: !i, hand: []}));
  for (let r = 0; r < 6; r++) players.forEach(p => p.hand.push(deck.pop()));
  let first = deck.pop();
  while (first.s === 'whot') { deck.unshift(first); first = deck.pop(); }
  G = {players, draw: deck, pile: [first], turn: 1 % n, called: null, pending: null, stake, pot: stake * n, over: false, busy: false};
  $('lobby').classList.add('hidden'); $('table').classList.remove('hidden');
  say('Cards dealt. ' + players[G.turn].name + (G.turn ? ' starts.' : ' start.'));
  render(); next();
}

function canPlay(c) {
  if (G.pending) return c.n === G.pending.rank;
  return c.s === 'whot' || c.s === reqSuit() || (topCard().s !== 'whot' && c.n === topCard().n);
}
function refill() {
  return G.draw.length > 0;
}
function drawCards(p, k) {
  for (let i = 0; i < k && refill(); i++) p.hand.push(G.draw.pop());
  if (!G.draw.length && G && !G.over) finishByPoints();
}
const advance = (steps = 1) => G.turn = (G.turn + steps) % G.players.length;
function say(t) { $('msg').textContent = t; }

function play(p, card, suit) {
  clearTurnClock();
  const continuing = G.continueAfterAction;
  G.continueAfterAction = false;
  if (continuing && !(card.s === 'whot' || [1, 2, 8, 14].includes(card.n))) announce('Continue.');
  p.hand.splice(p.hand.indexOf(card), 1);
  G.pile.push(card); G.called = null;
  let msg = p.name + ' played ' + SYM[card.s] + ' ' + card.n + '.';
  if (!p.hand.length) return finish(p);
  if (card.s === 'whot') { G.called = suit; msg += ' Shape called: ' + SYM[suit] + '.'; announce('I need ' + suit + '.'); advance(); }
  else if (card.n === 1) {
    announce('Hold on.');
    G.continueAfterAction = true;
    msg += ' Hold on! Play another legal card or draw one card.';
  }
  else if (card.n === 2) {
    announce(G.pending ? 'Defended.' : 'Pick 2.');
    G.pending = {rank: 2, count: 2};
    msg += ' Next player picks ' + G.pending.count + ' or plays another 2.'; advance();
  } else if (card.n === 8) {
    announce('Suspension.');
    msg += ' Suspension! ' + G.players[(G.turn + 1) % G.players.length].name + ' skips a turn.';
    advance(2);
  } else if (card.n === 14) {
    announce('General Market.');
    for (let step = 1; step < G.players.length; step++) {
      drawCards(G.players[(G.turn + step) % G.players.length], 1);
      if (G.over) return;
    }
    G.continueAfterAction = true;
    msg += ' General market: everyone else draws one in turn order. Play another card or draw.';
  } else advance();
  if (p.hand.length === 1) announce('Last card!');
  say(msg); render(); next();
}
function drawTurn(p) {
  clearTurnClock();
  G.continueAfterAction = false;
  const count = G.pending ? G.pending.count : 1;
  drawCards(p, count);
  if (G.over) return;
  say(p.name + ' picked ' + count + '.'); G.pending = null;
  advance(); render(); next();
}
function bestSuit(p) {
  const t = {}; p.hand.forEach(c => { if (c.s !== 'whot') t[c.s] = (t[c.s] || 0) + 1; });
  return Object.keys(t).sort((a, b) => t[b] - t[a])[0] || SUITS[Math.random() * 5 | 0];
}
function next() {
  if (G.over) return;
  const p = G.players[G.turn];
  if (p.human) {
    if (typeof sfx === 'function') sfx('turn');
    clearTurnClock();
    turnDeadline = Date.now() + 8000;
    runTurnClock(p);
    return;
  }
  clearTurnClock();
  G.busy = true;
  setTimeout(() => {
    G.busy = false;
    const opts = p.hand.filter(canPlay);
    if (!opts.length) return drawTurn(p);
    // prefer non-whot, save whot cards; prefer pick cards to hurt opponents
    opts.sort((a, b) => (a.s === 'whot') - (b.s === 'whot') || points(b) - points(a));
    const c = opts[0];
    play(p, c, c.s === 'whot' ? bestSuit(p) : null);
  }, 3000);
}

function finish(winner) {
  finishGame(winner, false);
}
function finishByPoints() {
  const scores = scoreSheets(G.players), totals = scores.map(score => score.total);
  const lowest = Math.min(...totals);
  const winners = G.players.filter((p, i) => totals[i] === lowest);
  finishGame(winners, true, scores);
}
function finishGame(winnerOrWinners, deckEnded, scores) {
  const winners = Array.isArray(winnerOrWinners) ? winnerOrWinners : [winnerOrWinners];
  G.over = true; render();
  const youWon = winners.some(p => p.human), winner = winners[0];
  clearTurnClock(); announce('Check up! ' + (youWon ? 'You win!' : winner.name + ' wins!'), true);
  const summary = deckEnded ? scores.map(score => score.name + ': ' + score.total + ' points').join(', ') : '';
  $('endTitle').textContent = deckEnded
    ? (youWon ? 'You win on points!' : winner.name + ' wins on points!')
    : (winner.human ? 'You won!' : winner.name + ' wins');
  $('endText').textContent = (deckEnded ? 'Draw pile empty. ' + summary + '. ' : '')
    + (winners.length > 1 ? 'Tie between the lowest scores. ' : '')
    + 'Practice game: no chips were staked.';
  renderScoreBreakdown(deckEnded ? scores : null);
  $('endDlg').showModal();
}

/* ---------- RENDER ---------- */
function cardEl(c, ok) {
  const d = document.createElement('div');
  d.className = 'card' + (c.s === 'whot' ? ' whot' : '') + (ok ? ' ok' : '') + (c === selectedPracticeCard ? ' selected' : '');
  const rank = c.s === 'whot' ? 20 : c.n;
  d.innerHTML = '<span class="n top-n">' + rank + '</span><span class="s">' + (c.s === 'whot' ? 'Whot' : SYM[c.s]) + '</span><span class="n bottom-n">' + rank + '</span>';
  return d;
}
function render() {
  if (selectedPracticeCard && !G.players[0].hand.includes(selectedPracticeCard)) selectedPracticeCard = null;
  ['seatNorth', 'seatWest', 'seatEast', 'opponents'].forEach(id => $(id).replaceChildren());
  const compass = ['opponents', 'seatWest', 'seatNorth', 'seatEast'];
  const directions = ['S', 'W', 'N', 'E'];
  G.players.forEach((p, i) => {
    const d = document.createElement('div');
    d.className = 'opp' + (G.players[G.turn] === p && !G.over ? ' turn' : '') + (i === 0 ? ' self' : '');
    const seat = document.createElement('span'); seat.className = 'seat-direction'; seat.textContent = directions[i] || 'N';
    d.append(seat, document.createTextNode((i === 0 ? 'You' : p.name) + ' · ' + p.hand.length + (p.hand.length === 1 ? ' card' : ' cards')));
    if (p.hand.length === 1) {
      const badge = document.createElement('span'); badge.className = 'last-card'; badge.textContent = 'LAST CARD!'; d.append(badge);
    }
    $(compass[i] || 'seatNorth').append(d);
  });
  $('drawCount').textContent = G.draw.length + (G.draw.length === 1 ? ' card left' : ' cards left');
  $('playPile').innerHTML = '';
  const t = cardEl(topCard(), false);
  if (G.called) t.insertAdjacentHTML('beforeend', '<span class="callout">' + SYM[G.called] + '</span>');
  $('playPile').append(t);
  $('pot').textContent = 'Practice game · no chips at stake';
  const myTurn = G.players[G.turn].human && !G.over;
  $('hand').innerHTML = '';
  G.players[0].hand.forEach(c => {
    const ok = myTurn && canPlay(c), el = cardEl(c, ok);
    if (ok) {
      el.tabIndex = 0; el.setAttribute('role', 'button');
      const go = () => selectPracticeCard(c);
      el.onclick = go; el.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') go(); };
    }
    $('hand').append(el);
  });
  if (myTurn && !G.msgSet) say($('msg').textContent);
}
function onPlay(c) {
  if (c.s !== 'whot') return play(G.players[0], c);
  const box = $('suitBtns'); box.innerHTML = '';
  SUITS.forEach(s => { const b = document.createElement('button'); b.textContent = SYM[s]; b.setAttribute('aria-label', s);
    b.onclick = () => { $('suitDlg').close(); play(G.players[0], c, s); }; box.append(b); });
  $('suitDlg').showModal();
}
function selectPracticeCard(card) {
  if (!G || G.over || G.players[G.turn] !== G.players[0]) return;
  if (selectedPracticeCard === card) { selectedPracticeCard = null; return onPlay(card); }
  selectedPracticeCard = card; render(); pauseTurnForSelection();
}
$('drawPile').onclick = () => { if (G && !G.over && G.players[G.turn].human) queueDrawTurn(G.players[0], 'Drawing a card in 3 seconds.'); };
$('drawPile').onkeydown = e => { if (e.key === 'Enter') $('drawPile').click(); };

/* ---------- LOBBY, AGE GATE, PAYMENTS ---------- */
$('btnDeal').onclick = startGame;
$('btnAgain').onclick = () => { stopAnnouncements(); $('endDlg').close(); $('table').classList.add('hidden'); $('lobby').classList.remove('hidden'); };
$('endDlg').addEventListener('cancel', stopAnnouncements);
$('ageYes').onclick = () => { localStorage.setItem('whotAge', '1'); $('ageDlg').close(); };
$('ageNo').onclick = () => location.href = 'https://www.google.com';
$('ageDlg').addEventListener('cancel', e => e.preventDefault());
if (localStorage.getItem('whotAge')) $('ageDlg').close();

let payMode = 'buy';
function openPay(mode) {
  payMode = mode;
  $('payTitle').textContent = mode === 'buy' ? 'Buy chips' : 'Withdraw winnings';
  $('acctRow').classList.toggle('hidden', mode === 'buy');
  $('bankRow').classList.toggle('hidden', mode !== 'cash');
  $('bank').value = ''; $('acct').value = '';
  $('payNote').textContent = mode === 'cash'
    ? 'Withdrawals are not enabled yet. Chips are not naira; connecting a licensed payout provider and account-name verification is required.'
    : DEMO ? 'Demo mode: no real money moves.' : 'Payment checkout is not enabled yet.';
  $('payDlg').showModal();
}
$('btnBuy').onclick = () => openPay('buy');
$('btnCash').onclick = () => openPay('cash');
$('payX').onclick = () => $('payDlg').close();
$('payGo').onclick = async () => {
  const amt = +$('payAmt').value;
  if (!(amt >= 100)) return alert('Minimum is ₦100.');
  try {
    if (payMode === 'buy') {
      if (DEMO) { wallet.chips += amt * RATE; wallet.save(); }
      else { const r = await wallet.post('/api/deposit', {amount: amt}); location.href = r.checkoutUrl; return; }
    } else {
      if (amt * RATE > wallet.chips) return alert('You do not have that many chips.');
      if (!$('bank').value) return alert('Select a Nigerian bank.');
      if (!/^\d{10}$/.test($('acct').value)) return alert('Enter a 10-digit account number.');
      if (DEMO) return alert('Withdrawals are disabled in demo mode. Chips are not naira.');
      else { await wallet.post('/api/withdraw', {amount: amt, bank: $('bank').value, acct: $('acct').value}); await wallet.load(); }
    }
    $('payDlg').close();
  } catch (e) { alert('Something went wrong. Please try again.'); }
};

if (DEMO || localStorage.getItem('whotToken')) wallet.load().catch(() => { wallet.chips = 0; show(); });
