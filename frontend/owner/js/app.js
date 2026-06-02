/* Owner panel — full administrative control. */

const TOKEN_KEY = 'yurist_owner_token';
let TOKEN = localStorage.getItem(TOKEN_KEY) || '';
let ME = null;
let RESET_STAFF_ID = null;
let WS = null;
let SUPPORT_CHATS = [];
let CURRENT_SUPPORT_ID = null;

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

// ── Stats ─────────────────────────────────────
async function loadStats() {
  try {
    const s = await api('GET', '/api/owner/stats');
    const grid = $('statsGrid');
    const entries = [
      ['Пользователи', s.total_users],
      ['Сообщений', s.total_messages],
      ['ИИ-чатов', s.ai_chats],
      ['Чатов юристов', s.lawyer_chats],
      ['Чатов подбора', s.match_chats],
      ['Юристов', s.lawyer_count],
      ['Менеджеров', s.manager_count],
      ['Владельцев', s.owner_count],
    ];
    grid.innerHTML = entries.map(([label, n]) =>
      `<div class="stat-card"><div class="stat-num">${n ?? 0}</div><div class="stat-label">${label}</div></div>`
    ).join('');
  } catch (e) { showToast(e.message); }
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

// ── All chats ─────────────────────────────────
async function loadAllChats() {
  try {
    const list = await api('GET', '/api/manager/lawyer-chats');
    const wrap = $('chatsList');
    if (!list.length) { wrap.innerHTML = '<div style="padding:24px;text-align:center;color:var(--text-secondary)">Нет чатов</div>'; return; }
    wrap.innerHTML = '';
    for (const c of list) {
      const r = document.createElement('div'); r.className = 'data-row';
      const u = c.user || {};
      const name = [u.first_name, u.last_name].filter(Boolean).join(' ') || u.username || `User #${c.user_id}`;
      r.innerHTML = `
        <div class="grow">
          <div class="data-name">${escapeHtml(name)}</div>
          <div class="data-sub">${c.lawyer_staff_id ? 'юрист #' + c.lawyer_staff_id : '⚠ не назначен'} · ${c.message_count} сообщ. · ${fmtTime(c.updated_at)}</div>
        </div>
      `;
      wrap.appendChild(r);
    }
  } catch (e) { showToast(e.message); }
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
      loadSupportChats();
    } else if (data.type === 'edit') {
      const wrap = $(`scm-${data.chat_id}`);
      const el = wrap?.querySelector(`[data-mid="${data.id}"]`);
      if (el) el.replaceWith(supportMessageEl(data));
      loadSupportChats();
    } else if (data.type === 'delete') {
      const el = document.querySelector(`[data-mid="${data.message_id}"]`);
      if (el) {
        const b = el.querySelector('.msg-bubble');
        if (b) { b.textContent = 'Сообщение удалено'; b.style.opacity = '0.55'; b.style.fontStyle = 'italic'; }
        el.querySelector('.msg-time')?.remove();
      }
      loadSupportChats();
    }
  };
  WS.onclose = () => setTimeout(connectWS, 3000);
  setInterval(() => { try { WS?.send(JSON.stringify({ type: 'ping' })); } catch {} }, 25000);
}

checkAuth();
