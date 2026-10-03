'use strict';
/* =====================================================================
   Pay Buddy — klient. Wklej swoje dane z Supabase (Project Settings → API).
   ===================================================================== */
const SUPABASE_URL = 'https://tpylpqnlaelosrwaeysz.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_KCQJs6nW8aKBFBxycdmOsg_H2UQQ6Yu';

const { parseMoney, fmt, splitEqual, sharesFromItems, computeTransfers, esc, hue } = window.PB;
const CONFIGURED = !SUPABASE_URL.includes('TWOJ-PROJEKT') && !SUPABASE_ANON_KEY.includes('TWOJ_ANON');
// Zabezpieczenie: ucina /rest/v1, /auth/v1 itp. oraz ukośnik i spacje na końcu adresu
const BASE_URL = SUPABASE_URL.trim().replace(/\/(rest|auth|storage|functions|realtime)\/v1.*$/i, '').replace(/\/+$/, '');
console.log('[Pay Buddy] adres Supabase:', BASE_URL);
const $ = (s) => document.querySelector(s);

let sb = null;
const S = {
  user: null, profile: null, view: 'boot', authMode: 'login', pendingConfirm: null,
  recovering: false, gid: null, tab: 'expenses', pickIcon: null, pickColor: null,
  data: { groups: [], invites: [], pending: [], group: null, members: [], expenses: [], balances: [], settlements: [] },
};
const profCache = {};
let F = null;            // formularz nowego wydatku
let SCAN = null;         // stan skanowania paragonu
let confirmResolve = null;

/* ---------- ikony ---------- */
const ic = (d, s = 22) => `<svg viewBox="0 0 24 24" width="${s}" height="${s}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
const I = {
  back: ic('<path d="M15 18l-6-6 6-6"/>'),
  plus: ic('<path d="M12 5v14M5 12h14"/>', 26),
  refresh: ic('<path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/>'),
  camera: ic('<path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/>', 20),
  wallet: ic('<path d="M3 7h16a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M3 7l2-3h12"/><circle cx="16.5" cy="13.5" r="1"/>'),
  swap: ic('<path d="M7 4L3 8l4 4M3 8h14M17 20l4-4-4-4M21 16H7"/>'),
  users: ic('<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><path d="M16 4.5a3.5 3.5 0 0 1 0 7M18 14.5a6.5 6.5 0 0 1 3.5 5.5"/>'),
  cog: ic('<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1L7 17M17 7l2.1-2.1"/>'),
  list: ic('<path d="M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01"/>'),
};

/* ---------- pomocnicze ---------- */
let toastT;
function toast(msg, type) {
  const t = $('#toast'); t.textContent = msg; t.className = 'show ' + (type || 'ok');
  clearTimeout(toastT); toastT = setTimeout(() => { t.className = ''; }, 3600);
}
function errMsg(e) {
  const m = (e && e.message) || String(e);
  if (/Invalid login credentials/i.test(m)) return 'Nieprawidłowy e-mail lub hasło.';
  if (/Email not confirmed/i.test(m)) return 'Najpierw potwierdź adres e-mail (link w skrzynce).';
  if (/already registered|already been registered/i.test(m)) return 'Ten e-mail jest już zarejestrowany.';
  if (/rate limit|too many/i.test(m)) return 'Za dużo prób — poczekaj chwilę.';
  if (/group_members_pkey|duplicate key.*group_members/i.test(m)) return 'Ta osoba jest już w grupie lub ma zaproszenie.';
  if (/profiles_username_key|duplicate key.*username/i.test(m)) return 'Ta nazwa użytkownika jest zajęta.';
  if (/Failed to fetch|NetworkError/i.test(m)) return 'Brak połączenia z serwerem.';
  return m;
}
async function fnError(error) {
  try { const j = await error.context.json(); if (j && j.error) return new Error(j.error); } catch (_) {}
  return new Error(error.message || 'Błąd funkcji serwera.');
}
async function rpc(name, args) {
  const { data, error } = await sb.rpc(name, args || {});
  if (error) throw error;
  return data;
}
const uuid = () => (crypto.randomUUID ? crypto.randomUUID()
  : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => { const r = crypto.getRandomValues(new Uint8Array(1))[0] & 15; return (c === 'x' ? r : (r & 3) | 8).toString(16); }));
const fmtDate = (x) => new Date(x).toLocaleDateString('pl-PL', { day: 'numeric', month: 'short' });
const me = () => S.user.id;
const hasPremium = (p) => !!(p && p.is_premium && (!p.premium_until || new Date(p.premium_until) > new Date()));

async function loadProfiles(ids) {
  const need = [...new Set(ids)].filter((i) => i && !profCache[i]);
  if (!need.length) return;
  const { data } = await sb.from('profiles').select('id,username,display_name,avatar_path,is_premium,premium_until,bank_account,blik_phone').in('id', need);
  (data || []).forEach((p) => { profCache[p.id] = p; });
}
const P = (id) => profCache[id] || { id, username: '?', display_name: 'Nieznany' };
const nameOf = (id) => (id === S.user.id ? 'Ty' : (P(id).display_name || P(id).username));

function avatar(id, size) {
  size = size || 40; const p = P(id); const name = p.display_name || p.username || '?';
  if (p.avatar_path) {
    const [path, q] = p.avatar_path.split('?');
    const url = sb.storage.from('avatars').getPublicUrl(path).data.publicUrl + (q ? '?' + q : '');
    return `<img class="avatar" style="width:${size}px;height:${size}px" src="${esc(url)}" alt="">`;
  }
  return `<span class="avatar" style="width:${size}px;height:${size}px;font-size:${Math.round(size * 0.42)}px;background:hsl(${hue(p.username)},55%,42%)">${esc(name.trim().charAt(0).toUpperCase())}</span>`;
}
const balHTML = (c) => c > 0 ? `<span class="pos">+${fmt(c)}</span>` : c < 0 ? `<span class="neg">${fmt(c)}</span>` : '<span class="muted">rozliczone</span>';

// Własne ikony SVG (outline, 1.8px, dziedziczą kolor przez currentColor) —
// zamiast systemowych emoji, żeby wyglądały tak samo na każdym urządzeniu.
const SVG_A = 'fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"';
const COVER_ICONS = [
  `<svg viewBox="0 0 24 24" ${SVG_A}><path d="M3 12l9-7 9 7"/><path d="M5 10v9h14v-9"/><path d="M10 19v-5h4v5"/></svg>`, // dom
  `<svg viewBox="0 0 24 24" ${SVG_A}><path d="M3 18l6-11 4 6 2-3 6 8z"/></svg>`, // góry/wyjazd
  `<svg viewBox="0 0 24 24" ${SVG_A}><path d="M2 12l7-2.5L12 3l1 6.5L21 8l-6 5 2 7-5-3.5L7 20l1-7z"/></svg>`, // samolot papierowy
  `<svg viewBox="0 0 24 24" ${SVG_A}><ellipse cx="12" cy="12" rx="9" ry="6"/><path d="M3 12h18"/></svg>`, // talerz/jedzenie
  `<svg viewBox="0 0 24 24" ${SVG_A}><path d="M6 7h12l1 13H5z"/><path d="M9 7V5a3 3 0 0 1 6 0v2"/></svg>`, // torba zakupy
  `<svg viewBox="0 0 24 24" ${SVG_A}><path d="M7 3v7a5 5 0 0 0 10 0V3"/><path d="M12 15v6M8 21h8"/></svg>`, // kieliszek/impreza
  `<svg viewBox="0 0 24 24" ${SVG_A}><rect x="4" y="9" width="16" height="7" rx="1.5"/><circle cx="7.5" cy="19" r="1.6"/><circle cx="16.5" cy="19" r="1.6"/><path d="M6 9l2-4h8l2 4"/></svg>`, // samochód
  `<svg viewBox="0 0 24 24" ${SVG_A}><path d="M3 21l9-16 9 16z"/><path d="M9 21v-6h6v6"/></svg>`, // namiot/kemping
  `<svg viewBox="0 0 24 24" ${SVG_A}><rect x="3" y="5" width="18" height="12" rx="2"/><path d="M9 21h6M12 17v4"/><path d="M8 13l3-3 2 2 3-4"/></svg>`, // ekran/film
  `<svg viewBox="0 0 24 24" ${SVG_A}><path d="M5 9h11v6a4 4 0 0 1-4 4H9a4 4 0 0 1-4-4z"/><path d="M16 11h2a2 2 0 0 1 0 4h-2"/><path d="M8 3v3M12 3v3"/></svg>`, // kubek/napoje
  `<svg viewBox="0 0 24 24" ${SVG_A}><path d="M12 3l2.2 4.8L19 9l-3.6 3.6.9 4.9L12 15.2 7.7 17.5l.9-4.9L5 9l4.8-1.2z"/></svg>`, // gwiazda/uczelnia
  `<svg viewBox="0 0 24 24" ${SVG_A}><rect x="3" y="8" width="18" height="11" rx="2"/><path d="M8 8V6a3 3 0 0 1 3-3h2a3 3 0 0 1 3 3v2"/><path d="M3 13h18"/></svg>`, // walizka/praca
  `<svg viewBox="0 0 24 24" ${SVG_A}><path d="M12 19s-7-4.5-7-9.5A4 4 0 0 1 12 7a4 4 0 0 1 7 2.5C19 14.5 12 19 12 19z"/></svg>`, // serce/zwierzak
  `<svg viewBox="0 0 24 24" ${SVG_A}><circle cx="8" cy="9" r="4.2"/><circle cx="16" cy="15" r="4.2"/></svg>`, // monety/pieniądze
  `<svg viewBox="0 0 24 24" ${SVG_A}><circle cx="6" cy="17" r="3.5"/><circle cx="18" cy="17" r="3.5"/><path d="M6 17l4-9h4M10 17h8l-3-6h-6"/></svg>`, // rower/aktywność
  `<svg viewBox="0 0 24 24" ${SVG_A}><rect x="3" y="6" width="18" height="13" rx="2"/><path d="M3 10.5h18"/><path d="M6.5 14.5h4"/></svg>`, // karta płatnicza
];
const COVER_PALETTES = [
  ['#1e3a5f', '#4a6fa5'], ['#0f766e', '#2dd4bf'], ['#7c2d12', '#ea580c'],
  ['#581c87', '#a855f7'], ['#134e4a', '#14b8a6'], ['#1e1b4b', '#6366f1'],
  ['#78350f', '#d97706'], ['#831843', '#db2777'], ['#14532d', '#22c55e'],
  ['#3f3f46', '#71717a'],
];
function groupCover(id, iconIdx, colorIdx) {
  const h = Math.abs(hue(id || ''));
  const ci = (colorIdx != null) ? colorIdx : (h % COVER_PALETTES.length);
  const [c1, c2] = COVER_PALETTES[ci % COVER_PALETTES.length];
  const ii = (iconIdx != null) ? iconIdx : Math.floor(h / 7) % COVER_ICONS.length;
  const icon = COVER_ICONS[ii % COVER_ICONS.length];
  return { c1, c2, icon };
}
function coverStyle(id) { const c = groupCover(id); return `background:linear-gradient(135deg,${c.c1},${c.c2})`; }

function resizeImage(file, max, quality, square) {
  return new Promise((res, rej) => {
    const img = new Image(); const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      const c = document.createElement('canvas'); const ctx = c.getContext('2d');
      if (square) {
        const s = Math.min(img.width, img.height); c.width = c.height = max;
        ctx.drawImage(img, (img.width - s) / 2, (img.height - s) / 2, s, s, 0, 0, max, max);
      } else {
        const k = Math.min(1, max / Math.max(img.width, img.height));
        c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
        ctx.drawImage(img, 0, 0, c.width, c.height);
      }
      c.toBlob((b) => (b ? res(b) : rej(new Error('Nie udało się przetworzyć zdjęcia.'))), 'image/jpeg', quality);
    };
    img.onerror = () => rej(new Error('Nie udało się wczytać zdjęcia.'));
    img.src = url;
  });
}
const blobToB64 = (b) => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1]); r.onerror = rej; r.readAsDataURL(b); });

/* ---------- modale ---------- */
function openModal(html) {
  $('#modal-root').innerHTML = `<div class="overlay" data-act="modalBg"><div class="sheet" role="dialog">${html}</div></div>`;
  document.body.classList.add('noscroll');
}
function closeModal() { $('#modal-root').innerHTML = ''; document.body.classList.remove('noscroll'); }
function confirmBox(text, okLabel, danger) {
  return new Promise((res) => {
    confirmResolve = res;
    openModal(`<p class="modal-text">${esc(text)}</p><div class="row"><button class="btn ghost" data-act="cfNo">Anuluj</button><button class="btn ${danger ? 'danger' : ''}" data-act="cfYes">${esc(okLabel || 'Tak')}</button></div>`);
  });
}

/* =====================================================================
   ŁADOWANIE DANYCH
   ===================================================================== */
async function loadMe() {
  const { data, error } = await sb.from('profiles').select('id,username,display_name,avatar_path,is_premium,premium_until,bank_account,blik_phone').eq('id', me()).single();
  if (error) throw new Error('Nie znaleziono profilu. Uruchom schema.sql w Supabase.');
  S.profile = data; profCache[data.id] = data;
}

async function loadHome() {
  const uid = me();
  const [gm, inv, sh] = await Promise.all([
    sb.from('group_members').select('group_id,role,status,groups(id,name,status,icon_idx,color_idx)').eq('user_id', uid).in('status', ['active', 'leaving']),
    sb.from('group_members').select('group_id,invited_by,groups(id,name)').eq('user_id', uid).eq('status', 'invited'),
    sb.from('expense_shares').select('expense_id,share_cents,expenses(id,title,amount_cents,group_id,paid_by,status,groups(name))').eq('user_id', uid).is('approved', null),
  ]);
  if (gm.error) throw gm.error;
  const groups = (gm.data || []).filter((x) => x.groups).map((x) => ({ id: x.groups.id, name: x.groups.name, status: x.groups.status, iconIdx: x.groups.icon_idx, colorIdx: x.groups.color_idx, role: x.role, mstatus: x.status, balance: 0 }));
  const invites = (inv.data || []).filter((x) => x.groups);
  const pending = (sh.data || []).filter((x) => x.expenses && x.expenses.status === 'pending');
  await loadProfiles([...invites.map((i) => i.invited_by), ...pending.map((p) => p.expenses.paid_by)]);
  await Promise.all(groups.map(async (g) => { try { g.balance = (await rpc('my_balance', { p_group: g.id })) || 0; } catch (_) {} }));
  S.data.groups = groups; S.data.invites = invites; S.data.pending = pending;
}
async function refreshHome() { await loadHome(); if (S.view === 'home') render(); }

async function loadGroup() {
  const gid = S.gid;
  const [g, mem, ex, bal, st, gp] = await Promise.all([
    sb.from('groups').select('id,name,status,members_can_invite,created_by,icon_idx,color_idx').eq('id', gid).single(),
    sb.from('group_members').select('user_id,role,status,leave_requested_at').eq('group_id', gid).in('status', ['active', 'leaving', 'invited']),
    sb.from('expenses').select('id,title,note,amount_cents,paid_by,created_by,split,status,receipt_path,created_at,expense_shares(user_id,share_cents,approved,reject_reason)').eq('group_id', gid).order('created_at', { ascending: false }).limit(200),
    sb.rpc('group_balances', { p_group: gid }),
    sb.from('settlements').select('id,from_user,to_user,amount_cents,status,created_at').eq('group_id', gid).order('created_at', { ascending: false }).limit(100),
    sb.from('group_premium').select('group_id').eq('group_id', gid).maybeSingle(),
  ]);
  if (g.error || !g.data) throw new Error('Nie masz dostępu do tej grupy.');
  const members = mem.data || [];
  await loadProfiles([...members.map((m) => m.user_id), ...(ex.data || []).flatMap((e) => [e.paid_by, e.created_by]), ...(st.data || []).flatMap((s) => [s.from_user, s.to_user])]);
  S.data.group = g.data; S.data.members = members; S.data.expenses = ex.data || [];
  S.data.balances = bal.data || []; S.data.settlements = st.data || []; S.data.groupPremium = !!(gp.data);
}
async function refreshGroup() { await loadGroup(); if (S.view === 'group') render(); }

const activeMembers = () => S.data.members.filter((m) => m.status === 'active');
const activeIds = () => activeMembers().map((m) => m.user_id);
const myRole = () => { const m = S.data.members.find((x) => x.user_id === me()); return m ? m.role : null; };
const isAdmin = () => ['owner', 'admin'].includes(myRole());
const groupUnlocked = () => S.data.groupPremium || S.data.members.some((m) => m.status !== 'invited' && hasPremium(P(m.user_id)));
const groupLimit = () => groupUnlocked() ? Infinity : 3;

/* =====================================================================
   WIDOKI
   ===================================================================== */
function render() {
  const app = $('#app');
  if (!CONFIGURED) { app.innerHTML = viewSetup(); return; }
  const v = { auth: viewAuth, recovery: viewRecovery, home: viewHome, group: viewGroup, profile: viewProfile }[S.view];
  app.innerHTML = v ? v() : '<div class="center muted">Ładowanie…</div>';
}

function viewSetup() {
  return `<div class="auth"><div class="logo">Pay Buddy</div><div class="card"><h2>Brakuje konfiguracji</h2>
  <p class="muted">Otwórz <b>app.js</b> i wklej na samej górze <b>SUPABASE_URL</b> oraz <b>SUPABASE_ANON_KEY</b> (Supabase → Project Settings → API).</p></div></div>`;
}

function viewAuth() {
  const m = S.authMode;
  const banner = S.pendingConfirm ? `<div class="notice">Wysłaliśmy link potwierdzający na <b>${esc(S.pendingConfirm)}</b>. Kliknij go, a potem się zaloguj.<br><button class="link" data-act="resend">Wyślij link ponownie</button></div>` : '';
  let form = '';
  if (m === 'login') form = `<form data-form="login" class="stack">
    <label class="field"><span>E-mail</span><input name="email" type="email" required autocomplete="email"></label>
    <label class="field"><span>Hasło</span><input name="password" type="password" required autocomplete="current-password"></label>
    <button class="btn" type="submit">Zaloguj</button>
    <button type="button" class="link" data-act="authMode" data-mode="forgot">Nie pamiętam hasła</button></form>`;
  if (m === 'register') form = `<form data-form="register" class="stack">
    <label class="field"><span>Nazwa użytkownika <small>(po niej Cię znajdą)</small></span><input name="username" required minlength="3" maxlength="20" pattern="[a-zA-Z0-9_]{3,20}" autocomplete="username" autocapitalize="none"></label>
    <label class="field"><span>Imię / pseudonim <small>(opcjonalnie)</small></span><input name="display" maxlength="30"></label>
    <label class="field"><span>E-mail</span><input name="email" type="email" required autocomplete="email"></label>
    <label class="field"><span>Hasło <small>(min. 8 znaków)</small></span><input name="password" type="password" required minlength="8" autocomplete="new-password"></label>
    <button class="btn" type="submit">Załóż konto</button></form>`;
  if (m === 'forgot') form = `<form data-form="forgot" class="stack">
    <p class="muted">Podaj e-mail, wyślemy link do ustawienia nowego hasła.</p>
    <label class="field"><span>E-mail</span><input name="email" type="email" required></label>
    <button class="btn" type="submit">Wyślij link</button>
    <button type="button" class="link" data-act="authMode" data-mode="login">Wróć</button></form>`;
  const tabs = m === 'forgot' ? '' : `<div class="seg"><button class="${m === 'login' ? 'on' : ''}" data-act="authMode" data-mode="login">Logowanie</button><button class="${m === 'register' ? 'on' : ''}" data-act="authMode" data-mode="register">Rejestracja</button></div>`;
  return `<div class="auth"><div class="logo">Pay Buddy</div><p class="tag">Rozliczaj się ze znajomymi bez kłótni.</p>${banner}<div class="card">${tabs}${form}</div>
    <footer class="auth-foot">
      <a href="legal/regulamin.html" target="_blank">Regulamin</a> · <a href="legal/polityka-prywatnosci.html" target="_blank">Polityka prywatności</a>
      <div class="muted small" style="margin-top:6px">Pay Buddy — usługa w ramach MGS Corporation<br>Operator: MGS Corporation · NIP brak · kontakt: mgs.corporation@outlook.com</div>
    </footer>
  </div>`;
}

function viewRecovery() {
  return `<div class="auth"><div class="logo">Pay Buddy</div><div class="card"><h2>Nowe hasło</h2>
  <form data-form="newpass" class="stack"><label class="field"><span>Nowe hasło (min. 8 znaków)</span><input name="password" type="password" required minlength="8" autocomplete="new-password"></label>
  <button class="btn" type="submit">Zapisz hasło</button></form></div></div>`;
}

function viewHome() {
  const D = S.data;
  const invites = D.invites.map((i) => `<div class="card invite"><div><b>${esc(i.groups.name)}</b><div class="muted small">Zaprasza: ${esc(nameOf(i.invited_by))}</div></div>
    <div class="row"><button class="btn small" data-act="acceptInvite" data-id="${esc(i.group_id)}">Dołącz</button><button class="btn small ghost" data-act="declineInvite" data-id="${esc(i.group_id)}">Odrzuć</button></div></div>`).join('');
  const pend = D.pending.length ? `<div class="card attn"><b>Czeka na Twoją decyzję (${D.pending.length})</b><div class="list">${D.pending.map((p) => `
    <button class="row-item" data-act="openExpense" data-gid="${esc(p.expenses.group_id)}" data-id="${esc(p.expense_id)}"><div class="ri-main"><div class="ri-title">${esc(p.expenses.title)}</div><div class="ri-sub">${esc(p.expenses.groups ? p.expenses.groups.name : '')} · płacił(a): ${esc(nameOf(p.expenses.paid_by))}</div></div><div class="ri-side"><div class="ri-amt">${fmt(p.share_cents)}</div><span class="muted small">Twój udział</span></div></button>`).join('')}</div></div>` : '';
  const groups = D.groups.length ? `<div class="list">${D.groups.map((g) => { const cv = groupCover(g.id, g.iconIdx, g.colorIdx); return `
    <button class="group-card" data-act="openGroup" data-id="${esc(g.id)}">
      <div class="gc-cover" style="background:linear-gradient(135deg,${cv.c1},${cv.c2})"><span class="gc-icon">${cv.icon}</span></div>
      <div class="gc-body"><div class="ri-title">${esc(g.name)}${g.status === 'closed' ? ' <span class="chip muted">zamknięta</span>' : ''}${g.mstatus === 'leaving' ? ' <span class="chip warn">wychodzisz</span>' : ''}</div><div class="gc-bal">${balHTML(g.balance)}</div></div>
    </button>`; }).join('')}</div>`
    : '<div class="empty">Nie masz jeszcze żadnej grupy.<br>Załóż pierwszą — np. wyjazd albo mieszkanie.</div>';
  return `<header class="topbar"><div class="title">Twoje grupy ${hasPremium(S.profile) ? '<span class="chip ok">Premium</span>' : `<span class="chip">${D.groups.length}/1 grup — plan darmowy</span>`}</div><button class="icon-btn" data-act="refreshHome">${I.refresh}</button><button class="avatar-btn" data-act="openProfile">${avatar(me(), 34)}</button></header>
  <main class="page">${invites}${pend}${groups}<button class="btn wide" data-act="newGroup">+ Nowa grupa</button>${!hasPremium(S.profile) ? '<button class="link" data-act="premiumInfo">Zobacz co daje Premium →</button>' : ''}</main>`;
}

function viewGroup() {
  const D = S.data; if (!D.group) return '<div class="center muted">Ładowanie…</div>';
  const g = D.group;
  const mine = (D.balances.find((b) => b.user_id === me()) || { balance_cents: 0 }).balance_cents;
  const pend = D.expenses.filter((e) => e.status === 'pending').length;
  const head = mine > 0 ? `Należy Ci się <span class="pos big">${fmt(mine)}</span>` : mine < 0 ? `Jesteś winien <span class="neg big">${fmt(-mine)}</span>` : 'Wszystko wyrównane';
  const tabs = [['expenses', I.list, 'Wydatki'], ['settle', I.swap, 'Rozlicz'], ['members', I.users, 'Osoby'], ['settings', I.cog, 'Ustawienia']];
  const body = { expenses: tabExpenses, settle: tabSettle, members: tabMembers, settings: tabSettings }[S.tab]();
  const cv = groupCover(g.id, g.icon_idx, g.color_idx);
  return `<header class="topbar topbar-cover" style="background:linear-gradient(135deg,${cv.c1},${cv.c2})"><button class="icon-btn on-cover" data-act="goHome">${I.back}</button><div class="title on-cover">${cv.icon} ${esc(g.name)}${g.status === 'closed' ? ' <span class="chip muted">zamknięta</span>' : ''}</div><button class="icon-btn on-cover" data-act="refreshGroup">${I.refresh}</button></header>
  <main class="page"><div class="card balance" style="background:linear-gradient(135deg,${cv.c1},${cv.c2})"><div>${head}</div>${pend ? `<div class="muted small">${pend} ${pend === 1 ? 'wydatek czeka' : 'wydatki czekają'} na zatwierdzenie — nie wchodzą jeszcze do salda</div>` : ''}</div>${body}</main>
  ${g.status === 'active' && S.tab === 'expenses' ? `<button class="fab" data-act="addExpense" aria-label="Dodaj wydatek">${I.plus}</button>` : ''}
  <nav class="tabs">${tabs.map(([k, ico, l]) => `<button class="${S.tab === k ? 'on' : ''}" data-act="tab" data-tab="${k}">${ico}<span>${l}</span></button>`).join('')}</nav>`;
}

function tabExpenses() {
  const ex = S.data.expenses;
  if (!ex.length) return '<div class="empty">Brak wydatków.<br>Dodaj pierwszy przyciskiem +.</div>';
  return `<div class="list">${ex.map((e) => {
    const sh = e.expense_shares || []; const done = sh.filter((s) => s.approved === true).length;
    const mineSh = sh.find((s) => s.user_id === me());
    const chip = e.status === 'approved' ? '<span class="chip ok">zatwierdzony</span>' : e.status === 'rejected' ? '<span class="chip bad">odrzucony</span>' : `<span class="chip warn">czeka ${done}/${sh.length}</span>`;
    const need = e.status === 'pending' && mineSh && mineSh.approved === null;
    return `<button class="row-item card" data-act="showExpense" data-id="${esc(e.id)}"><div class="ri-main"><div class="ri-title">${esc(e.title)}</div>
      <div class="ri-sub">Płacił(a): ${esc(nameOf(e.paid_by))} · ${fmtDate(e.created_at)}${mineSh ? ` · Twój udział ${fmt(mineSh.share_cents)}` : ''}</div>${need ? '<div class="need">Czeka na Twoją decyzję</div>' : ''}</div>
      <div class="ri-side"><div class="ri-amt">${fmt(e.amount_cents)}</div>${chip}</div></button>`;
  }).join('')}</div>`;
}

function tabSettle() {
  const D = S.data;
  const transfers = computeTransfers(D.balances.map((b) => ({ user_id: b.user_id, cents: b.balance_cents })));
  const open = (from, to) => D.settlements.find((s) => s.from_user === from && s.to_user === to && ['proposed', 'paid'].includes(s.status));
  const rows = transfers.map((t) => {
    let action = '<span class="muted small">czeka na wpłatę</span>';
    let payInfo = '';
    if (t.from === me()) {
      action = open(t.from, t.to) ? '<span class="chip warn">czeka na potwierdzenie</span>' : `<button class="btn small" data-act="markPaid" data-to="${esc(t.to)}" data-cents="${t.cents}">Zapłaciłem</button>`;
      const pTo = P(t.to);
      if (pTo.bank_account || pTo.blik_phone) {
        payInfo = `<div class="pay-info">${pTo.bank_account ? `<div>Konto: <b>${esc(pTo.bank_account)}</b></div>` : ''}${pTo.blik_phone ? `<div>BLIK: <b>${esc(pTo.blik_phone)}</b></div>` : ''}</div>`;
      }
    }
    return `<div class="card transfer"><div class="tf-who">${avatar(t.from, 34)}<span>${esc(nameOf(t.from))}</span></div><div class="tf-mid">${I.swap}<b>${fmt(t.cents)}</b></div><div class="tf-who">${avatar(t.to, 34)}<span>${esc(nameOf(t.to))}</span></div><div class="tf-act">${action}</div>${payInfo}</div>`;
  }).join('');
  const hist = D.settlements.map((s) => {
    const label = { proposed: 'zgłoszone', paid: 'zapłacone — czeka na potwierdzenie', confirmed: 'potwierdzone' }[s.status];
    const confirmBtn = s.status === 'paid' && s.to_user === me() ? `<button class="btn small" data-act="confirmSettlement" data-id="${esc(s.id)}">Potwierdzam otrzymanie</button>` : '';
    return `<div class="row-item card"><div class="ri-main"><div class="ri-title">${esc(nameOf(s.from_user))} → ${esc(nameOf(s.to_user))}</div><div class="ri-sub">${fmtDate(s.created_at)} · ${label}</div></div><div class="ri-side"><div class="ri-amt">${fmt(s.amount_cents)}</div>${confirmBtn}</div></div>`;
  }).join('');
  return `<h3 class="sec">Proponowane przelewy</h3>${rows || '<div class="empty">Nikt nikomu nic nie wisi.</div>'}
  <p class="muted small">Przelewy robicie poza aplikacją (BLIK, przelew). Tu tylko zaznaczasz, że zapłaciłeś, a druga osoba potwierdza.</p>
  ${hist ? `<h3 class="sec">Historia rozliczeń</h3>${hist}` : ''}`;
}

function tabMembers() {
  const D = S.data; const iOwner = myRole() === 'owner';
  const canInvite = isAdmin() || D.group.members_can_invite;
  const rows = D.members.map((m) => {
    const p = P(m.user_id); const role = { owner: 'właściciel', admin: 'admin', member: '' }[m.role];
    let chips = role ? `<span class="chip muted">${role}</span>` : '';
    if (m.status === 'invited') chips += ' <span class="chip muted">zaproszony</span>';
    let extra = '';
    if (m.status === 'leaving') {
      const left = Math.max(0, Math.ceil((new Date(m.leave_requested_at).getTime() + 3600e3 - Date.now()) / 60000));
      chips += ' <span class="chip warn">wychodzi</span>';
      extra = `<div class="small muted">Spór o wyjście — automatycznie za ~${left} min.</div>${isAdmin() && m.user_id !== me() ? `<div class="row"><button class="btn small" data-act="resolveLeave" data-u="${esc(m.user_id)}" data-allow="1">Pozwól wyjść</button><button class="btn small ghost" data-act="resolveLeave" data-u="${esc(m.user_id)}" data-allow="0">Zostaje</button></div>` : ''}`;
    }
    const mgmt = [];
    if (m.user_id !== me() && m.status === 'active' && m.role !== 'owner') {
      if (iOwner) mgmt.push(`<button class="btn small ghost" data-act="toggleAdmin" data-u="${esc(m.user_id)}" data-role="${m.role === 'admin' ? 'member' : 'admin'}">${m.role === 'admin' ? 'Odbierz admina' : 'Ustaw admina'}</button>`);
      if (iOwner || (isAdmin() && m.role === 'member')) mgmt.push(`<button class="btn small ghost danger-t" data-act="removeMember" data-u="${esc(m.user_id)}">Usuń</button>`);
      if (iOwner) mgmt.push(`<button class="btn small ghost" data-act="transferOwner" data-u="${esc(m.user_id)}">Przekaż własność</button>`);
    }
    return `<div class="card member"><div class="mem-top">${avatar(m.user_id, 42)}<div class="ri-main"><div class="ri-title">${esc(nameOf(m.user_id))} ${chips}</div><div class="ri-sub">@${esc(p.username)}${hasPremium(p) ? ' · <span class="chip ok">premium</span>' : ''}</div></div></div>${extra}${mgmt.length ? `<div class="row wrap">${mgmt.join('')}</div>` : ''}</div>`;
  }).join('');
  const cnt = D.members.filter((m) => m.status !== 'leaving' || true).length;
  const limitTxt = groupUnlocked() ? 'bez limitu' : `${cnt}/3`;
  const invite = canInvite && D.group.status === 'active' ? `<form data-form="invite" class="card stack"><b>Zaproś po nazwie użytkownika</b><div class="row"><input name="username" placeholder="np. kuba_23" required autocapitalize="none" autocomplete="off"><button class="btn" type="submit">Zaproś</button></div><div class="muted small">Osób: ${limitTxt}. ${groupUnlocked() ? '' : 'Premium członka albo jednorazowy odblok grupy znoszą limit.'}</div></form>` : '';
  return `${invite}${rows}`;
}

function iconPickerHTML(g) {
  const baseIcon = g.icon_idx != null ? g.icon_idx : (Math.abs(hue(g.id)) / 7 | 0) % COVER_ICONS.length;
  const baseColor = g.color_idx != null ? g.color_idx : Math.abs(hue(g.id)) % COVER_PALETTES.length;
  const selIcon = S.pickIcon != null ? S.pickIcon : baseIcon;
  const selColor = S.pickColor != null ? S.pickColor : baseColor;
  const [pc1, pc2] = COVER_PALETTES[selColor];
  const icons = COVER_ICONS.map((ic, i) => `<button type="button" class="pick-ic ${i === selIcon ? 'on' : ''}" data-act="pickIcon" data-i="${i}">${ic}</button>`).join('');
  const colors = COVER_PALETTES.map(([c1, c2], i) => `<button type="button" class="pick-col ${i === selColor ? 'on' : ''}" data-act="pickColor" data-i="${i}" style="background:linear-gradient(135deg,${c1},${c2})"></button>`).join('');
  return `<div class="card stack"><b>Wygląd grupy</b>
    <div class="cover-preview" style="background:linear-gradient(135deg,${pc1},${pc2})">${COVER_ICONS[selIcon]}</div>
    <div class="muted small">Ikonka</div><div class="pick-row">${icons}</div>
    <div class="muted small">Kolor</div><div class="pick-row">${colors}</div>
    <button class="btn" data-act="saveGroupIcon">Zapisz</button></div>`;
}

function tabSettings() {
  const D = S.data; const owner = myRole() === 'owner'; const g = D.group;
  const rename = owner ? `<form data-form="renameGroup" class="card stack"><b>Nazwa grupy</b><div class="row"><input name="name" value="${esc(g.name)}" required maxlength="60"><button class="btn" type="submit">Zapisz</button></div></form>` : '';
  const unlock = (isAdmin() && !groupUnlocked()) ? `<div class="card stack"><b>Bez limitu osób w tej grupie</b><p class="muted small">Jednorazowa opłata 10 zł — ta grupa na zawsze traci limit 3 osób, niezależnie od tego, kto ma premium na koncie. Nie daje skanu AI.</p><button class="btn wide" data-act="buyGroupPremium">Odblokuj tę grupę — 10 zł</button></div>` : (groupUnlocked() ? `<div class="notice">Ta grupa ma odblokowany limit osób.</div>` : '');
  const iconPicker = isAdmin() ? iconPickerHTML(g) : '';
  return `${rename}${iconPicker}${unlock}${owner ? `<div class="card"><label class="switch-row"><span><b>Członkowie mogą zapraszać</b><div class="muted small">Domyślnie zapraszają tylko właściciel i admini.</div></span><input type="checkbox" data-act="toggleInvite" ${g.members_can_invite ? 'checked' : ''}></label></div>` : ''}
  <div class="card stack"><b>Wyjście z grupy</b><p class="muted small">Wyjdziesz od razu, jeśli masz saldo 0 i brak oczekujących wydatków. W innym razie zaczyna się spór: reszta grupy ma godzinę na reakcję, potem wychodzisz automatycznie, a niewyrównane saldo zostaje zapisane poza grupą.</p><button class="btn ghost danger-t" data-act="leaveGroup">Wyjdź z grupy</button></div>
  ${owner && g.status === 'active' ? '<div class="card stack"><b>Zamknij grupę</b><p class="muted small">Po zamknięciu nie da się dodawać wydatków. Historia zostaje.</p><button class="btn ghost danger-t" data-act="closeGroup">Zamknij grupę</button></div>' : ''}`;
}

function viewProfile() {
  const p = S.profile; const prem = hasPremium(p);
  return `<header class="topbar"><button class="icon-btn" data-act="goHome">${I.back}</button><div class="title">Profil</div></header>
  <main class="page"><div class="card center-col">${avatar(me(), 92)}<label class="btn small ghost">Zmień zdjęcie<input type="file" accept="image/*" hidden data-file="avatar"></label>
  <div class="muted">@${esc(p.username)} ${prem ? '<span class="chip ok">Premium</span>' : ''}</div><div class="muted small">${esc(S.user.email)}</div></div>
  <form data-form="profile" class="card stack"><label class="field"><span>Imię / pseudonim</span><input name="display" value="${esc(p.display_name || '')}" maxlength="30"></label><button class="btn" type="submit">Zapisz</button></form>
  <form data-form="payInfo" class="card stack"><b>Dane do przelewu</b><p class="muted small">Pokazujemy je tylko osobom, które są Ci winne pieniądze w Waszej wspólnej grupie.</p>
  <label class="field"><span>Numer konta</span><input name="bank_account" value="${esc(p.bank_account || '')}" maxlength="40" placeholder="np. PL00 1234 5678 ..."></label>
  <label class="field"><span>Numer BLIK (telefon)</span><input name="blik_phone" value="${esc(p.blik_phone || '')}" maxlength="20" placeholder="np. 600 000 000"></label>
  <button class="btn" type="submit">Zapisz</button></form>
  <div class="card stack"><b>Premium ${prem ? '<span class="chip ok">aktywne</span>' : ''}</b>
  ${prem ? `<div class="muted small">Ważne do ${p.premium_until ? new Date(p.premium_until).toLocaleDateString('pl-PL') : 'bezterminowo'}.</div>` : '<div class="muted small">Plan darmowy: 1 grupa na zawsze, do 3 osób.</div>'}
  <ul class="feat"><li>Nielimitowana liczba grup</li><li>Nielimitowana liczba osób w grupach</li><li>Skan paragonów przez AI (do 20 dziennie)</li><li>Eksport PDF</li></ul>
  <button class="btn" data-act="premiumInfo">${prem ? 'Przedłuż premium' : 'Kup premium'}</button></div>
  <button class="btn ghost wide" data-act="logout">Wyloguj</button>
  <footer class="auth-foot"><a href="legal/regulamin.html" target="_blank">Regulamin</a> · <a href="legal/polityka-prywatnosci.html" target="_blank">Polityka prywatności</a><div class="muted small" style="margin-top:6px">Pay Buddy — usługa w ramach MGS Corporation</div></footer></main>`;
}

/* =====================================================================
   FORMULARZE
   ===================================================================== */
const forms = {
  async login(f) {
    const email = f.email.value.trim();
    const { error } = await sb.auth.signInWithPassword({ email, password: f.password.value });
    if (error) {
      if (/not confirmed/i.test(error.message)) { S.pendingConfirm = email; render(); }
      throw error;
    }
  },
  async register(f) {
    const username = f.username.value.trim().toLowerCase(); const email = f.email.value.trim();
    if (!/^[a-z0-9_]{3,20}$/.test(username)) throw new Error('Nazwa użytkownika: 3–20 znaków, litery, cyfry i _.');
    if (f.password.value.length < 8) throw new Error('Hasło musi mieć min. 8 znaków.');
    const av = await sb.rpc('username_available', { p_username: username });
    if (av.error) throw av.error;
    if (!av.data) throw new Error('Ta nazwa użytkownika jest zajęta.');
    const { data, error } = await sb.auth.signUp({ email, password: f.password.value, options: { data: { username, display_name: f.display.value.trim() || username }, emailRedirectTo: location.origin + location.pathname } });
    if (error) throw error;
    if (data.user && data.user.identities && data.user.identities.length === 0) throw new Error('Ten e-mail jest już zarejestrowany.');
    if (!data.session) { S.pendingConfirm = email; S.authMode = 'login'; render(); }
  },
  async forgot(f) {
    const { error } = await sb.auth.resetPasswordForEmail(f.email.value.trim(), { redirectTo: location.origin + location.pathname });
    if (error) throw error;
    toast('Jeśli konto istnieje, wysłaliśmy link na ten adres.'); S.authMode = 'login'; render();
  },
  async newpass(f) {
    const { error } = await sb.auth.updateUser({ password: f.password.value });
    if (error) throw error;
    S.recovering = false; toast('Hasło zmienione.'); await boot();
  },
  async profile(f) {
    const { error } = await sb.from('profiles').update({ display_name: f.display.value.trim() || null }).eq('id', me());
    if (error) throw error;
    await loadMe(); toast('Zapisano.'); render();
  },
  async payInfo(f) {
    const bank_account = f.bank_account.value.trim() || null;
    const blik_phone = f.blik_phone.value.trim() || null;
    const { error } = await sb.from('profiles').update({ bank_account, blik_phone }).eq('id', me());
    if (error) throw error;
    await loadMe(); toast('Zapisano.'); render();
  },
  async invite(f) {
    await rpc('invite_user', { p_group: S.gid, p_username: f.username.value });
    toast('Zaproszenie wysłane.'); await refreshGroup();
  },
  async renameGroup(f) {
    const name = f.name.value.trim();
    if (!name) throw new Error('Podaj nazwę grupy.');
    const { error } = await sb.from('groups').update({ name }).eq('id', S.gid);
    if (error) throw error;
    toast('Nazwa zapisana.'); await refreshGroup();
  },
  async newGroup(f) {
    const id = await rpc('create_group', { p_name: f.name.value });
    closeModal(); await actions.openGroup({ id });
  },
  async reject(f) {
    await rpc('decide_share', { p_expense: f.dataset.id, p_approve: false, p_reason: f.reason.value });
    closeModal(); toast('Odrzucono.'); await afterDecision();
  },
  async addExpense() { await submitExpense(); },
};
async function afterDecision() { if (S.view === 'group') await refreshGroup(); else await refreshHome(); }

/* =====================================================================
   AKCJE
   ===================================================================== */
const actions = {
  modalBg(d, el, e) { if (e.target !== el) return; closeModal(); if (confirmResolve) { confirmResolve(false); confirmResolve = null; } },
  cfYes() { closeModal(); const r = confirmResolve; confirmResolve = null; if (r) r(true); },
  cfNo() { closeModal(); const r = confirmResolve; confirmResolve = null; if (r) r(false); },
  closeModal() { closeModal(); },
  authMode(d) { S.authMode = d.mode; S.pendingConfirm = null; render(); },
  async resend() { const { error } = await sb.auth.resend({ type: 'signup', email: S.pendingConfirm }); if (error) throw error; toast('Wysłano ponownie.'); },
  async logout() { await sb.auth.signOut(); },

  async goHome() { S.view = 'home'; S.gid = null; render(); await refreshHome(); },
  async refreshHome() { await refreshHome(); toast('Odświeżono.'); },
  async refreshGroup() { await refreshGroup(); toast('Odświeżono.'); },
  async openProfile() { S.view = 'profile'; render(); },
  tab(d) { S.tab = d.tab; render(); },

  async openGroup(d) { S.gid = d.id; S.tab = 'expenses'; S.view = 'group'; S.data.group = null; S.pickIcon = null; S.pickColor = null; render(); try { await loadGroup(); } catch (e) { S.view = 'home'; toast(errMsg(e), 'err'); await loadHome(); } render(); },
  async openExpense(d) { await actions.openGroup({ id: d.gid }); await actions.showExpense({ id: d.id }); },
  newGroup() { openModal('<h3>Nowa grupa</h3><form data-form="newGroup" class="stack"><label class="field"><span>Nazwa</span><input name="name" required maxlength="60" placeholder="np. Wyjazd w góry" autofocus></label><button class="btn" type="submit">Utwórz</button></form>'); },
  async acceptInvite(d) { await rpc('accept_invite', { p_group: d.id }); toast('Dołączono do grupy.'); await refreshHome(); },
  async declineInvite(d) { await rpc('decline_invite', { p_group: d.id }); await refreshHome(); },

  async showExpense(d) {
    const e = S.data.expenses.find((x) => x.id === d.id); if (!e) return;
    const sh = e.expense_shares || []; const mineSh = sh.find((s) => s.user_id === me());
    let receipt = '';
    if (e.receipt_path) {
      const { data } = await sb.storage.from('receipts').createSignedUrl(e.receipt_path, 300);
      if (data) receipt = `<a href="${esc(data.signedUrl)}" target="_blank" rel="noopener"><img class="receipt" src="${esc(data.signedUrl)}" alt="Paragon"></a>`;
    }
    const rows = sh.map((s) => {
      const st = s.approved === true ? '<span class="chip ok">zatwierdził(a)</span>' : s.approved === false ? '<span class="chip bad">odrzucił(a)</span>' : '<span class="chip warn">czeka</span>';
      return `<div class="share"><div class="mem-top">${avatar(s.user_id, 30)}<span>${esc(nameOf(s.user_id))}</span></div><div class="share-r"><b>${fmt(s.share_cents)}</b> ${st}</div>${s.reject_reason ? `<div class="reason">„${esc(s.reject_reason)}"</div>` : ''}</div>`;
    }).join('');
    const canDecide = e.status === 'pending' && mineSh && mineSh.approved === null;
    const canDelete = e.created_by === me() && ['pending', 'rejected'].includes(e.status);
    openModal(`<h3>${esc(e.title)}</h3><div class="big-amt">${fmt(e.amount_cents)}</div>
      <div class="muted small">Płacił(a): ${esc(nameOf(e.paid_by))} · dodał(a): ${esc(nameOf(e.created_by))} · ${fmtDate(e.created_at)}</div>
      ${e.note ? `<div class="note-box">${esc(e.note)}</div>` : ''}
      <div class="shares">${rows}</div>${receipt}
      ${e.status === 'rejected' ? '<p class="notice">Wydatek odrzucony. Usuń go i dodaj ponownie z poprawkami.</p>' : ''}
      ${canDecide ? `<div class="row"><button class="btn" data-act="approve" data-id="${esc(e.id)}">Zatwierdzam</button><button class="btn ghost danger-t" data-act="rejectAsk" data-id="${esc(e.id)}">Odrzucam</button></div>` : ''}
      ${canDelete ? `<button class="btn ghost danger-t wide" data-act="deleteExpense" data-id="${esc(e.id)}">Usuń wydatek</button>` : ''}
      <button class="btn ghost wide" data-act="closeModal">Zamknij</button>`);
  },
  async approve(d) { await rpc('decide_share', { p_expense: d.id, p_approve: true, p_reason: null }); closeModal(); toast('Zatwierdzono.'); await afterDecision(); },
  rejectAsk(d) { openModal(`<h3>Dlaczego odrzucasz?</h3><form data-form="reject" data-id="${esc(d.id)}" class="stack"><label class="field"><span>Powód (min. 3 znaki)</span><textarea name="reason" required minlength="3" maxlength="200" rows="3"></textarea></label><button class="btn danger" type="submit">Odrzuć wydatek</button></form>`); },
  async deleteExpense(d) {
    if (!(await confirmBox('Usunąć ten wydatek? Tego nie da się cofnąć.', 'Usuń', true))) return;
    const { error } = await sb.from('expenses').delete().eq('id', d.id); if (error) throw error;
    toast('Usunięto.'); await refreshGroup();
  },

  async markPaid(d) {
    const cents = parseInt(d.cents, 10);
    const { data, error } = await sb.from('settlements').insert({ group_id: S.gid, from_user: me(), to_user: d.to, amount_cents: cents }).select('id').single();
    if (error) throw error;
    await rpc('mark_settlement_paid', { p_id: data.id });
    toast('Zaznaczono. Druga osoba musi potwierdzić.'); await refreshGroup();
  },
  async confirmSettlement(d) { await rpc('confirm_settlement', { p_id: d.id }); toast('Potwierdzono.'); await refreshGroup(); },

  async removeMember(d) { if (!(await confirmBox(`Usunąć ${nameOf(d.u)} z grupy?`, 'Usuń', true))) return; await rpc('remove_member', { p_group: S.gid, p_user: d.u }); await refreshGroup(); },
  async toggleAdmin(d) { await rpc('set_member_role', { p_group: S.gid, p_user: d.u, p_role: d.role }); await refreshGroup(); },
  async transferOwner(d) { if (!(await confirmBox(`Przekazać własność grupy osobie ${nameOf(d.u)}? Zostaniesz adminem.`, 'Przekaż'))) return; await rpc('transfer_ownership', { p_group: S.gid, p_to: d.u }); toast('Własność przekazana.'); await refreshGroup(); },
  async resolveLeave(d) { await rpc('resolve_leave', { p_group: S.gid, p_user: d.u, p_allow: d.allow === '1' }); await refreshGroup(); },
  async toggleInvite(d, el) { const { error } = await sb.from('groups').update({ members_can_invite: el.checked }).eq('id', S.gid); if (error) throw error; await refreshGroup(); },
  async leaveGroup() {
    if (!(await confirmBox('Na pewno chcesz wyjść z grupy?', 'Wyjdź', true))) return;
    const r = await rpc('leave_group', { p_group: S.gid });
    if (r === 'left') { toast('Wyszedłeś z grupy.'); await actions.goHome(); }
    else { toast('Saldo nie jest zerowe — zaczął się spór. Po godzinie wyjdziesz automatycznie.'); await refreshGroup(); }
  },
  async closeGroup() { if (!(await confirmBox('Zamknąć grupę? Nie będzie można dodawać wydatków.', 'Zamknij', true))) return; await rpc('close_group', { p_group: S.gid }); await refreshGroup(); },

  /* ----- dodawanie wydatku ----- */
  addExpense() { F = newForm(); openAddExpense(); },
  setMode(d) { F.mode = d.mode; renderSplit(); document.querySelectorAll('.seg [data-mode]').forEach((b) => b.classList.toggle('on', b.dataset.mode === F.mode)); },
  scanClick() {
    if (!hasPremium(S.profile)) { actions.premiumInfo(); return; }
    $('#scan-input').click();
  },
  scanToggle(d) { const it = SCAN.items[+d.i]; const k = it.who.indexOf(d.u); if (k >= 0) it.who.splice(k, 1); else it.who.push(d.u); renderScanEditor(); },
  scanDel(d) { SCAN.items.splice(+d.i, 1); renderScanEditor(); },
  scanCancel() { SCAN = null; openAddExpense(); },
  scanUse() {
    const ids = activeIds();
    const items = SCAN.items.map((it) => ({ cents: parseMoney(it.priceStr) || 0, who: it.who })).filter((it) => it.cents > 0);
    if (!items.length) throw new Error('Brak pozycji z ceną.');
    const shares = sharesFromItems(items, ids);
    const total = items.reduce((a, b) => a + b.cents, 0);
    F.title = SCAN.store || 'Zakupy'; F.amount = (total / 100).toFixed(2).replace('.', ','); F.mode = 'unequal';
    F.amounts = {}; shares.forEach((s) => { F.amounts[s.user_id] = (s.share_cents / 100).toFixed(2).replace('.', ','); });
    F.receipt = SCAN.blob; SCAN = null; openAddExpense();
  },

  /* ----- wygląd grupy ----- */
  pickIcon(d) { S.pickIcon = Number(d.i); render(); },
  pickColor(d) { S.pickColor = Number(d.i); render(); },
  async saveGroupIcon() {
    const icon = S.pickIcon != null ? S.pickIcon : (S.data.group.icon_idx != null ? S.data.group.icon_idx : (Math.abs(hue(S.gid)) / 7 | 0) % COVER_ICONS.length);
    const color = S.pickColor != null ? S.pickColor : (S.data.group.color_idx != null ? S.data.group.color_idx : Math.abs(hue(S.gid)) % COVER_PALETTES.length);
    await rpc('set_group_icon', { p_group: S.gid, p_icon: icon, p_color: color });
    S.pickIcon = null; S.pickColor = null;
    toast('Zapisano wygląd grupy.', 'ok');
    await refreshGroup();
  },

  /* ----- premium ----- */
  async premiumInfo() {
    const price = await rpc('my_premium_price');
    openModal(`<h3>Pay Buddy Premium</h3><ul class="feat"><li>Nielimitowana liczba grup (plan darmowy: 1 grupa na zawsze)</li><li>Nielimitowana liczba osób w każdej Twojej grupie</li><li>Skan paragonów przez AI — zdjęcie i gotowy wydatek, do 20 dziennie</li><li>Eksport PDF</li></ul>
      <div class="big-amt">${fmt(price)} <small>/ 30 dni</small></div>
      <button class="btn wide" data-act="buyPremium">Zapłać przez Przelewy24</button><button class="btn ghost wide" data-act="closeModal">Nie teraz</button>`);
  },
  async buyPremium() {
    const { data, error } = await sb.functions.invoke('p24-create', { body: { kind: 'account' } });
    if (error) throw await fnError(error);
    if (!data || !data.url) throw new Error((data && data.error) || 'Nie udało się rozpocząć płatności.');
    window.location.href = data.url;
  },
  async buyGroupPremium() {
    const { data, error } = await sb.functions.invoke('p24-create', { body: { kind: 'group', group_id: S.gid } });
    if (error) throw await fnError(error);
    if (!data || !data.url) throw new Error((data && data.error) || 'Nie udało się rozpocząć płatności.');
    window.location.href = data.url;
  },
};

/* ---------- formularz wydatku ---------- */
function newForm() {
  const ids = activeIds();
  return { title: '', amount: '', paidBy: me(), mode: 'equal', selected: new Set(ids), amounts: {}, debtor: ids.find((i) => i !== me()) || null, receipt: null, note: '' };
}
function openAddExpense() {
  const opts = activeMembers().map((m) => `<option value="${esc(m.user_id)}" ${m.user_id === F.paidBy ? 'selected' : ''}>${esc(nameOf(m.user_id))}</option>`).join('');
  openModal(`<h3>Nowy wydatek</h3>
  <button type="button" class="btn ghost wide scan-btn" data-act="scanClick">${I.camera} Skanuj paragon ${hasPremium(S.profile) ? '' : '<span class="chip muted">premium</span>'}</button>
  <input id="scan-input" type="file" accept="image/*" capture="environment" hidden data-file="scan">
  ${F.receipt ? '<div class="notice small">Paragon dołączony do wydatku.</div>' : ''}
  <form data-form="addExpense" class="stack">
    <label class="field"><span>Za co?</span><input data-f="title" value="${esc(F.title)}" required maxlength="100" placeholder="np. Zakupy, paliwo, pizza"></label>
    <label class="field"><span>Kwota (zł)</span><input data-f="amount" value="${esc(F.amount)}" inputmode="decimal" required placeholder="0,00"></label>
    <label class="field"><span>Kto zapłacił?</span><select data-f="paidBy">${opts}</select></label>
    <label class="field"><span>Notatka <small>(opcjonalnie)</small></span><input data-f="note" value="${esc(F.note || '')}" maxlength="300" placeholder="np. taxi z lotniska"></label>
    <div class="seg"><button type="button" data-act="setMode" data-mode="equal" class="${F.mode === 'equal' ? 'on' : ''}">Po równo</button><button type="button" data-act="setMode" data-mode="unequal" class="${F.mode === 'unequal' ? 'on' : ''}">Nierówno</button><button type="button" data-act="setMode" data-mode="full" class="${F.mode === 'full' ? 'on' : ''}">Musi oddać</button></div>
    <div id="split-area"></div><div id="preview" class="muted small"></div>
    <div class="row"><button type="button" class="btn ghost" data-act="closeModal">Anuluj</button><button class="btn" type="submit">Dodaj</button></div>
  </form>`);
  renderSplit();
}
function renderSplit() {
  const area = $('#split-area'); if (!area) return;
  const ms = activeMembers();
  if (F.mode === 'equal') {
    area.innerHTML = `<div class="muted small">Kogo dotyczy:</div>${ms.map((m) => `<label class="check"><input type="checkbox" data-sel="${esc(m.user_id)}" ${F.selected.has(m.user_id) ? 'checked' : ''}>${avatar(m.user_id, 26)}<span>${esc(nameOf(m.user_id))}</span></label>`).join('')}`;
  } else if (F.mode === 'unequal') {
    area.innerHTML = `<div class="muted small">Ile kto ma zapłacić (suma musi się zgadzać):</div>${ms.map((m) => `<label class="check amt">${avatar(m.user_id, 26)}<span>${esc(nameOf(m.user_id))}</span><input data-amt="${esc(m.user_id)}" value="${esc(F.amounts[m.user_id] || '')}" inputmode="decimal" placeholder="0,00"></label>`).join('')}`;
  } else {
    const others = ms.filter((m) => m.user_id !== F.paidBy);
    if (!others.some((m) => m.user_id === F.debtor)) F.debtor = others[0] ? others[0].user_id : null;
    area.innerHTML = `<label class="field"><span>Kto musi oddać całość?</span><select data-f="debtor">${others.map((m) => `<option value="${esc(m.user_id)}" ${m.user_id === F.debtor ? 'selected' : ''}>${esc(nameOf(m.user_id))}</option>`).join('')}</select></label>`;
  }
  updatePreview();
}
function updatePreview() {
  const el = $('#preview'); if (!el) return;
  const total = parseMoney(F.amount);
  if (F.mode === 'equal') {
    const n = F.selected.size;
    el.textContent = total && n ? `Każdy po ok. ${fmt(Math.floor(total / n))}${n > 1 ? ` (${n} os.)` : ''}` : '';
  } else if (F.mode === 'unequal') {
    let sum = 0; let bad = false;
    activeIds().forEach((id) => { try { sum += moneyOrZero(F.amounts[id]); } catch (_) { bad = true; } });
    el.textContent = bad ? 'Niepoprawna kwota w którymś polu.' : total ? (sum === total ? 'Suma się zgadza ✓' : `Suma ${fmt(sum)} z ${fmt(total)} — ${sum < total ? 'brakuje ' + fmt(total - sum) : 'za dużo o ' + fmt(sum - total)}`) : '';
  } else { el.textContent = F.debtor && total ? `${nameOf(F.debtor)} oddaje całe ${fmt(total)}.` : ''; }
}
function moneyOrZero(s) {
  s = String(s || '').trim(); if (!s) return 0;
  if (/^0+([.,]0{1,2})?$/.test(s)) return 0;
  const c = parseMoney(s); if (c === null) throw new Error('Niepoprawna kwota: ' + s); return c;
}
async function submitExpense() {
  const title = (F.title || '').trim(); if (!title) throw new Error('Podaj, za co jest wydatek.');
  const total = parseMoney(F.amount); if (!total) throw new Error('Podaj poprawną kwotę (np. 24,50).');
  const order = activeIds(); let shares; let split;
  if (F.mode === 'equal') {
    const ids = order.filter((i) => F.selected.has(i)); if (!ids.length) throw new Error('Zaznacz choć jedną osobę.');
    shares = splitEqual(total, ids); split = 'equal';
  } else if (F.mode === 'unequal') {
    shares = order.map((id) => ({ user_id: id, share_cents: moneyOrZero(F.amounts[id]) })).filter((s) => s.share_cents > 0);
    const sum = shares.reduce((a, b) => a + b.share_cents, 0);
    if (sum !== total) throw new Error(`Suma udziałów (${fmt(sum)}) nie równa się kwocie (${fmt(total)}).`);
    split = 'unequal';
  } else {
    if (!F.debtor || F.debtor === F.paidBy) throw new Error('Wybierz osobę, która ma oddać.');
    shares = [{ user_id: F.debtor, share_cents: total }]; split = 'full_on_one';
  }
  let receiptPath = null;
  if (F.receipt) {
    receiptPath = `${S.gid}/${uuid()}.jpg`;
    const up = await sb.storage.from('receipts').upload(receiptPath, F.receipt, { contentType: 'image/jpeg' });
    if (up.error) throw up.error;
  }
  await rpc('create_expense', { p_group: S.gid, p_title: title, p_amount: total, p_paid_by: F.paidBy, p_split: split, p_shares: shares, p_receipt: receiptPath, p_note: (F.note || '').trim() || null });
  F = null; closeModal(); toast('Wydatek dodany. Osoby z podziału muszą go zatwierdzić.'); await refreshGroup();
}

/* ---------- skan paragonu ---------- */
async function startScan(file) {
  openModal('<div class="center-col"><div class="spinner"></div><b>Czytam paragon…</b><div class="muted small">To zajmuje kilka sekund.</div></div>');
  try {
    const blob = await resizeImage(file, 1600, 0.82, false);
    const b64 = await blobToB64(blob);
    const { data, error } = await sb.functions.invoke('scan-receipt', { body: { image: b64, mime: 'image/jpeg' } });
    if (error) throw await fnError(error);
    if (data.error) throw new Error(data.error);
    const ids = activeIds();
    SCAN = { blob, store: data.store || '', items: (data.items || []).map((i) => ({ name: i.name, priceStr: (i.price_cents / 100).toFixed(2).replace('.', ','), who: ids.slice() })) };
    if (!SCAN.items.length) throw new Error('Nie znaleziono pozycji na paragonie. Spróbuj wyraźniejszego zdjęcia.');
    renderScanEditor();
  } catch (e) { toast(errMsg(e), 'err'); SCAN = null; openAddExpense(); }
}
function renderScanEditor() {
  const ms = activeMembers();
  const rows = SCAN.items.map((it, i) => `<div class="scan-item"><div class="si-top"><span class="si-name">${esc(it.name)}</span><input data-sp="${i}" value="${esc(it.priceStr)}" inputmode="decimal"><button class="icon-btn" data-act="scanDel" data-i="${i}" aria-label="Usuń pozycję">✕</button></div>
    <div class="chips">${ms.map((m) => `<button type="button" class="chip pick ${it.who.includes(m.user_id) ? 'on' : ''}" data-act="scanToggle" data-i="${i}" data-u="${esc(m.user_id)}">${esc(nameOf(m.user_id))}</button>`).join('')}</div></div>`).join('');
  const total = SCAN.items.reduce((a, it) => a + (parseMoney(it.priceStr) || 0), 0);
  openModal(`<h3>${esc(SCAN.store || 'Paragon')}</h3><p class="muted small">Sprawdź ceny i zaznacz, kogo dotyczy każda pozycja. AI może się pomylić.</p>
    <div class="scan-list">${rows}</div><div class="scan-total">Razem: <b id="scan-total">${fmt(total)}</b></div>
    <div class="row"><button class="btn ghost" data-act="scanCancel">Anuluj</button><button class="btn" data-act="scanUse">Użyj</button></div>`);
}

/* =====================================================================
   ZDARZENIA
   ===================================================================== */
document.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-act]'); if (!el) return;
  if (el.tagName === 'INPUT') return;              // checkboxy obsługuje 'change'
  const fn = actions[el.dataset.act]; if (!fn) return;
  const isBtn = el.tagName === 'BUTTON'; if (isBtn) el.disabled = true;
  try { await fn(el.dataset, el, e); } catch (err) { console.error(err); toast(errMsg(err), 'err'); }
  finally { if (isBtn && el.isConnected) el.disabled = false; }
});
document.addEventListener('submit', async (e) => {
  const f = e.target.closest('[data-form]'); if (!f) return;
  e.preventDefault(); const btn = f.querySelector('button[type=submit]'); if (btn) btn.disabled = true;
  try { await forms[f.dataset.form](f); } catch (err) { console.error(err); toast(errMsg(err), 'err'); }
  finally { if (btn && btn.isConnected) btn.disabled = false; }
});
document.addEventListener('input', (e) => {
  const t = e.target;
  if (t.dataset.f && F) { F[t.dataset.f] = t.value; if (t.dataset.f === 'amount') updatePreview(); }
  if (t.dataset.amt && F) { F.amounts[t.dataset.amt] = t.value; updatePreview(); }
  if (t.dataset.sp !== undefined && SCAN) {
    SCAN.items[+t.dataset.sp].priceStr = t.value;
    const total = SCAN.items.reduce((a, it) => a + (parseMoney(it.priceStr) || 0), 0);
    const el = $('#scan-total'); if (el) el.textContent = fmt(total);
  }
});
document.addEventListener('change', async (e) => {
  const t = e.target;
  if (t.dataset.f === 'paidBy' && F) { F.paidBy = t.value; if (F.mode === 'full') renderSplit(); }
  if (t.dataset.f === 'debtor' && F) { F.debtor = t.value; updatePreview(); }
  if (t.dataset.sel && F) { if (t.checked) F.selected.add(t.dataset.sel); else F.selected.delete(t.dataset.sel); updatePreview(); }
  if (t.dataset.act === 'toggleInvite') { try { await actions.toggleInvite({}, t); } catch (err) { toast(errMsg(err), 'err'); } }
  if (t.dataset.file === 'scan' && t.files[0]) { const f = t.files[0]; t.value = ''; startScan(f); }
  if (t.dataset.file === 'avatar' && t.files[0]) {
    const f = t.files[0]; t.value = '';
    try {
      const blob = await resizeImage(f, 256, 0.85, true);
      const path = `${me()}/avatar.jpg`;
      const up = await sb.storage.from('avatars').upload(path, blob, { contentType: 'image/jpeg', upsert: true });
      if (up.error) throw up.error;
      const { error } = await sb.from('profiles').update({ avatar_path: `${path}?v=${Date.now()}` }).eq('id', me());
      if (error) throw error;
      delete profCache[me()]; await loadMe(); render(); toast('Zdjęcie zmienione.');
    } catch (err) { toast(errMsg(err), 'err'); }
  }
});
window.addEventListener('focus', () => { if (!S.user || document.querySelector('.overlay')) return; if (S.view === 'home') refreshHome().catch(() => {}); if (S.view === 'group') refreshGroup().catch(() => {}); });

/* =====================================================================
   START
   ===================================================================== */
async function boot() {
  const { data: { session } } = await sb.auth.getSession();
  if (!session) { S.user = null; S.view = 'auth'; render(); return; }
  S.user = session.user;
  try {
    await loadMe(); await loadHome(); S.view = 'home'; render();
    if (new URLSearchParams(location.search).get('paid')) { history.replaceState({}, '', location.pathname); waitForPremium(); }
  } catch (e) { toast(errMsg(e), 'err'); S.view = 'home'; render(); }
}
async function waitForPremium() {
  toast('Sprawdzam płatność…');
  for (let i = 0; i < 12; i++) {
    await new Promise((r) => setTimeout(r, 2500));
    await loadMe();
    if (hasPremium(S.profile)) { toast('Premium aktywne. Dziękujemy!'); render(); return; }
  }
  toast('Płatność jeszcze się księguje — odśwież za chwilę.');
}

if (CONFIGURED) {
  sb = window.supabase.createClient(BASE_URL, SUPABASE_ANON_KEY.trim());
  sb.auth.onAuthStateChange((ev, session) => {
    if (ev === 'PASSWORD_RECOVERY') { S.recovering = true; S.view = 'recovery'; render(); return; }
    if (ev === 'SIGNED_OUT') { S.user = null; S.profile = null; S.view = 'auth'; render(); return; }
    if (ev === 'SIGNED_IN' && session && !S.recovering && (!S.user || S.user.id !== session.user.id)) setTimeout(boot, 0);
  });
  boot();
} else { render(); }
