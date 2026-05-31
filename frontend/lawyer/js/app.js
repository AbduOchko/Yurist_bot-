/* Lawyer panel — list + chat with mobile-first navigation. */

const TOKEN_KEY = 'yurist_lawyer_token';
let TOKEN = localStorage.getItem(TOKEN_KEY) || '';
let ME = null;
let CHATS = [];
let CURRENT_CHAT_ID = null;
let WS = null;

const $ = (id) => document.getElementById(id);

// ── Utils ─────────────────────────────────────
function showToast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => t.classList.remove('show'), 2500);
}
function escapeHtml(s) { return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function initials(name) {
  const parts = String(name || '').trim().split(/\s+/);
  return ((parts[0]?.[0] || '') + (parts[1]?.[0] || '')).toUpperCase() || '?';
}
function fmtTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) return d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  const diffDays = Math.floor((now - d) / 86400000);
  if (diffDays < 7) return d.toLocaleDateString('ru-RU', { weekday: 'short' });
  return d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' });
}
function fmtFull(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
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
    if (data.role !== 'lawyer' && data.role !== 'owner') {
      $('loginError').textContent = 'Этот логин не для панели юриста';
      return;
    }
    TOKEN = data.token;
    localStorage.setItem(TOKEN_KEY, TOKEN);
    ME = data;
    enterApp();
  } catch (e) {
    $('loginError').textContent = e.message;
  }
}

async function checkAuth() {
  if (!TOKEN) { showLogin(); return; }
  try {
    const data = await api('POST', '/api/staff/verify', {});
    if (data.role !== 'lawyer' && data.role !== 'owner') { logout(); return; }
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
$('loginInput').addEventListener('keydown', e => { if (e.key === 'Enter') $('passwordInput').focus(); });
$('logoutBtn').addEventListener('click', async () => {
  try { await api('POST', '/api/staff/logout', {}); } catch {}
  logout();
});
$('onlineToggle').addEventListener('change', async (e) => {
  try { await api('POST', '/api/lawyer/online', { is_online: e.target.checked }); }
  catch (err) { showToast(err.message); e.target.checked = !e.target.checked; }
});

// ── App entry ─────────────────────────────────
function enterApp() {
  $('loginPage').classList.add('hidden');
  $('appShell').classList.remove('hidden');
  $('meName').textContent = ME.full_name || 'Юрист';
  $('meRole').textContent = ME.role === 'owner' ? 'Владелец · вид юриста' : (ME.specialization || 'Юрист');
  $('meAvatar').textContent = initials(ME.full_name);
  $('onlineToggle').checked = !!ME.is_online;
  loadChats();
  connectWS();
}

// ── View navigation (mobile) ─────────────────
function showView(name) {
  if (name === 'chat') {
    $('listView').classList.remove('active');
    $('chatView').classList.add('active');
  } else {
    $('chatView').classList.remove('active');
    $('listView').classList.add('active');
    CURRENT_CHAT_ID = null;
    // re-highlight nothing
    document.querySelectorAll('.lawyer-chat-item.active').forEach(el => el.classList.remove('active'));
  }
}
$('backBtn').addEventListener('click', () => showView('list'));

// ── Load & render chat list ──────────────────
async function loadChats() {
  try {
    CHATS = await api('GET', '/api/lawyer/chats');
    renderChats();
  } catch (e) { showToast(e.message); }
}

function renderChats() {
  const wrap = $('chatList');
  const meta = $('listMeta');
  if (!CHATS.length) {
    meta.textContent = 'Чатов нет';
    wrap.innerHTML = `
      <div class="lawyer-list-empty">
        <div class="lawyer-list-empty-icon">📭</div>
        <div class="lawyer-list-empty-title">Пока тихо</div>
        <div class="lawyer-list-empty-text">Когда пользователь напишет в «Личный юрист», запрос появится здесь.</div>
      </div>`;
    return;
  }
  const free = CHATS.filter(c => c.is_free).length;
  const mine = CHATS.length - free;
  meta.textContent = `${CHATS.length} чатов · 🆕 свободных: ${free} · ✔ ваших: ${mine}`;

  wrap.innerHTML = '';
  for (const chat of CHATS) {
    const u = chat.user || {};
    const name = [u.first_name, u.last_name].filter(Boolean).join(' ') || u.username || `Пользователь #${chat.user_id}`;
    const preview = chat.last_message?.content || '—';
    const time = fmtTime(chat.last_message?.created_at || chat.updated_at);
    const isFree = chat.is_free;
    const isMine = !isFree && chat.lawyer_staff_id === ME.id;

    const item = document.createElement('div');
    item.className = 'lawyer-chat-item' + (chat.id === CURRENT_CHAT_ID ? ' active' : '');
    item.dataset.id = chat.id;
    item.innerHTML = `
      <div class="lawyer-chat-item-avatar">${
        u.photo_url
          ? `<img src="${escapeHtml(u.photo_url)}" alt=""/>`
          : escapeHtml(initials(name))
      }</div>
      <div class="lawyer-chat-item-body">
        <div class="lawyer-chat-item-top">
          <div class="lawyer-chat-item-name">${escapeHtml(name)}</div>
          <div class="lawyer-chat-item-time">${escapeHtml(time)}</div>
        </div>
        <div class="lawyer-chat-item-preview">${escapeHtml(preview)}</div>
        <div class="lawyer-chat-item-badges">
          ${isFree ? '<span class="lawyer-badge free">🆕 Свободный</span>' : ''}
          ${isMine ? '<span class="lawyer-badge mine">✔ Ваш</span>' : ''}
          <span class="lawyer-badge count">${chat.message_count} сообщ.</span>
        </div>
      </div>`;
    item.addEventListener('click', () => openChat(chat));
    wrap.appendChild(item);
  }
}

// ── Open chat ─────────────────────────────────
async function openChat(chat) {
  CURRENT_CHAT_ID = chat.id;
  document.querySelectorAll('.lawyer-chat-item.active').forEach(el => el.classList.remove('active'));
  document.querySelector(`.lawyer-chat-item[data-id="${chat.id}"]`)?.classList.add('active');

  const u = chat.user || {};
  const name = [u.first_name, u.last_name].filter(Boolean).join(' ') || u.username || `Пользователь #${chat.user_id}`;
  const sub = [
    u.username ? '@' + u.username : null,
    `TG ${u.telegram_id || '—'}`,
  ].filter(Boolean).join(' · ');

  $('chatHeaderName').textContent = name;
  $('chatHeaderSub').textContent = sub;
  $('chatAvatar').innerHTML = u.photo_url
    ? `<img src="${escapeHtml(u.photo_url)}" alt="" style="width:100%;height:100%;object-fit:cover;border-radius:50%"/>`
    : escapeHtml(initials(name));

  // Show claim bar if free
  $('claimBar').classList.toggle('hidden', !chat.is_free);

  // Hide empty state, show messages + reply
  $('chatEmpty').style.display = 'none';
  $('chatMessages').classList.remove('hidden');
  $('replyArea').classList.remove('hidden');

  showView('chat');

  // Load messages
  try {
    const msgs = await api('GET', `/api/lawyer/chats/${chat.id}/messages`);
    renderMessages(msgs);
  } catch (e) { showToast(e.message); }

  // Focus input
  setTimeout(() => $('replyInput').focus(), 50);
}

function renderMessages(msgs) {
  const wrap = $('chatMessages');
  wrap.innerHTML = '';
  for (const m of msgs) wrap.appendChild(messageEl(m));
  wrap.scrollTop = wrap.scrollHeight;
}

// Append a message only if it isn't already on screen. Used by BOTH the HTTP
// reply path and the WS broadcast path — they always carry the same payload
// (sender's own WS connection echoes the broadcast back), so without this
// dedup the lawyer sees every own message twice.
function addMessageIfNew(m) {
  if (m == null || m.id == null) return;
  const wrap = $('chatMessages');
  if (!wrap) return;
  if (wrap.querySelector(`[data-mid="${m.id}"]`)) return;
  wrap.appendChild(messageEl(m));
  wrap.scrollTop = wrap.scrollHeight;
}

function messageEl(m) {
  const w = document.createElement('div');
  if (m.id != null) w.dataset.mid = m.id;
  const kind = m.sender_type === 'user' ? 'from-user'
             : m.sender_type === 'system' ? 'from-system'
             : 'from-staff';
  w.className = `msg-wrap ${kind}`;
  if (kind === 'from-staff' && m.sender_name) {
    const s = document.createElement('div');
    s.className = 'msg-sender';
    s.textContent = m.sender_name;
    w.appendChild(s);
  }
  const b = document.createElement('div');
  b.className = 'msg-bubble';
  if (m.file_url && m.message_type !== 'text' && m.message_type !== 'system') {
    b.innerHTML = `<a href="${escapeHtml(m.file_url)}" target="_blank" style="color:inherit;text-decoration:underline">${escapeHtml(m.file_name || 'Файл')}</a>`;
    if (m.content) {
      const c = document.createElement('div');
      c.style.marginTop = '4px';
      c.textContent = m.content;
      b.appendChild(c);
    }
  } else {
    b.textContent = m.content || '';
  }
  w.appendChild(b);
  if (m.created_at) {
    const t = document.createElement('div');
    t.className = 'msg-time';
    t.textContent = fmtFull(m.created_at);
    w.appendChild(t);
  }
  return w;
}

// ── Send reply ────────────────────────────────
async function sendReply() {
  const input = $('replyInput');
  const text = input.value.trim();
  if (!text || !CURRENT_CHAT_ID) return;
  input.value = '';
  input.style.height = 'auto';
  try {
    const payload = await api('POST', `/api/lawyer/chats/${CURRENT_CHAT_ID}/messages`, { content: text });
    addMessageIfNew(payload);
    loadChats();
  } catch (e) { showToast(e.message); input.value = text; }
}

$('replyBtn').addEventListener('click', sendReply);
$('replyInput').addEventListener('input', (e) => {
  e.target.style.height = 'auto';
  e.target.style.height = Math.min(e.target.scrollHeight, 120) + 'px';
});
$('replyInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendReply(); }
});

// ── WebSocket ─────────────────────────────────
function connectWS() {
  if (!TOKEN) return;
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  WS = new WebSocket(`${proto}://${location.host}/ws/staff?token=${encodeURIComponent(TOKEN)}`);
  WS.onmessage = (e) => {
    let data; try { data = JSON.parse(e.data); } catch { return; }
    if (data.type === 'message' || data.type === 'new_message') {
      if (data.chat_id === CURRENT_CHAT_ID) addMessageIfNew(data);
      loadChats();
    } else if (data.type === 'chat_assigned') {
      showToast('Вам назначен новый чат');
      loadChats();
    } else if (data.type === 'chat_claimed') {
      // Another lawyer took a free chat — drop from our list if it's not ours
      if (data.claimed_by !== ME.id) {
        if (CURRENT_CHAT_ID === data.chat_id) {
          showToast('Этот чат уже взял другой юрист');
          showView('list');
        }
        loadChats();
      }
    }
  };
  WS.onclose = () => setTimeout(connectWS, 3000);
  setInterval(() => { try { WS?.send(JSON.stringify({type:'ping'})); } catch {} }, 25000);
}

// ── Start ─────────────────────────────────────
checkAuth();
