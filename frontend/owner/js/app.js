/* Owner panel — full administrative control. */

const TOKEN_KEY = 'yurist_owner_token';
let TOKEN = localStorage.getItem(TOKEN_KEY) || '';
let ME = null;
let RESET_STAFF_ID = null;
let WS = null;
let SUPPORT_USERS = [];
let CURRENT_SUPPORT_ID = null;
let CURRENT_SUPPORT_USER = null;
let OW_CURRENT_STAFF = null;
let OW_CURRENT_CHAT_ID = null;
let _owReloadChats = null;   // reopens the level-2 list (staff chats or AI chats)

const $ = (id) => document.getElementById(id);

function showToast(msg) {
  const t = $('toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => t.classList.remove('show'), 2500);
}
function escapeHtml(s) { return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function fmtTime(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleString('ru-RU', { day:'2-digit', month:'2-digit', year:'2-digit', hour:'2-digit', minute:'2-digit' });
}

async function api(method, path, body) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (TOKEN) opts.headers['Authorization'] = `Bearer ${TOKEN}`;
  if (body !== undefined) opts.body = JSON.stringify(body);
  const res = await fetch(path, opts);
  if (res.status === 401) { logout(); throw new Error('Не авторизован'); }
  let data = {}; try { data = await res.json(); } catch {}
  if (!res.ok) {
    const detail = typeof data.detail === 'string' ? data.detail : `HTTP ${res.status}`;
    throw new Error(detail);
  }
  return data;
}

// ── Auth ──────────────────────────────────────
async function tryLogin() {
  const login = $('loginInput').value.trim();
  const password = $('passwordInput').value;
  $('loginError').textContent = '';
  if (!login || !password) { $('loginError').textContent = 'Заполните оба поля'; return; }
  try {
    const data = await api('POST', '/api/staff/login', { login, password });
    if (data.role !== 'owner') {
      $('loginError').textContent = 'Эта панель только для владельца'; return;
    }
    TOKEN = data.token;
    localStorage.setItem(TOKEN_KEY, TOKEN);
    ME = data;
    enterApp();
  } catch (e) { $('loginError').textContent = e.message; }
}

async function checkAuth() {
  if (!TOKEN) { showLogin(); return; }
  try {
    const data = await api('POST', '/api/staff/verify', {});
    if (data.role !== 'owner') { logout(); return; }
    ME = data;
    enterApp();
  } catch { showLogin(); }
}

function showLogin() {
  $('loginPage').classList.remove('hidden');
  $('appShell').classList.add('hidden');
  if (WS) { WS.close(); WS = null; }
}
function logout() {
  localStorage.removeItem(TOKEN_KEY);
  TOKEN = ''; ME = null;
  showLogin();
}

$('loginBtn').addEventListener('click', tryLogin);
$('passwordInput').addEventListener('keydown', e => { if (e.key === 'Enter') tryLogin(); });
$('logoutBtn').addEventListener('click', async () => {
  try { await api('POST', '/api/staff/logout', {}); } catch {}
  logout();
});

function enterApp() {
  $('loginPage').classList.add('hidden');
  $('appShell').classList.remove('hidden');
  $('meSubtitle').textContent = `${ME.full_name} · Владелец`;
  loadStats();
  connectWS();
}

document.querySelectorAll('.app-tab').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.app-tab').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    document.querySelectorAll('.app-panel').forEach(p => p.classList.remove('active'));
    $('tab-' + btn.dataset.tab).classList.add('active');
    const map = {
      stats: loadStats, users: loadUsers, staff: loadStaff,
      chats: loadAllChats, support: openSupportTab, broadcast: loadBroadcasts,
      channels: loadChannels, settings: loadSettings,
    };
    if (map[btn.dataset.tab]) map[btn.dataset.tab]();
  });
});

// ── Stats dashboard ───────────────────────────
let _svgId = 0;
const fmtNum = (n) => (n ?? 0).toLocaleString('ru-RU');
const totalOf = (obj) => Object.values(obj || {}).reduce((a, b) => a + (b || 0), 0);

const CHAT_TYPE_META = {
  ai:      ['ИИ-Советник', '#a78bfa'],
  lawyer:  ['Личный юрист', '#60a5fa'],
  match:   ['Подбор', '#34c759'],
  support: ['Поддержка', '#fbbf24'],
  group:   ['Групповые', '#f472b6'],
};
const SENDER_META = {
  user:    ['Клиенты', '#a78bfa'],
  ai:      ['ИИ', '#22d3ee'],
  lawyer:  ['Юристы', '#60a5fa'],
  manager: ['Менеджеры', '#fbbf24'],
  system:  ['Система', '#94a3b8'],
};
const ROLE_META = {
  owner:   ['Владельцы', '#fbbf24'],
  manager: ['Менеджеры', '#34c759'],
  lawyer:  ['Юристы', '#60a5fa'],
};

function dictToItems(dict, meta) {
  return Object.keys(meta).map(k => ({
    label: meta[k][0], color: meta[k][1], value: (dict && dict[k]) || 0,
  }));
}

async function loadStats() {
  try {
    const s = await api('GET', '/api/owner/stats');
    renderKpis(s);
    $('chartUsers').innerHTML = svgAreaChart(s.users_series || [], '#60a5fa');
    $('chartMessages').innerHTML = svgBarChart(s.messages_series || [], '#34c759');
    $('chartChatTypes').innerHTML = donutCard(dictToItems(s.chats_by_type, CHAT_TYPE_META), totalOf(s.chats_by_type), 'чатов');
    $('chartStaff').innerHTML = donutCard(dictToItems(s.staff_by_role, ROLE_META), totalOf(s.staff_by_role), 'сотр.');
    $('chartSenders').innerHTML = hbars(dictToItems(s.messages_by_sender, SENDER_META));
  } catch (e) { showToast(e.message); }
}

function renderKpis(s) {
  const kpis = [
    { label: 'Пользователи', value: s.total_users, sub: s.new_users_today ? `+${s.new_users_today} сегодня` : 'за всё время', color: '#60a5fa' },
    { label: 'Сообщения', value: s.total_messages, sub: s.messages_today ? `+${s.messages_today} сегодня` : 'за всё время', color: '#34c759' },
    { label: 'Активные юристы', value: s.lawyer_count, sub: 'в работе', color: '#a78bfa' },
    { label: 'Всего чатов', value: totalOf(s.chats_by_type), sub: 'все типы', color: '#fbbf24' },
  ];
  $('statsKpis').innerHTML = kpis.map(k => `
    <div class="kpi-card" style="--kpi:${k.color}">
      <div class="kpi-value">${fmtNum(k.value)}</div>
      <div class="kpi-label">${k.label}</div>
      <div class="kpi-sub">${k.sub}</div>
    </div>`).join('');
}

function _fmtDay(d) {
  return new Date(d).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });
}

// Area/line chart for a [{date,count}] series.
function svgAreaChart(series, color) {
  const W = 340, H = 150, padL = 8, padR = 8, padT = 16, padB = 22;
  const innerW = W - padL - padR, innerH = H - padT - padB;
  const n = series.length;
  if (!n) return `<div style="color:var(--text-tertiary);font-size:13px;padding:20px 0;text-align:center">Нет данных</div>`;
  const max = Math.max(1, ...series.map(s => s.count));
  const x = (i) => padL + (n <= 1 ? innerW / 2 : i * innerW / (n - 1));
  const y = (v) => padT + innerH * (1 - v / max);
  const pts = series.map((s, i) => [x(i), y(s.count)]);
  const line = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ');
  const area = `${line} L${x(n - 1).toFixed(1)},${(padT + innerH).toFixed(1)} L${x(0).toFixed(1)},${(padT + innerH).toFixed(1)} Z`;
  const grid = [0, 0.5, 1].map(f => `<line x1="${padL}" y1="${(padT + innerH * f).toFixed(1)}" x2="${W - padR}" y2="${(padT + innerH * f).toFixed(1)}" stroke="rgba(255,255,255,0.06)"/>`).join('');
  const gid = 'ag' + (_svgId++);
  const last = pts[n - 1];
  return `<svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto;display:block">
    <defs><linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${color}" stop-opacity="0.35"/>
      <stop offset="1" stop-color="${color}" stop-opacity="0"/>
    </linearGradient></defs>
    ${grid}
    <text x="${padL}" y="${padT - 5}" fill="rgba(255,255,255,0.45)" font-size="9">${max}</text>
    <path d="${area}" fill="url(#${gid})"/>
    <path d="${line}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
    <circle cx="${last[0].toFixed(1)}" cy="${last[1].toFixed(1)}" r="3.5" fill="${color}"/>
    <text x="${padL}" y="${H - 6}" fill="rgba(255,255,255,0.45)" font-size="9">${_fmtDay(series[0].date)}</text>
    <text x="${W - padR}" y="${H - 6}" text-anchor="end" fill="rgba(255,255,255,0.45)" font-size="9">${_fmtDay(series[n - 1].date)}</text>
  </svg>`;
}

// Vertical bar chart for a [{date,count}] series.
function svgBarChart(series, color) {
  const W = 340, H = 150, padL = 8, padR = 8, padT = 16, padB = 22;
  const innerW = W - padL - padR, innerH = H - padT - padB;
  const n = series.length;
  if (!n) return `<div style="color:var(--text-tertiary);font-size:13px;padding:20px 0;text-align:center">Нет данных</div>`;
  const max = Math.max(1, ...series.map(s => s.count));
  const slot = innerW / n;
  const bw = Math.max(3, slot * 0.62);
  const gid = 'bg' + (_svgId++);
  let bars = '';
  series.forEach((s, i) => {
    const bh = innerH * (s.count / max);
    const bx = padL + i * slot + (slot - bw) / 2;
    const by = padT + innerH - bh;
    bars += `<rect x="${bx.toFixed(1)}" y="${by.toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.max(0, bh).toFixed(1)}" rx="2" fill="url(#${gid})"/>`;
  });
  const grid = [0, 0.5, 1].map(f => `<line x1="${padL}" y1="${(padT + innerH * f).toFixed(1)}" x2="${W - padR}" y2="${(padT + innerH * f).toFixed(1)}" stroke="rgba(255,255,255,0.06)"/>`).join('');
  return `<svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto;display:block">
    <defs><linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${color}" stop-opacity="0.95"/>
      <stop offset="1" stop-color="${color}" stop-opacity="0.4"/>
    </linearGradient></defs>
    ${grid}
    <text x="${padL}" y="${padT - 5}" fill="rgba(255,255,255,0.45)" font-size="9">${max}</text>
    ${bars}
    <text x="${padL}" y="${H - 6}" fill="rgba(255,255,255,0.45)" font-size="9">${_fmtDay(series[0].date)}</text>
    <text x="${W - padR}" y="${H - 6}" text-anchor="end" fill="rgba(255,255,255,0.45)" font-size="9">${_fmtDay(series[n - 1].date)}</text>
  </svg>`;
}

function svgDonut(items, total, unit) {
  const size = 120, stroke = 16, r = (size - stroke) / 2, cx = size / 2, cy = size / 2;
  const C = 2 * Math.PI * r;
  let segs = '', offset = 0;
  if (total > 0) {
    for (const it of items) {
      if (!it.value) continue;
      const len = (it.value / total) * C;
      segs += `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${it.color}" stroke-width="${stroke}" stroke-dasharray="${len.toFixed(2)} ${(C - len).toFixed(2)}" stroke-dashoffset="${(-offset).toFixed(2)}" transform="rotate(-90 ${cx} ${cy})"/>`;
      offset += len;
    }
  } else {
    segs = `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="rgba(255,255,255,0.08)" stroke-width="${stroke}"/>`;
  }
  return `<svg viewBox="0 0 ${size} ${size}" style="width:120px;height:120px;flex-shrink:0">
    <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="rgba(255,255,255,0.05)" stroke-width="${stroke}"/>
    ${segs}
    <text x="${cx}" y="${cy - 1}" text-anchor="middle" fill="#fff" font-size="22" font-weight="800">${total}</text>
    <text x="${cx}" y="${cy + 14}" text-anchor="middle" fill="rgba(255,255,255,0.5)" font-size="9">${unit}</text>
  </svg>`;
}

function donutCard(items, total, unit) {
  const legend = items.map(i =>
    `<div class="legend-row"><span class="legend-dot" style="background:${i.color}"></span><span class="legend-label">${i.label}</span><span class="legend-val">${i.value}</span></div>`
  ).join('');
  return `<div class="donut-wrap">${svgDonut(items, total, unit)}<div class="donut-legend">${legend}</div></div>`;
}

function hbars(items) {
  const max = Math.max(1, ...items.map(i => i.value));
  const total = items.reduce((a, i) => a + i.value, 0) || 1;
  return `<div class="hbars">${items.map(i => {
    const pct = Math.round(i.value / total * 100);
    const w = Math.max(2, i.value / max * 100);
    return `<div class="hbar-row">
      <div class="hbar-label">${i.label}</div>
      <div class="hbar-track"><div class="hbar-fill" style="width:${w}%;background:${i.color}"></div></div>
      <div class="hbar-val">${fmtNum(i.value)} <span class="hbar-pct">${pct}%</span></div>
    </div>`;
  }).join('')}</div>`;
}

// ── Users ─────────────────────────────────────
async function loadUsers() {
  try {
    const users = await api('GET', '/api/owner/users');
    const wrap = $('usersList');
    if (!users.length) { wrap.innerHTML = '<div style="padding:24px;text-align:center;color:var(--text-secondary)">Нет пользователей</div>'; return; }
    wrap.innerHTML = '';
    for (const u of users) {
      const r = document.createElement('div');
      r.className = 'data-row';
      const name = [u.first_name, u.last_name].filter(Boolean).join(' ') || u.username || `User #${u.id}`;
      r.innerHTML = `
        <div class="grow">
          <div class="data-name">${escapeHtml(name)}</div>
          <div class="data-sub">${u.username ? '@' + escapeHtml(u.username) : 'без юзернейма'} · TG ${u.telegram_id} · логин: ${escapeHtml(u.app_login || '—')} · ${fmtTime(u.created_at)}</div>
        </div>
        <button class="btn-danger" data-id="${u.id}">Удалить</button>
      `;
      r.querySelector('button').addEventListener('click', async () => {
        if (!confirm(`Удалить пользователя "${name}"? Все его чаты также будут удалены.`)) return;
        try { await api('DELETE', `/api/owner/users/${u.id}`); loadUsers(); showToast('Пользователь удалён'); }
        catch (e) { showToast(e.message); }
      });
      wrap.appendChild(r);
    }
  } catch (e) { showToast(e.message); }
}

// ── Staff ─────────────────────────────────────
// ── Сотрудники: аккордеон «должность + имя» → детали (логин/пароль/действия) ──
const STAFF_ROLE_META = { owner: ['👑', 'Владелец'], manager: ['🧭', 'Менеджер'], lawyer: ['⚖️', 'Юрист'] };
let STAFF_CACHE = [];
let STAFF_OPEN_ID = null;   // какой сотрудник сейчас раскрыт
let LOGIN_STAFF_ID = null;  // для модалки смены логина

async function copyText(text, okMsg) {
  try {
    await navigator.clipboard.writeText(text);
    showToast(okMsg || 'Скопировано');
  } catch {
    // Фолбэк для окружений без clipboard API
    const ta = document.createElement('textarea');
    ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); showToast(okMsg || 'Скопировано'); }
    catch { showToast('Не удалось скопировать'); }
    document.body.removeChild(ta);
  }
}

function genPassword(len = 12) {
  const abc = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';  // без похожих 0/O/1/l
  const arr = new Uint32Array(len);
  (window.crypto?.getRandomValues) ? crypto.getRandomValues(arr)
                                   : arr.forEach((_, i) => arr[i] = Math.floor(Math.random() * 4294967296));
  let out = '';
  for (let i = 0; i < len; i++) out += abc[arr[i] % abc.length];
  return out;
}

async function loadStaff() {
  try {
    STAFF_CACHE = await api('GET', '/api/owner/staff');
    renderStaffList();
  } catch (e) { showToast(e.message); }
}

function renderStaffList() {
  const wrap = $('staffList');
  const q = ($('staffSearch')?.value || '').trim().toLowerCase();
  let list = q
    ? STAFF_CACHE.filter(s => (s.full_name || '').toLowerCase().includes(q) || (s.login || '').toLowerCase().includes(q))
    : STAFF_CACHE.slice();
  if (!list.length) {
    wrap.innerHTML = `<div class="staff-empty">${STAFF_CACHE.length ? 'Никого не найдено' : 'Нет сотрудников'}</div>`;
    return;
  }
  const rank = { owner: 0, manager: 1, lawyer: 2 };
  list.sort((a, b) => (rank[a.role] - rank[b.role]) || a.full_name.localeCompare(b.full_name, 'ru'));
  wrap.innerHTML = '';
  for (const s of list) wrap.appendChild(staffItemEl(s));
}

function staffItemEl(s) {
  const [icon, roleName] = STAFF_ROLE_META[s.role] || ['·', s.role];
  const isSelf = s.id === ME.id;
  const open = s.id === STAFF_OPEN_ID;
  const pwd = s.password_plain;

  const item = document.createElement('div');
  item.className = 'staff-item' + (open ? ' open' : '') + (s.is_active ? '' : ' inactive');

  const head = document.createElement('button');
  head.className = 'staff-head';
  head.innerHTML = `
    <span class="staff-badge role-${s.role}">${icon}</span>
    <span class="staff-head-main">
      <span class="staff-head-name">${escapeHtml(s.full_name)}${isSelf ? ' <span class="staff-you">вы</span>' : ''}</span>
      <span class="staff-head-role">${roleName}${s.is_active ? '' : ' · отключён'}</span>
    </span>
    <span class="staff-dot ${s.is_online ? 'on' : ''}"></span>
    <span class="staff-chevron">▾</span>`;
  head.addEventListener('click', () => {
    STAFF_OPEN_ID = open ? null : s.id;
    renderStaffList();
  });
  item.appendChild(head);

  const detail = document.createElement('div');
  detail.className = 'staff-detail';
  detail.innerHTML = `
    <div class="staff-kv">
      <span class="staff-k">Логин</span>
      <span class="staff-v mono">${escapeHtml(s.login)}</span>
      <button class="staff-copy" data-copy="${escapeHtml(s.login)}" title="Копировать">⧉</button>
    </div>
    <div class="staff-kv">
      <span class="staff-k">Пароль</span>
      ${pwd
        ? `<span class="staff-v mono">${escapeHtml(pwd)}</span><button class="staff-copy" data-copy="${escapeHtml(pwd)}" title="Копировать">⧉</button>`
        : `<span class="staff-v staff-hidden">скрыт · нажмите «Сменить пароль», чтобы задать</span>`}
    </div>
    ${s.role === 'lawyer' && s.specialization ? `<div class="staff-kv"><span class="staff-k">Специализация</span><span class="staff-v">${escapeHtml(s.specialization)}</span></div>` : ''}
    <div class="staff-kv"><span class="staff-k">Статус</span><span class="staff-v">${s.is_online ? '🟢 онлайн' : '⚫ оффлайн'} · ${s.is_active ? 'активен' : '❌ отключён'}</span></div>
    ${pwd ? `<button class="btn-secondary staff-copyboth">📋 Скопировать логин и пароль</button>` : ''}
    <div class="staff-actions">
      <button class="btn-secondary" data-act="login">✏️ Изменить логин</button>
      <button class="btn-secondary" data-act="pwd">🔑 Сменить пароль</button>
      ${!isSelf ? (s.is_active
        ? `<button class="btn-danger" data-act="disable">Отключить</button>`
        : `<button class="btn-secondary" data-act="enable">Включить</button>`) : ''}
      ${!isSelf ? `<button class="btn-danger" data-act="del">🗑 Удалить</button>` : ''}
    </div>`;

  detail.querySelectorAll('.staff-copy').forEach(b =>
    b.addEventListener('click', () => copyText(b.dataset.copy)));
  const both = detail.querySelector('.staff-copyboth');
  if (both) both.addEventListener('click', () => copyText(`Логин: ${s.login}\nПароль: ${pwd}`, 'Логин и пароль скопированы'));

  detail.querySelectorAll('.staff-actions button').forEach(b => {
    b.addEventListener('click', async () => {
      const act = b.dataset.act;
      if (act === 'login') { openLoginModal(s); return; }
      if (act === 'pwd') { openResetModal(s); return; }
      if (act === 'disable') {
        if (!confirm('Отключить сотрудника? Он потеряет доступ к панели, но останется в списке — позже можно включить.')) return;
        try { await api('PATCH', `/api/owner/staff/${s.id}`, { is_active: false }); await loadStaff(); showToast('Отключён'); }
        catch (e) { showToast(e.message); }
      } else if (act === 'enable') {
        try { await api('PATCH', `/api/owner/staff/${s.id}`, { is_active: true }); await loadStaff(); showToast('Включён'); }
        catch (e) { showToast(e.message); }
      } else if (act === 'del') {
        if (!confirm(`Удалить «${s.full_name}» навсегда? Действие необратимо, его чаты вернутся в общий пул.`)) return;
        try { await api('DELETE', `/api/owner/staff/${s.id}`); STAFF_OPEN_ID = null; await loadStaff(); showToast('Удалён'); }
        catch (e) { showToast(e.message); }
      }
    });
  });

  item.appendChild(detail);
  return item;
}

function openResetModal(s) {
  RESET_STAFF_ID = s.id;
  $('resetPwdSub').textContent = `${s.full_name} · ${STAFF_ROLE_META[s.role]?.[1] || s.role}`;
  $('resetPwdNew').value = '';
  $('resetPwdError').textContent = '';
  $('resetPwdModal').classList.remove('hidden');
}

function openLoginModal(s) {
  LOGIN_STAFF_ID = s.id;
  $('loginModalSub').textContent = `${s.full_name} · текущий логин: ${s.login}`;
  $('newLoginInput').value = s.login;
  $('loginModalError').textContent = '';
  $('loginModal').classList.remove('hidden');
}

$('staffSearch').addEventListener('input', renderStaffList);

$('addStaffBtn').addEventListener('click', () => {
  $('stRole').value = 'lawyer'; $('stName').value = ''; $('stLogin').value = '';
  $('stPassword').value = ''; $('stSpec').value = ''; $('stTgId').value = '';
  $('stError').textContent = '';
  $('staffModal').classList.remove('hidden');
});
$('stCancel').addEventListener('click', () => $('staffModal').classList.add('hidden'));
$('stSave').addEventListener('click', async () => {
  const body = {
    role: $('stRole').value,
    full_name: $('stName').value.trim(),
    login: $('stLogin').value.trim(),
    password: $('stPassword').value,
    specialization: $('stSpec').value.trim() || null,
    telegram_id: $('stTgId').value ? parseInt($('stTgId').value) : null,
  };
  if (!body.full_name || !body.login || !body.password) {
    $('stError').textContent = 'Заполните ФИО, логин и пароль'; return;
  }
  try { await api('POST', '/api/owner/staff', body); $('staffModal').classList.add('hidden'); loadStaff(); showToast('Создано'); }
  catch (e) { $('stError').textContent = e.message; }
});

// Reset staff password modal
$('resetPwdCancel').addEventListener('click', () => $('resetPwdModal').classList.add('hidden'));
$('resetPwdGen').addEventListener('click', () => {
  $('resetPwdNew').value = genPassword(12);
  $('resetPwdError').textContent = '';
});
$('resetPwdSave').addEventListener('click', async () => {
  const pwd = $('resetPwdNew').value;
  if (pwd.length < 8) { $('resetPwdError').textContent = 'Минимум 8 символов'; return; }
  try {
    await api('POST', `/api/owner/staff/${RESET_STAFF_ID}/reset-password`, { new_password: pwd });
    $('resetPwdModal').classList.add('hidden');
    STAFF_OPEN_ID = RESET_STAFF_ID;   // оставляем карточку раскрытой — виден новый пароль
    await loadStaff();
    showToast('Пароль изменён');
  } catch (e) { $('resetPwdError').textContent = e.message; }
});

// Change staff login modal
$('loginModalCancel').addEventListener('click', () => $('loginModal').classList.add('hidden'));
$('loginModalSave').addEventListener('click', async () => {
  const v = $('newLoginInput').value.trim();
  if (v.length < 3) { $('loginModalError').textContent = 'Минимум 3 символа'; return; }
  try {
    await api('PATCH', `/api/owner/staff/${LOGIN_STAFF_ID}`, { login: v });
    $('loginModal').classList.add('hidden');
    STAFF_OPEN_ID = LOGIN_STAFF_ID;
    await loadStaff();
    showToast('Логин изменён');
  } catch (e) { $('loginModalError').textContent = e.message; }
});

// Change my own password
$('changePwdBtn').addEventListener('click', () => {
  $('pwdOld').value = ''; $('pwdNew').value = ''; $('pwdError').textContent = '';
  $('pwdModal').classList.remove('hidden');
});
$('pwdCancel').addEventListener('click', () => $('pwdModal').classList.add('hidden'));
$('pwdSave').addEventListener('click', async () => {
  const oldp = $('pwdOld').value, newp = $('pwdNew').value;
  if (!oldp || newp.length < 8) { $('pwdError').textContent = 'Заполните, новый пароль ≥ 8'; return; }
  try {
    const r = await api('POST', '/api/staff/change-password', { old_password: oldp, new_password: newp });
    if (r.token) { TOKEN = r.token; localStorage.setItem(TOKEN_KEY, TOKEN); }
    $('pwdModal').classList.add('hidden');
    showToast('Пароль обновлён');
  } catch (e) { $('pwdError').textContent = e.message; }
});

// ── Chats oversight (Сотрудники → их чаты → переписка live) ───────────
const OW_ROLE_META = { owner: ['👑', 'Владелец'], manager: ['🧭', 'Менеджер'], lawyer: ['⚖️', 'Юрист'] };

function owRoleLabel(t, name) {
  if (t === 'user') return `👤 ${name || 'Клиент'}`;
  if (t === 'lawyer') return `⚖️ ${name || 'Юрист'}`;
  if (t === 'manager') return `🧭 ${name || 'Менеджер'}`;
  if (t === 'ai') return '🤖 ИИ-Советник';
  return name || '';
}
function owRoleColor(t) {
  return t === 'user' ? '#a78bfa' : t === 'lawyer' ? '#60a5fa' : t === 'manager' ? '#fbbf24' : t === 'ai' ? '#22d3ee' : '#94a3b8';
}

function owMessageEl(m) {
  const t = m.sender_type;
  const kind = t === 'user' ? 'from-user' : t === 'system' ? 'from-system' : 'from-staff';
  const w = document.createElement('div'); if (m.id != null) w.dataset.mid = m.id;
  w.className = `msg-wrap ${kind}`;
  if (t !== 'system') {
    const s = document.createElement('div'); s.className = 'msg-sender';
    s.textContent = owRoleLabel(t, m.sender_name);
    s.style.color = owRoleColor(t);
    w.appendChild(s);
  }
  const b = document.createElement('div'); b.className = 'msg-bubble';
  if (m.file_url && m.message_type !== 'text' && m.message_type !== 'system') {
    b.innerHTML = `<a href="${escapeHtml(m.file_url)}" target="_blank" style="color:inherit;text-decoration:underline">${escapeHtml(m.file_name || 'Файл')}</a>`;
    const _cap = m.caption || (m.message_type === 'image' ? m.content : null); if (_cap) { const c = document.createElement('div'); c.style.marginTop = '4px'; c.textContent = _cap; b.appendChild(c); }
  } else b.textContent = m.content || '';
  w.appendChild(b);
  if (m.created_at && t !== 'system') {
    const tm = document.createElement('div'); tm.className = 'msg-time'; tm.textContent = fmtTime(m.created_at); w.appendChild(tm);
  }
  return w;
}

function owShowLevel(level) {
  $('owStaffList').classList.toggle('hidden', level !== 'staff');
  $('owChatList').classList.toggle('hidden', level !== 'chats');
  $('owChatView').classList.toggle('hidden', level !== 'chat');
  owRenderBreadcrumb(level);
}

function owRenderBreadcrumb(level) {
  const bc = $('owBreadcrumb');
  if (level === 'staff') {
    bc.innerHTML = `<span class="ow-bc-cur">Сотрудники</span><span class="ow-bc-hint">— выберите, чтобы увидеть чаты</span>`;
  } else if (level === 'chats') {
    bc.innerHTML = `<button class="ow-bc-back" data-to="staff">← Сотрудники</button><span class="ow-bc-sep">/</span><span class="ow-bc-cur">${escapeHtml(OW_CURRENT_STAFF?.full_name || '')}</span>`;
  } else {
    bc.innerHTML = `<button class="ow-bc-back" data-to="chats">← ${escapeHtml(OW_CURRENT_STAFF?.full_name || 'Назад')}</button><span class="ow-bc-sep">/</span><span class="ow-bc-cur">Переписка</span><span class="ow-live">Прямой эфир</span>`;
  }
  bc.querySelectorAll('.ow-bc-back').forEach(b => b.addEventListener('click', () => {
    OW_CURRENT_CHAT_ID = null;
    if (b.dataset.to === 'staff') owShowLevel('staff');
    else if (_owReloadChats) _owReloadChats();
  }));
}

// Level 1 — staff list (entry from the tab)
async function loadAllChats() {
  OW_CURRENT_STAFF = null;
  OW_CURRENT_CHAT_ID = null;
  owShowLevel('staff');
  $('owStaffList').innerHTML = `<div style="padding:24px;text-align:center;color:var(--text-secondary)">Загрузка…</div>`;
  try {
    const list = await api('GET', '/api/owner/staff');
    owRenderStaff(list);
  } catch (e) { showToast(e.message); }
}

function owRenderStaff(list) {
  const wrap = $('owStaffList');
  if (!list.length) { wrap.innerHTML = `<div style="padding:24px;text-align:center;color:var(--text-secondary)">Сотрудников нет.</div>`; return; }
  const groups = {};
  for (const s of list) (groups[s.role] || (groups[s.role] = [])).push(s);
  const order = [['owner', '👑 Владельцы'], ['manager', '🧭 Менеджеры'], ['lawyer', '⚖️ Юристы']];
  wrap.innerHTML = '';

  // ИИ-чаты — отдельная категория сверху
  const aiTitle = document.createElement('div');
  aiTitle.className = 'ow-cat-title';
  aiTitle.innerHTML = `🤖 Автоматические`;
  wrap.appendChild(aiTitle);
  const aiRow = document.createElement('div');
  aiRow.className = 'data-row ow-row-click';
  aiRow.innerHTML = `
    <div class="ow-staff-av">🤖</div>
    <div class="grow">
      <div class="data-name">ИИ-Советник</div>
      <div class="data-sub">Все чаты пользователей с ИИ</div>
    </div>
    <svg class="ow-chevron" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18l6-6-6-6"/></svg>`;
  aiRow.addEventListener('click', openOwAi);
  wrap.appendChild(aiRow);

  for (const [role, title] of order) {
    const arr = groups[role] || [];
    if (!arr.length) continue;
    const h = document.createElement('div'); h.className = 'ow-cat-title';
    h.innerHTML = `${title} <span class="ow-cat-count">${arr.length}</span>`;
    wrap.appendChild(h);
    for (const s of arr) {
      const r = document.createElement('div'); r.className = 'data-row ow-row-click';
      if (!s.is_active) r.style.opacity = '0.5';
      const emoji = (OW_ROLE_META[s.role] || ['👤'])[0];
      r.innerHTML = `
        <div class="ow-staff-av">${emoji}</div>
        <div class="grow">
          <div class="data-name">${escapeHtml(s.full_name)}</div>
          <div class="data-sub">@${escapeHtml(s.login)}${s.specialization ? ' · ' + escapeHtml(s.specialization) : ''} · ${s.is_online ? '🟢 онлайн' : '⚫ оффлайн'}${s.is_active ? '' : ' · отключён'}</div>
        </div>
        <svg class="ow-chevron" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18l6-6-6-6"/></svg>`;
      r.addEventListener('click', () => openOwStaff(s));
      wrap.appendChild(r);
    }
  }
}

// Level 2 — chats of the selected staff member
async function openOwStaff(s) {
  if (!s) return;
  OW_CURRENT_STAFF = s;
  OW_CURRENT_CHAT_ID = null;
  _owReloadChats = () => openOwStaff(s);
  owShowLevel('chats');
  $('owChatList').innerHTML = `<div style="padding:24px;text-align:center;color:var(--text-secondary)">Загрузка…</div>`;
  try {
    const data = await api('GET', `/api/owner/chats/by-staff/${s.id}`);
    owRenderChats(data.chats || []);
  } catch (e) { showToast(e.message); }
}

// Level 2 (alt) — all AI chats
async function openOwAi() {
  OW_CURRENT_STAFF = { full_name: 'Чаты с ИИ' };
  OW_CURRENT_CHAT_ID = null;
  _owReloadChats = openOwAi;
  owShowLevel('chats');
  $('owChatList').innerHTML = `<div style="padding:24px;text-align:center;color:var(--text-secondary)">Загрузка…</div>`;
  try {
    const chats = await api('GET', '/api/owner/ai-chats');
    owRenderChats(chats || []);
  } catch (e) { showToast(e.message); }
}

function owRenderChats(chats) {
  const wrap = $('owChatList');
  if (!chats.length) { wrap.innerHTML = `<div style="padding:24px;text-align:center;color:var(--text-secondary)">У этого сотрудника пока нет чатов.</div>`; return; }
  wrap.innerHTML = '';
  for (const c of chats) {
    const u = c.user || {};
    const name = [u.first_name, u.last_name].filter(Boolean).join(' ') || u.username || 'Клиент';
    const r = document.createElement('div'); r.className = 'data-row ow-row-click';
    r.innerHTML = `
      <div class="grow">
        <div class="data-name">${escapeHtml(name)}<span class="ow-type-tag ow-type-${c.chat_type}">${escapeHtml(c.type_label)}</span></div>
        <div class="data-sub">${escapeHtml((c.last_message?.content || 'Нет сообщений').slice(0, 60))} · ${c.message_count} · ${fmtTime(c.updated_at)}</div>
      </div>
      <svg class="ow-chevron" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18l6-6-6-6"/></svg>`;
    r.addEventListener('click', () => openOwChat(c));
    wrap.appendChild(r);
  }
}

// Level 3 — full conversation, live
async function openOwChat(c) {
  OW_CURRENT_CHAT_ID = c.id;
  owShowLevel('chat');
  const u = c.user || {};
  const name = [u.first_name, u.last_name].filter(Boolean).join(' ') || u.username || 'Клиент';
  const parts = [`👤 ${escapeHtml(name)}`];
  if (c.lawyer_name) parts.push(`⚖️ ${escapeHtml(c.lawyer_name)}`);
  if (c.manager_name) parts.push(`🧭 ${escapeHtml(c.manager_name)}`);
  $('owChatHead').innerHTML = `<div class="ow-chat-head-title">${escapeHtml(c.type_label)}</div><div class="ow-chat-head-sub">${parts.join(' · ')}</div>`;
  const wrap = $('owMessages');
  wrap.innerHTML = `<div style="padding:20px;text-align:center;color:var(--text-secondary)">Загрузка…</div>`;
  try {
    const msgs = await api('GET', `/api/manager/chats/${c.id}/messages`);
    wrap.innerHTML = '';
    msgs.forEach(m => wrap.appendChild(owMessageEl(m)));
    wrap.scrollTop = wrap.scrollHeight;
  } catch (e) { showToast(e.message); }
}

function owAddMessageIfNew(m) {
  if (m == null || m.id == null) return;
  const wrap = $('owMessages'); if (!wrap || wrap.querySelector(`[data-mid="${m.id}"]`)) return;
  const el = owMessageEl(m); el.classList.add('msg-new'); wrap.appendChild(el);
  const dist = wrap.scrollHeight - wrap.scrollTop - wrap.clientHeight;
  if (dist < 160) wrap.scrollTo({ top: wrap.scrollHeight, behavior: 'smooth' });
}
function owApplyEdit(m) {
  const el = $('owMessages')?.querySelector(`[data-mid="${m.id}"]`);
  if (el) el.replaceWith(owMessageEl(m));
}

// ── Broadcast ─────────────────────────────────
async function loadBroadcasts() {
  try {
    const list = await api('GET', '/api/owner/broadcasts');
    const wrap = $('broadcastsList');
    if (!list.length) { wrap.innerHTML = '<div style="padding:14px;color:var(--text-secondary);font-size:13px">Истории нет.</div>'; return; }
    wrap.innerHTML = '';
    for (const b of list) {
      const r = document.createElement('div'); r.className = 'data-row';
      const status = { done: '✅', sending: '⏳', failed: '❌', draft: '—' }[b.status] || b.status;
      r.innerHTML = `
        <div class="grow">
          <div class="data-name">${status} ${escapeHtml((b.content || '').slice(0, 80))}${b.content && b.content.length > 80 ? '…' : ''}</div>
          <div class="data-sub">Отправлено ${b.recipients_sent}/${b.recipients_total} · Ошибок ${b.recipients_failed} · ${fmtTime(b.created_at)}</div>
        </div>
      `;
      wrap.appendChild(r);
    }
  } catch (e) { showToast(e.message); }
}

$('broadcastSendBtn').addEventListener('click', async () => {
  const text = $('broadcastText').value.trim();
  if (!text) { showToast('Текст пустой'); return; }
  if (!confirm('Отправить рассылку всем пользователям?')) return;
  try {
    await api('POST', '/api/owner/broadcasts', { content: text });
    $('broadcastText').value = '';
    showToast('Рассылка запущена');
    loadBroadcasts();
  } catch (e) { showToast(e.message); }
});

// ── Channels ──────────────────────────────────
async function loadChannels() {
  try {
    const list = await api('GET', '/api/owner/channels');
    const wrap = $('channelsList');
    if (!list.length) { wrap.innerHTML = '<div style="padding:24px;text-align:center;color:var(--text-secondary)">Каналов нет.</div>'; return; }
    wrap.innerHTML = '';
    for (const c of list) {
      const r = document.createElement('div'); r.className = 'data-row';
      r.innerHTML = `
        <div class="grow">
          <div class="data-name">${escapeHtml(c.title)}</div>
          <div class="data-sub">${c.username ? '@' + escapeHtml(c.username) + ' · ' : ''}id: ${c.channel_id}${c.invite_url ? ' · ' + escapeHtml(c.invite_url) : ''}</div>
        </div>
        <button class="btn-danger" data-id="${c.id}">Удалить</button>
      `;
      r.querySelector('button').addEventListener('click', async () => {
        if (!confirm(`Удалить канал "${c.title}"?`)) return;
        try { await api('DELETE', `/api/owner/channels/${c.id}`); loadChannels(); showToast('Канал удалён'); }
        catch (e) { showToast(e.message); }
      });
      wrap.appendChild(r);
    }
  } catch (e) { showToast(e.message); }
}

$('addChannelBtn').addEventListener('click', () => {
  $('chId').value=''; $('chUsername').value=''; $('chTitle').value=''; $('chInvite').value='';
  $('chError').textContent='';
  $('channelModal').classList.remove('hidden');
});
$('chCancel').addEventListener('click', () => $('channelModal').classList.add('hidden'));
$('chSave').addEventListener('click', async () => {
  const body = {
    channel_id: parseInt($('chId').value),
    username: $('chUsername').value.trim().replace(/^@/, '') || null,
    title: $('chTitle').value.trim(),
    invite_url: $('chInvite').value.trim() || null,
    is_active: true,
  };
  if (!body.channel_id || !body.title) { $('chError').textContent='Заполните id и название'; return; }
  try { await api('POST', '/api/owner/channels', body); $('channelModal').classList.add('hidden'); loadChannels(); showToast('Канал добавлен'); }
  catch (e) { $('chError').textContent = e.message; }
});

// ── Settings ──────────────────────────────────
async function loadSettings() {
  try {
    const s = await api('GET', '/api/owner/settings');
    $('settingSubEnabled').checked = s.subscription_check_enabled === '1';
  } catch (e) { showToast(e.message); }
}
$('settingSubEnabled').addEventListener('change', async (e) => {
  try {
    await api('PATCH', '/api/owner/settings/subscription_check_enabled',
      { value: e.target.checked ? '1' : '0' });
    showToast('Сохранено');
  } catch (err) { showToast(err.message); }
});

// ── Support (как у юриста: список всех пользователей → чат) ────────────
const SUP_GRADIENTS = [
  'linear-gradient(135deg,#6366f1,#4338ca)', 'linear-gradient(135deg,#ec4899,#be185d)',
  'linear-gradient(135deg,#06b6d4,#0e7490)', 'linear-gradient(135deg,#8b5cf6,#6d28d9)',
  'linear-gradient(135deg,#14b8a6,#0f766e)', 'linear-gradient(135deg,#f59e0b,#b45309)',
  'linear-gradient(135deg,#ef4444,#b91c1c)', 'linear-gradient(135deg,#84cc16,#4d7c0f)',
];
function supInitials(name) {
  const p = String(name || '').trim().split(/\s+/);
  return ((p[0]?.[0] || '') + (p[1]?.[0] || '')).toUpperCase() || '?';
}
function supColor(name) {
  const s = String(name || ''); let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return Math.abs(h) % 8;
}
function supTime(iso) {
  if (!iso) return '';
  const d = new Date(iso), now = new Date(), sec = Math.floor((now - d) / 1000);
  if (sec < 60) return 'только что';
  if (sec < 3600) return `${Math.floor(sec / 60)} мин`;
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });
}

function showSupportLevel(level) {
  $('supListView').classList.toggle('hidden', level !== 'list');
  $('supChatView').classList.toggle('hidden', level !== 'chat');
  if (level === 'list') { CURRENT_SUPPORT_ID = null; CURRENT_SUPPORT_USER = null; }
}

function openSupportTab() {
  showSupportLevel('list');
  loadSupportChats();
}

// Только данные + список (НЕ меняет уровень — вызывается и из WS).
async function loadSupportChats() {
  try { SUPPORT_USERS = await api('GET', '/api/owner/support-users'); renderSupportUsers(); }
  catch (e) { showToast(e.message); }
}

function renderSupportUsers() {
  const wrap = $('supList');
  if (!SUPPORT_USERS.length) {
    wrap.innerHTML = `<div style="padding:24px;color:var(--text-secondary);text-align:center;font-size:13px">Пользователей пока нет.</div>`;
    return;
  }
  const withMsgs = SUPPORT_USERS.filter(u => u.message_count > 0).length;
  $('supMeta').innerHTML = `Нажмите на пользователя, чтобы открыть чат поддержки.` +
    (withMsgs ? ` <span style="color:var(--accent-hover)">· ${withMsgs} с перепиской</span>` : '');
  wrap.innerHTML = '';
  SUPPORT_USERS.forEach((u, i) => {
    const name = [u.first_name, u.last_name].filter(Boolean).join(' ') || u.username || `Пользователь #${u.user_id}`;
    const last = u.last_message;
    const preview = (last?.content || last?.caption) || (u.message_count ? '[вложение]' : 'Нет сообщений');
    const time = supTime(last?.created_at || u.updated_at || u.created_at);
    const item = document.createElement('div');
    item.className = 'lawyer-chat-item' + (u.chat_id && u.chat_id === CURRENT_SUPPORT_ID ? ' active' : '');
    item.style.setProperty('--item-delay', `${Math.min(i * 35, 300)}ms`);
    const color = supColor(name);
    item.innerHTML = `
      <div class="lawyer-chat-item-avatar" data-color="${color}">${
        u.photo_url ? `<img src="${escapeHtml(u.photo_url)}" alt=""/>` : escapeHtml(supInitials(name))
      }</div>
      <div class="lawyer-chat-item-body">
        <div class="lawyer-chat-item-top">
          <div class="lawyer-chat-item-name">${escapeHtml(name)}</div>
          <div class="lawyer-chat-item-time">${escapeHtml(time)}</div>
        </div>
        <div class="lawyer-chat-item-preview">${escapeHtml(preview)}</div>
        <div class="lawyer-chat-item-badges">
          ${u.message_count > 0 ? `<span class="lawyer-badge count">${u.message_count} сообщ.</span>` : `<span class="lawyer-badge free">🆕 новый</span>`}
          ${u.username ? `<span class="lawyer-badge count">@${escapeHtml(u.username)}</span>` : ''}
        </div>
      </div>`;
    item.addEventListener('click', () => openSupportChat(u));
    wrap.appendChild(item);
  });
}

async function openSupportChat(u) {
  CURRENT_SUPPORT_USER = u;
  let chatId = u.chat_id;
  if (!chatId) {
    try { const r = await api('POST', '/api/owner/support/open', { user_id: u.user_id }); chatId = r.chat_id; u.chat_id = chatId; }
    catch (e) { showToast(e.message); return; }
  }
  CURRENT_SUPPORT_ID = chatId;
  const name = [u.first_name, u.last_name].filter(Boolean).join(' ') || u.username || `Пользователь #${u.user_id}`;
  $('supChatName').textContent = name;
  $('supReplyInput').value = '';
  showSupportLevel('chat');
  const wrap = $('supMessages');
  wrap.innerHTML = `<div style="padding:20px;text-align:center;color:var(--text-secondary)">Загрузка…</div>`;
  try {
    const msgs = await api('GET', `/api/manager/chats/${chatId}/messages`);
    wrap.innerHTML = '';
    msgs.forEach(m => wrap.appendChild(supportMessageEl(m)));
    wrap.scrollTop = wrap.scrollHeight;
  } catch (e) { showToast(e.message); }
  if (window.innerWidth >= 900) setTimeout(() => $('supReplyInput').focus(), 50);
}

async function sendSupportReply() {
  const input = $('supReplyInput');
  const text = input.value.trim();
  if (!text || !CURRENT_SUPPORT_ID) return;
  input.value = '';
  try {
    // ManagerDep допускает роль owner — отправляем как сотрудник.
    const m = await api('POST', `/api/manager/chats/${CURRENT_SUPPORT_ID}/messages`, { content: text });
    supAddMessageIfNew(m);
    loadSupportChats();
  } catch (e) { showToast(e.message); }
}

function supAddMessageIfNew(m) {
  if (m == null || m.id == null) return;
  const wrap = $('supMessages');
  if (!wrap || wrap.querySelector(`[data-mid="${m.id}"]`)) return;
  const el = supportMessageEl(m); el.classList.add('msg-new'); wrap.appendChild(el);
  const dist = wrap.scrollHeight - wrap.scrollTop - wrap.clientHeight;
  if (dist < 160) wrap.scrollTo({ top: wrap.scrollHeight, behavior: 'smooth' });
}

$('supBack').addEventListener('click', () => { showSupportLevel('list'); renderSupportUsers(); });
$('supReplyBtn').addEventListener('click', sendSupportReply);
$('supReplyInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendSupportReply(); }
});

function supportMessageEl(m) {
  const w = document.createElement('div');
  if (m.id != null) w.dataset.mid = m.id;
  const kind = m.sender_type === 'user' ? 'from-user' :
               m.sender_type === 'system' ? 'from-system' : 'from-staff';
  w.className = `msg-wrap ${kind}`;
  if (kind === 'from-staff' && m.sender_name) {
    const s = document.createElement('div'); s.className = 'msg-sender'; s.textContent = m.sender_name; w.appendChild(s);
  }
  const b = document.createElement('div'); b.className = 'msg-bubble';
  if (m.file_url && m.message_type !== 'text' && m.message_type !== 'system') {
    b.innerHTML = `<a href="${m.file_url}" target="_blank" style="color:inherit;text-decoration:underline">${escapeHtml(m.file_name || 'Файл')}</a>`;
    const _cap = m.caption || (m.message_type === 'image' ? m.content : null);
    if (_cap) { const c = document.createElement('div'); c.style.marginTop = '4px'; c.textContent = _cap; b.appendChild(c); }
  } else {
    b.textContent = m.content || '';
  }
  w.appendChild(b);
  if (m.created_at) {
    const t = document.createElement('div'); t.className = 'msg-time'; t.textContent = fmtTime(m.created_at); w.appendChild(t);
  }
  return w;
}

// ── WebSocket (live support + chat events) ─────────────────────────────
function connectWS() {
  if (!TOKEN) return;
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  WS = new WebSocket(`${proto}://${location.host}/ws/staff?token=${encodeURIComponent(TOKEN)}`);
  WS.onmessage = (e) => {
    let data; try { data = JSON.parse(e.data); } catch { return; }
    if (data.type === 'message' || data.type === 'new_message') {
      if (data.chat_id === CURRENT_SUPPORT_ID) supAddMessageIfNew(data);   // поддержка live
      if (data.chat_id === OW_CURRENT_CHAT_ID) owAddMessageIfNew(data);    // обзор чатов live
      loadSupportChats();
    } else if (data.type === 'edit') {
      if (data.chat_id === CURRENT_SUPPORT_ID) {
        const sel = $('supMessages')?.querySelector(`[data-mid="${data.id}"]`);
        if (sel) sel.replaceWith(supportMessageEl(data));
      }
      if (data.chat_id === OW_CURRENT_CHAT_ID) owApplyEdit(data);
      loadSupportChats();
    } else if (data.type === 'delete') {
      document.querySelectorAll(`[data-mid="${data.message_id}"]`).forEach(el => {
        const b = el.querySelector('.msg-bubble');
        if (b) { b.textContent = 'Сообщение удалено'; b.style.opacity = '0.55'; b.style.fontStyle = 'italic'; }
        el.querySelector('.msg-time')?.remove();
      });
      loadSupportChats();
    }
  };
  WS.onclose = () => setTimeout(connectWS, 3000);
  setInterval(() => { try { WS?.send(JSON.stringify({ type: 'ping' })); } catch {} }, 25000);
}

checkAuth();
