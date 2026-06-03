/* Owner panel — full administrative control. */

const TOKEN_KEY = 'yurist_owner_token';
let TOKEN = localStorage.getItem(TOKEN_KEY) || '';
let ME = null;
let RESET_STAFF_ID = null;
let WS = null;
let SUPPORT_CHATS = [];
let CURRENT_SUPPORT_ID = null;
let OW_CURRENT_STAFF = null;
let OW_CURRENT_CHAT_ID = null;

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
      chats: loadAllChats, support: loadSupportChats, broadcast: loadBroadcasts,
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
async function loadStaff() {
  try {
    const list = await api('GET', '/api/owner/staff');
    const wrap = $('staffList');
    if (!list.length) { wrap.innerHTML = '<div style="padding:24px;text-align:center;color:var(--text-secondary)">Нет сотрудников</div>'; return; }
    wrap.innerHTML = '';
    const roleLabel = { owner: '👑 Владелец', manager: '🧭 Менеджер', lawyer: '⚖️ Юрист' };
    for (const s of list) {
      const r = document.createElement('div');
      r.className = 'data-row';
      if (!s.is_active) r.style.opacity = '0.5';
      const isSelf = s.id === ME.id;
      let actionsHtml = `<button class="btn-secondary" data-act="reset" data-id="${s.id}" data-name="${escapeHtml(s.full_name)}">Сменить пароль</button>`;
      if (!isSelf) {
        if (s.is_active) {
          actionsHtml += `<button class="btn-danger" data-act="disable" data-id="${s.id}">Отключить</button>`;
        } else {
          actionsHtml += `<button class="btn-secondary" data-act="enable" data-id="${s.id}">Включить</button>`;
          actionsHtml += `<button class="btn-danger" data-act="del" data-id="${s.id}" data-name="${escapeHtml(s.full_name)}">Удалить</button>`;
        }
      }
      r.innerHTML = `
        <div class="grow">
          <div class="data-name">${escapeHtml(s.full_name)} · ${roleLabel[s.role] || s.role}</div>
          <div class="data-sub">@${escapeHtml(s.login)} · ${escapeHtml(s.specialization || '')} · TG ${s.telegram_id || '—'} · ${s.is_online ? '🟢' : '⚫'}${!s.is_active ? ' · ❌ отключён' : ''}</div>
        </div>
        <div class="data-actions">${actionsHtml}</div>
      `;
      r.querySelectorAll('button').forEach(btn => {
        btn.addEventListener('click', async () => {
          const id = parseInt(btn.dataset.id);
          const act = btn.dataset.act;
          if (act === 'reset') {
            RESET_STAFF_ID = id;
            $('resetPwdSub').textContent = `Сотрудник: ${btn.dataset.name}`;
            $('resetPwdNew').value = '';
            $('resetPwdError').textContent = '';
            $('resetPwdModal').classList.remove('hidden');
          } else if (act === 'disable') {
            if (!confirm('Отключить сотрудника? Он потеряет доступ к панели, но останется в списке — позже можно включить обратно или удалить.')) return;
            try { await api('PATCH', `/api/owner/staff/${id}`, { is_active: false }); loadStaff(); showToast('Сотрудник отключён'); }
            catch (e) { showToast(e.message); }
          } else if (act === 'enable') {
            try { await api('PATCH', `/api/owner/staff/${id}`, { is_active: true }); loadStaff(); showToast('Сотрудник включён'); }
            catch (e) { showToast(e.message); }
          } else if (act === 'del') {
            if (!confirm(`Удалить сотрудника "${btn.dataset.name}" навсегда? Действие необратимо, его чаты вернутся в общий пул.`)) return;
            try { await api('DELETE', `/api/owner/staff/${id}`); loadStaff(); showToast('Сотрудник удалён'); }
            catch (e) { showToast(e.message); }
          }
        });
      });
      wrap.appendChild(r);
    }
  } catch (e) { showToast(e.message); }
}

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
$('resetPwdSave').addEventListener('click', async () => {
  const pwd = $('resetPwdNew').value;
  if (pwd.length < 8) { $('resetPwdError').textContent = 'Минимум 8 символов'; return; }
  try {
    await api('POST', `/api/owner/staff/${RESET_STAFF_ID}/reset-password`, { new_password: pwd });
    $('resetPwdModal').classList.add('hidden');
    showToast('Пароль сброшен');
  } catch (e) { $('resetPwdError').textContent = e.message; }
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
    if (m.content) { const c = document.createElement('div'); c.style.marginTop = '4px'; c.textContent = m.content; b.appendChild(c); }
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
    else openOwStaff(OW_CURRENT_STAFF);
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
  owShowLevel('chats');
  $('owChatList').innerHTML = `<div style="padding:24px;text-align:center;color:var(--text-secondary)">Загрузка…</div>`;
  try {
    const data = await api('GET', `/api/owner/chats/by-staff/${s.id}`);
    owRenderChats(data.chats || []);
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

// ── Support chats (прямой чат пользователя с владельцем) ───────────────
async function loadSupportChats() {
  try { SUPPORT_CHATS = await api('GET', '/api/owner/support-chats'); renderSupportList(); }
  catch (e) { showToast(e.message); }
}

function renderSupportList() {
  const wrap = $('supportList');
  if (!SUPPORT_CHATS.length) {
    wrap.innerHTML = `<div style="padding:24px;color:var(--text-secondary);text-align:center;font-size:13px">Обращений в поддержку пока нет.</div>`;
    return;
  }
  wrap.innerHTML = '';
  for (const chat of SUPPORT_CHATS) {
    const item = document.createElement('div');
    item.className = 'chat-list-item';
    if (chat.id === CURRENT_SUPPORT_ID) item.classList.add('active');
    const u = chat.user || {};
    const name = [u.first_name, u.last_name].filter(Boolean).join(' ') || u.username || `User #${chat.user_id}`;
    item.innerHTML = `
      <div class="chat-item-name">${escapeHtml(name)}</div>
      <div class="chat-item-preview">${escapeHtml(chat.last_message?.content || 'Нет сообщений')}</div>
      <div class="chat-item-meta">${chat.message_count} сообщ. · ${fmtTime(chat.updated_at)}</div>`;
    item.addEventListener('click', () => openSupportChat(chat));
    wrap.appendChild(item);
  }
}

async function openSupportChat(chat) {
  CURRENT_SUPPORT_ID = chat.id;
  renderSupportList();
  const u = chat.user || {};
  const name = [u.first_name, u.last_name].filter(Boolean).join(' ') || u.username || `User #${chat.user_id}`;
  const detail = $('supportDetail');
  detail.innerHTML = `
    <div class="chat-header-bar" style="display:flex;align-items:center">
      <div style="flex:1">
        <div class="chat-header-name">${escapeHtml(name)}</div>
        <div class="chat-header-meta">${u.username ? '@' + escapeHtml(u.username) : ''} · TG ${u.telegram_id || '—'}</div>
      </div>
    </div>
    <div class="chat-messages" id="scm-${chat.id}"></div>
    <div class="chat-reply-area">
      <textarea class="chat-reply-input" id="sri-${chat.id}" rows="1" placeholder="Ответ пользователю..."></textarea>
      <button class="chat-reply-send" id="srb-${chat.id}">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
          <line x1="22" y1="2" x2="11" y2="13"/><polygon points="22,2 15,22 11,13 2,9"/>
        </svg>
      </button>
    </div>`;
  try {
    const msgs = await api('GET', `/api/manager/chats/${chat.id}/messages`);
    const wrap = $(`scm-${chat.id}`);
    msgs.forEach(m => wrap.appendChild(supportMessageEl(m)));
    wrap.scrollTop = wrap.scrollHeight;
  } catch (e) { showToast(e.message); }

  $(`sri-${chat.id}`).addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendSupportReply(chat.id); }
  });
  $(`srb-${chat.id}`).addEventListener('click', () => sendSupportReply(chat.id));
}

async function sendSupportReply(chatId) {
  const input = $(`sri-${chatId}`);
  if (!input) return;
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  try {
    // ManagerDep допускает роль owner — отправляем как сотрудник.
    const m = await api('POST', `/api/manager/chats/${chatId}/messages`, { content: text });
    addSupportMessageIfNew(chatId, m);
    loadSupportChats();
  } catch (e) { showToast(e.message); }
}

function addSupportMessageIfNew(chatId, m) {
  if (m == null || m.id == null) return;
  const wrap = $(`scm-${chatId}`);
  if (!wrap) return;
  if (wrap.querySelector(`[data-mid="${m.id}"]`)) return;
  wrap.appendChild(supportMessageEl(m));
  wrap.scrollTop = wrap.scrollHeight;
}

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
      if (data.chat_id === CURRENT_SUPPORT_ID) addSupportMessageIfNew(data.chat_id, data);
      if (data.chat_id === OW_CURRENT_CHAT_ID) owAddMessageIfNew(data);   // прямой эфир
      loadSupportChats();
    } else if (data.type === 'edit') {
      const sel = $(`scm-${data.chat_id}`)?.querySelector(`[data-mid="${data.id}"]`);
      if (sel) sel.replaceWith(supportMessageEl(data));
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
