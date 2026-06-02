/* Manager panel — match-chats triage + lawyers CRUD + lawyer-chats view */

const TOKEN_KEY = 'yurist_manager_token';
let TOKEN = localStorage.getItem(TOKEN_KEY) || '';
let ME = null;
let MATCH_CHATS = [], LAWYER_CHATS = [], LAWYERS = [];
let CURRENT_MATCH_ID = null;
let CURRENT_LAWYER_CHAT_ID = null;
let WS = null;
let ASSIGN_USER_ID = null;

const $ = (id) => document.getElementById(id);

function showToast(msg) {
  const t = $('toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => t.classList.remove('show'), 2500);
}
function escapeHtml(s) { return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function fmtTime(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleString('ru-RU', { day:'2-digit', month:'2-digit', hour:'2-digit', minute:'2-digit' });
}

async function api(method, path, body) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (TOKEN) opts.headers['Authorization'] = `Bearer ${TOKEN}`;
  if (body !== undefined) opts.body = JSON.stringify(body);
  const res = await fetch(path, opts);
  if (res.status === 401) { logout(); throw new Error('Не авторизован'); }
  let data = {}; try { data = await res.json(); } catch {}
  if (!res.ok) throw new Error(data.detail || `HTTP ${res.status}`);
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
    if (data.role !== 'manager' && data.role !== 'owner') {
      $('loginError').textContent = 'Этот логин не для панели менеджера'; return;
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
    if (data.role !== 'manager' && data.role !== 'owner') { logout(); return; }
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
  $('meSubtitle').textContent = `${ME.full_name} · ${ME.role === 'owner' ? 'Владелец (менеджер-вид)' : 'Менеджер'}`;
  loadMatchChats();
  loadLawyers();
  loadLawyerChats();
  connectWS();
}

// ── Tabs ──────────────────────────────────────
document.querySelectorAll('.app-tab').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.app-tab').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    document.querySelectorAll('.app-panel').forEach(p => p.classList.remove('active'));
    $('tab-' + btn.dataset.tab).classList.add('active');
  });
});

// ── Match chats ───────────────────────────────
async function loadMatchChats() {
  try { MATCH_CHATS = await api('GET', '/api/manager/match-chats'); renderMatchList(); }
  catch (e) { showToast(e.message); }
}

function renderMatchList() {
  const wrap = $('matchList');
  if (!MATCH_CHATS.length) {
    wrap.innerHTML = `<div style="padding:24px;color:var(--text-secondary);text-align:center;font-size:13px">Нет чатов подбора.</div>`;
    return;
  }
  wrap.innerHTML = '';
  for (const chat of MATCH_CHATS) {
    const item = document.createElement('div');
    item.className = 'chat-list-item';
    if (chat.id === CURRENT_MATCH_ID) item.classList.add('active');
    const u = chat.user || {};
    const name = [u.first_name, u.last_name].filter(Boolean).join(' ') || u.username || `User #${chat.user_id}`;
    const preview = chat.last_message?.content || 'Нет сообщений';
    item.innerHTML = `
      <div class="chat-item-name">${escapeHtml(name)}</div>
      <div class="chat-item-preview">${escapeHtml(preview)}</div>
      <div class="chat-item-meta">${chat.message_count} сообщ. · ${fmtTime(chat.updated_at)}</div>`;
    item.addEventListener('click', () => openMatchChat(chat));
    wrap.appendChild(item);
  }
}

async function openMatchChat(chat) {
  CURRENT_MATCH_ID = chat.id;
  renderMatchList();
  await openChatPane(chat, 'matchDetail', '/api/manager');
}

// ── Lawyer chats (manager view) ───────────────
async function loadLawyerChats() {
  try { LAWYER_CHATS = await api('GET', '/api/manager/lawyer-chats'); renderLawyerChatList(); }
  catch (e) { showToast(e.message); }
}

function renderLawyerChatList() {
  const wrap = $('lawyerChatList');
  if (!LAWYER_CHATS.length) {
    wrap.innerHTML = `<div style="padding:24px;color:var(--text-secondary);text-align:center;font-size:13px">Нет чатов с юристами.</div>`;
    return;
  }
  wrap.innerHTML = '';
  for (const chat of LAWYER_CHATS) {
    const item = document.createElement('div');
    item.className = 'chat-list-item';
    if (chat.id === CURRENT_LAWYER_CHAT_ID) item.classList.add('active');
    const u = chat.user || {};
    const name = [u.first_name, u.last_name].filter(Boolean).join(' ') || u.username || `User #${chat.user_id}`;
    const assigned = chat.lawyer_staff_id ? `Назначен #${chat.lawyer_staff_id}` : '⚠ Не назначен';
    item.innerHTML = `
      <div class="chat-item-name">${escapeHtml(name)}</div>
      <div class="chat-item-preview">${escapeHtml(chat.last_message?.content || 'Нет сообщений')}</div>
      <div class="chat-item-meta">${assigned} · ${fmtTime(chat.updated_at)}</div>`;
    item.addEventListener('click', () => openLawyerChat(chat));
    wrap.appendChild(item);
  }
}

async function openLawyerChat(chat) {
  CURRENT_LAWYER_CHAT_ID = chat.id;
  renderLawyerChatList();
  await openChatPane(chat, 'lawyerChatDetail', '/api/manager', false);
}

// ── Shared chat pane open ─────────────────────
async function openChatPane(chat, paneId, apiBase, canAssign = true) {
  const u = chat.user || {};
  const name = [u.first_name, u.last_name].filter(Boolean).join(' ') || u.username || `User #${chat.user_id}`;
  const detail = $(paneId);
  const assignBtn = canAssign && chat.chat_type === 'match'
    ? `<button class="btn-primary" style="width:auto;padding:8px 14px;margin-left:auto" id="assignBtn-${chat.id}">Назначить юриста</button>`
    : '';
  detail.innerHTML = `
    <div class="chat-header-bar" style="display:flex;align-items:center">
      <div style="flex:1">
        <div class="chat-header-name">${escapeHtml(name)}</div>
        <div class="chat-header-meta">${u.username ? '@' + escapeHtml(u.username) : ''} · TG ${u.telegram_id || '—'}</div>
      </div>
      ${assignBtn}
    </div>
    <div class="chat-messages" id="cm-${chat.id}"></div>
    <div class="chat-reply-area">
      <textarea class="chat-reply-input" id="ri-${chat.id}" rows="1" placeholder="Сообщение пользователю..."></textarea>
      <button class="chat-reply-send" id="rb-${chat.id}">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
          <line x1="22" y1="2" x2="11" y2="13"/><polygon points="22,2 15,22 11,13 2,9"/>
        </svg>
      </button>
    </div>
  `;
  try {
    const msgs = await api('GET', `${apiBase}/chats/${chat.id}/messages`);
    const wrap = $(`cm-${chat.id}`);
    msgs.forEach(m => wrap.appendChild(messageEl(m)));
    wrap.scrollTop = wrap.scrollHeight;
  } catch (e) { showToast(e.message); }

  $(`ri-${chat.id}`).addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChatReply(chat.id, apiBase); }
  });
  $(`rb-${chat.id}`).addEventListener('click', () => sendChatReply(chat.id, apiBase));
  const ab = document.getElementById(`assignBtn-${chat.id}`);
  if (ab) ab.addEventListener('click', () => openAssignModal(chat.user_id, name));
}

async function sendChatReply(chatId, apiBase) {
  const input = $(`ri-${chatId}`);
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  try {
    const m = await api('POST', `${apiBase}/chats/${chatId}/messages`, { content: text });
    addMessageIfNew(chatId, m);
    loadMatchChats(); loadLawyerChats();
  } catch (e) { showToast(e.message); }
}

// Append a message to chat #chatId only if it isn't already there.
// Used by BOTH HTTP-reply and WS-broadcast paths — same payload comes
// through both, dedup by message id via data-mid attribute.
function addMessageIfNew(chatId, m) {
  if (m == null || m.id == null) return;
  const wrap = $(`cm-${chatId}`);
  if (!wrap) return;
  if (wrap.querySelector(`[data-mid="${m.id}"]`)) return;
  wrap.appendChild(messageEl(m));
  wrap.scrollTop = wrap.scrollHeight;
}

function messageEl(m) {
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

// Replace an edited message in-place inside its open chat pane.
function applyEdit(data) {
  const pane = $(`cm-${data.chat_id}`);
  if (!pane) return;
  const el = pane.querySelector(`[data-mid="${data.id}"]`);
  if (!el) return;
  el.replaceWith(messageEl(data));
}

// Mark a deleted message inside whichever open pane holds it.
function applyDelete(messageId) {
  const el = document.querySelector(`[data-mid="${messageId}"]`);
  if (!el) return;
  const b = el.querySelector('.msg-bubble');
  if (b) {
    b.textContent = 'Сообщение удалено';
    b.style.opacity = '0.55';
    b.style.fontStyle = 'italic';
  }
  el.querySelector('.msg-time')?.remove();
}

// ── Lawyers CRUD ──────────────────────────────
async function loadLawyers() {
  try { LAWYERS = await api('GET', '/api/manager/lawyers'); renderLawyers(); }
  catch (e) { showToast(e.message); }
}

function renderLawyers() {
  const wrap = $('lawyersList');
  if (!LAWYERS.length) {
    wrap.innerHTML = `<div style="padding:24px;color:var(--text-secondary);text-align:center;font-size:13px">Юристов нет. Добавьте первого.</div>`;
    return;
  }
  wrap.innerHTML = '';
  for (const l of LAWYERS) {
    const r = document.createElement('div');
    r.className = 'data-row';
    if (!l.is_active) r.style.opacity = '0.5';
    r.innerHTML = `
      <div class="grow">
        <div class="data-name">${escapeHtml(l.full_name)}</div>
        <div class="data-sub">@${escapeHtml(l.login)} · ${escapeHtml(l.specialization || 'не указана')} · TG ${l.telegram_id || '—'} · ${l.is_online ? '🟢 онлайн' : '⚫ оффлайн'}${!l.is_active ? ' · уволен' : ''}</div>
      </div>
      <div class="data-actions">
        <button class="btn-danger" data-id="${l.id}">${l.is_active ? 'Уволить' : 'Удалён'}</button>
      </div>
    `;
    r.querySelector('button.btn-danger').addEventListener('click', async (e) => {
      if (!l.is_active) return;
      if (!confirm(`Уволить юриста "${l.full_name}"?`)) return;
      try { await api('DELETE', `/api/manager/lawyers/${l.id}`); loadLawyers(); showToast('Юрист удалён'); }
      catch (err) { showToast(err.message); }
    });
    wrap.appendChild(r);
  }
}

$('addLawyerBtn').addEventListener('click', () => {
  $('lwName').value = ''; $('lwLogin').value = ''; $('lwPassword').value = '';
  $('lwSpec').value = ''; $('lwTgId').value = ''; $('lwError').textContent = '';
  $('lawyerModal').classList.remove('hidden');
});
$('lwCancel').addEventListener('click', () => $('lawyerModal').classList.add('hidden'));
$('lwSave').addEventListener('click', async () => {
  const body = {
    full_name: $('lwName').value.trim(),
    login: $('lwLogin').value.trim(),
    password: $('lwPassword').value,
    specialization: $('lwSpec').value.trim() || null,
    telegram_id: $('lwTgId').value ? parseInt($('lwTgId').value) : null,
  };
  if (!body.full_name || !body.login || !body.password) {
    $('lwError').textContent = 'Заполните ФИО, логин и пароль'; return;
  }
  try {
    await api('POST', '/api/manager/lawyers', body);
    $('lawyerModal').classList.add('hidden');
    loadLawyers();
    showToast('Юрист добавлен');
  } catch (e) { $('lwError').textContent = e.message; }
});

// ── Assign lawyer modal ───────────────────────
function openAssignModal(userId, userName) {
  ASSIGN_USER_ID = userId;
  $('assignUserInfo').textContent = `Пользователь: ${userName}`;
  const list = $('assignLawyerList');
  list.innerHTML = '';
  const active = LAWYERS.filter(l => l.is_active);
  if (!active.length) {
    list.innerHTML = `<div style="padding:14px;color:var(--text-secondary);font-size:13px">Нет активных юристов — сначала добавьте.</div>`;
  } else {
    for (const l of active) {
      const r = document.createElement('div');
      r.className = 'data-row';
      r.innerHTML = `
        <div class="grow">
          <div class="data-name">${escapeHtml(l.full_name)}</div>
          <div class="data-sub">${escapeHtml(l.specialization || 'без специализации')} · ${l.is_online ? '🟢 онлайн' : '⚫ оффлайн'}</div>
        </div>
        <button class="btn-primary" style="width:auto;padding:8px 14px" data-id="${l.id}">Выбрать</button>
      `;
      r.querySelector('button').addEventListener('click', () => assignLawyer(l.id, l.full_name));
      list.appendChild(r);
    }
  }
  $('assignModal').classList.remove('hidden');
}
$('assignCancel').addEventListener('click', () => $('assignModal').classList.add('hidden'));

async function assignLawyer(lawyerId, lawyerName) {
  if (!ASSIGN_USER_ID) return;
  try {
    await api('POST', '/api/manager/assign-lawyer', { user_id: ASSIGN_USER_ID, lawyer_id: lawyerId });
    $('assignModal').classList.add('hidden');
    showToast(`Юрист "${lawyerName}" назначен`);
    loadLawyerChats();
    loadMatchChats();
  } catch (e) { showToast(e.message); }
}

// ── WebSocket ─────────────────────────────────
function connectWS() {
  if (!TOKEN) return;
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  WS = new WebSocket(`${proto}://${location.host}/ws/staff?token=${encodeURIComponent(TOKEN)}`);
  WS.onmessage = (e) => {
    let data; try { data = JSON.parse(e.data); } catch { return; }
    if (data.type === 'message' || data.type === 'new_message') {
      const cid = data.chat_id;
      if (cid === CURRENT_MATCH_ID) addMessageIfNew(cid, data);
      if (cid === CURRENT_LAWYER_CHAT_ID) addMessageIfNew(cid, data);
      loadMatchChats(); loadLawyerChats();
    } else if (data.type === 'edit') {
      applyEdit(data);
      loadMatchChats(); loadLawyerChats();
    } else if (data.type === 'delete') {
      applyDelete(data.message_id);
      loadMatchChats(); loadLawyerChats();
    }
  };
  WS.onclose = () => setTimeout(connectWS, 3000);
  setInterval(() => { try { WS?.send(JSON.stringify({type:'ping'})); } catch {} }, 25000);
}

checkAuth();
