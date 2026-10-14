/* ---------- SOUND (synthesised, no audio files needed) ---------- */
let ac = null, muted = localStorage.getItem('whotMute') === '1';
function tone(f, t0, d, type = 'sine', v = .15) {
  const o = ac.createOscillator(), g = ac.createGain(), t = ac.currentTime + t0;
  o.type = type; o.frequency.value = f;
  g.gain.setValueAtTime(v, t); g.gain.exponentialRampToValueAtTime(.001, t + d);
  o.connect(g); g.connect(ac.destination); o.start(t); o.stop(t + d);
}
function sfx(k) {
  if (muted) return;
  try {
    ac = ac || new (window.AudioContext || window.webkitAudioContext)();
    if (ac.state === 'suspended') ac.resume();
    ({play: () => tone(520, 0, .08, 'triangle'), draw: () => tone(300, 0, .1, 'square', .06),
      turn: () => [1046, 1318, 1568].forEach((f, i) => tone(f, i * .16, .48, 'sine', .12)),
      win: () => [523, 659, 784, 1047].forEach((f, i) => tone(f, i * .12, .25)),
      lose: () => [392, 330, 262].forEach((f, i) => tone(f, i * .15, .3, 'sawtooth', .07))})[k]();
  } catch (e) {}
}
const muteIcon = () => $('btnMute').textContent = muted ? '🔇' : '🔊';
$('btnMute').onclick = () => { muted = !muted; localStorage.setItem('whotMute', muted ? '1' : '0'); muteIcon(); sfx('play'); };
muteIcon();

/* ---------- LOGIN ---------- */
// Live Server on port 5500 stays offline-demo; the Node server handles accounts on its own origin.
const AUTH_API_BASE = API_BASE;
const authUrl = path => AUTH_API_BASE.replace(/\/+$/, '') + path;
async function sha(p) {
  if (!crypto.subtle) return btoa(p);
  const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('whot:' + p));
  return [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, '0')).join('');
}
const authErr = m => $('authErr').textContent = m;
function openAuth() {
  $('uPass').value = ''; $('uPass').type = 'password'; $('showPassword').checked = false;
  $('authDlg').showModal();
}
function guest() {
  sessionStorage.setItem('whotGuest', '1'); $('authDlg').close(); document.body.classList.remove('auth-required'); document.body.classList.add('guest');
  $('who').textContent = 'Guest'; $('btnOut').textContent = 'Log in';
  $('btnAccount').classList.add('hidden');
  wallet.load();
}
$('uGuest').onclick = guest;
function enter() {
  localStorage.removeItem('whotGuest'); sessionStorage.removeItem('whotGuest');
  document.body.classList.remove('auth-required', 'guest'); $('btnOut').textContent = 'Log out';
  $('btnAccount').classList.toggle('hidden', !AUTH_API_BASE);
  $('authDlg').close(); $('who').textContent = localStorage.getItem('whotUser'); wallet.load();
  if (typeof autoConnect === 'function') autoConnect();
}
async function logout() {
  const token = localStorage.getItem('whotToken');
  if (AUTH_API_BASE && token) {
    try { await fetch(authUrl('/api/logout'), {method: 'POST', headers: {Authorization: 'Bearer ' + token}}); } catch (e) {}
  }
  localStorage.removeItem('whotUser'); localStorage.removeItem('whotToken'); localStorage.removeItem('whotGuest');
  sessionStorage.removeItem('whotGuest'); location.reload();
}
async function submit(mode) {
  const u = $('uName').value.trim(), p = $('uPass').value; authErr('');
  if (!/^[A-Za-z0-9_]{3,16}$/.test(u)) return authErr('Username: 3 to 16 letters, numbers or _');
  const minPasswordLength = AUTH_API_BASE ? 8 : 6;
  if (p.length < minPasswordLength) return authErr('Password needs at least ' + minPasswordLength + ' characters');
  try {
    if (!AUTH_API_BASE) {
      const db = JSON.parse(localStorage.getItem('whotUsers') || '{}'), h = await sha(p);
      if (mode === 'reg') { if (db[u]) return authErr('That username is taken'); db[u] = h; localStorage.setItem('whotUsers', JSON.stringify(db)); }
      else if (db[u] !== h) return authErr('Wrong username or password');
      localStorage.setItem('whotUser', u);
    } else {
      const r = await fetch(authUrl('/api/' + (mode === 'reg' ? 'register' : 'login')),
        {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({name: u, password: p})});
      const d = await r.json(); if (!r.ok) return authErr(d.error || 'Something went wrong');
      localStorage.setItem('whotToken', d.token); localStorage.setItem('whotUser', d.name);
    }
    enter();
  } catch (e) { authErr('Could not reach the server.'); }
}
$('uLogin').onclick = () => submit('login');
$('uReg').onclick = () => submit('reg');
$('btnOut').onclick = logout;
$('showPassword').onchange = () => { $('uPass').type = $('showPassword').checked ? 'text' : 'password'; };
$('showRecoverPassword').onchange = () => { $('recoverPassword').type = $('showRecoverPassword').checked ? 'text' : 'password'; };
function setContactInput(typeId, labelId, inputId) {
  const type = $(typeId).value, label = $(labelId), input = $(inputId), email = type === 'email';
  label.firstChild.textContent = email ? 'Email address ' : 'Phone number in international format ';
  input.type = email ? 'email' : 'tel';
  input.autocomplete = email ? 'email' : 'tel';
  input.placeholder = email ? 'name@example.com' : '+15551234567';
}
$('contactType').onchange = () => setContactInput('contactType', 'contactLabel', 'contactValue');
$('recoverType').onchange = () => setContactInput('recoverType', 'recoverContactLabel', 'recoverContact');
async function openAccount() {
  $('contactMsg').textContent = '';
  $('contactCodeRow').classList.add('hidden'); $('contactVerify').classList.add('hidden');
  $('contactCode').value = ''; $('contactValue').value = '';
  $('accountDlg').showModal();
  try {
    const r = await fetch(authUrl('/api/account'), {headers: {Authorization: 'Bearer ' + localStorage.getItem('whotToken')}});
    const data = await r.json(); if (!r.ok) throw new Error(data.error || 'Could not load account');
    if (data.recoveryContact) {
      $('accountCurrent').textContent = 'Verified ' + data.recoveryType + ': ' + data.recoveryContact + '. Recovery is ready.';
      $('contactType').disabled = true; $('contactValue').disabled = true; $('contactSend').classList.add('hidden');
      $('contactCodeRow').classList.add('hidden'); $('contactVerify').classList.add('hidden');
    } else {
      $('accountCurrent').textContent = 'Add one email or phone number. Verify it to enable recovery and receive 50 chips.';
      $('contactType').disabled = false; $('contactValue').disabled = false; $('contactSend').classList.remove('hidden');
      setContactInput('contactType', 'contactLabel', 'contactValue');
    }
  } catch (error) { $('accountCurrent').textContent = error.message; }
}
$('btnAccount').onclick = openAccount;
$('accountClose').onclick = () => $('accountDlg').close();
$('contactSend').onclick = async () => {
  $('contactMsg').textContent = '';
  try {
    const response = await fetch(authUrl('/api/contact/request'), {method: 'POST',
      headers: {'Content-Type': 'application/json', Authorization: 'Bearer ' + localStorage.getItem('whotToken')},
      body: JSON.stringify({type: $('contactType').value, contact: $('contactValue').value.trim()})});
    const data = await response.json(); if (!response.ok) throw new Error(data.error || 'Could not send code');
    $('contactCodeRow').classList.remove('hidden'); $('contactVerify').classList.remove('hidden');
    $('contactMsg').textContent = data.devCode ? 'Development code: ' + data.devCode : 'Check your email or phone for the code.';
    if (data.devCode) $('contactCode').value = data.devCode;
  } catch (error) { $('contactMsg').textContent = error.message; }
};
$('contactVerify').onclick = async () => {
  $('contactMsg').textContent = '';
  try {
    const response = await fetch(authUrl('/api/contact/verify'), {method: 'POST',
      headers: {'Content-Type': 'application/json', Authorization: 'Bearer ' + localStorage.getItem('whotToken')},
      body: JSON.stringify({code: $('contactCode').value.trim()})});
    const data = await response.json(); if (!response.ok) throw new Error(data.error || 'Could not verify contact');
    wallet.chips = data.chips; show();
    $('accountCurrent').textContent = 'Verified ' + data.recoveryType + ': ' + data.recoveryContact + '.';
    $('contactMsg').textContent = 'Contact verified. ' + data.bonus + ' chips added.';
    $('contactType').disabled = true; $('contactValue').disabled = true; $('contactSend').classList.add('hidden');
    $('contactCodeRow').classList.add('hidden'); $('contactVerify').classList.add('hidden');
  } catch (error) { $('contactMsg').textContent = error.message; }
};
$('uRecover').onclick = () => {
  $('authDlg').close(); $('recoverMsg').textContent = ''; $('recoverResetFields').classList.add('hidden');
  $('recoverCode').value = ''; $('recoverPassword').value = ''; $('recoverPassword').type = 'password';
  $('showRecoverPassword').checked = false; $('recoverDlg').showModal();
};
$('recoverClose').onclick = () => { $('recoverDlg').close(); $('authDlg').showModal(); };
$('recoverSend').onclick = async () => {
  $('recoverMsg').textContent = '';
  try {
    const response = await fetch(authUrl('/api/recovery/request'), {method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({type: $('recoverType').value, contact: $('recoverContact').value.trim()})});
    const data = await response.json(); if (!response.ok) throw new Error(data.error || 'Could not request recovery');
    $('recoverResetFields').classList.remove('hidden');
    $('recoverMsg').textContent = data.devCode
      ? data.message + ' Development code: ' + data.devCode
      : data.message;
    if (data.devCode) $('recoverCode').value = data.devCode;
  } catch (error) { $('recoverMsg').textContent = error.message; }
};
$('recoverSubmit').onclick = async () => {
  $('recoverMsg').textContent = '';
  try {
    const response = await fetch(authUrl('/api/recovery/reset'), {method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({type: $('recoverType').value, contact: $('recoverContact').value.trim(),
        code: $('recoverCode').value.trim(), password: $('recoverPassword').value})});
    const data = await response.json(); if (!response.ok) throw new Error(data.error || 'Could not reset password');
    $('recoverMsg').textContent = data.message;
  } catch (error) { $('recoverMsg').textContent = error.message; }
};
$('authDlg').addEventListener('cancel', e => e.preventDefault());
async function boot() {
  localStorage.removeItem('whotGuest');
  if (sessionStorage.getItem('whotGuest')) return guest();
  const token = localStorage.getItem('whotToken');
  if (localStorage.getItem('whotUser') && (!AUTH_API_BASE || token)) {
    if (!AUTH_API_BASE) return enter();
    try {
      const response = await fetch(authUrl('/api/account'), {headers: {Authorization: 'Bearer ' + token}});
      if (response.ok) return enter();
    } catch (error) {}
  }
  localStorage.removeItem('whotUser'); localStorage.removeItem('whotToken');
  document.body.classList.add('auth-required');
  openAuth();
}
if (localStorage.getItem('whotAge')) boot(); else $('ageYes').addEventListener('click', boot);
