/* Lawyer panel — login → list of assigned chats → reply */

const TOKEN_KEY = 'yurist_lawyer_token';
let TOKEN = localStorage.getItem(TOKEN_KEY) || '';
let ME = null;
let CHATS = [];
let CURRENT_CHAT_ID = null;
let WS = null;

const $ = (id) => document.getElementById(id);

// ── Utilities ─────────────────────────────────
function showToast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => t.classList.remove('show'), 2500);
}

function escapeHtml(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function fmtTime(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

async function api(method, path, body) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (TOKEN) opts.headers['Authorization'] = `Bearer ${TOKEN}`;
  if (body !== undefined) opts.body = JSON.stringify(body);
  const res = await fetch(path, opts);
  if (res.status === 401) { logout(); throw new Error('Не авторизован'); }
  let data = {};
  try { data = await res.json(); } catch {}
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

// ── App entry ─────────────────────────────────
function enterApp() {
  $('loginPage').classList.add('hidden');
  $('appShell').classList.remove('hidden');
  $('meSubtitle').textContent = `${ME.full_name} · ${ME.role === 'owner' ? 'Владелец (юрист-вид)' : 'Юрист'}`;
  $('onlineToggle').checked = !!ME.is_online;
  loadChats();
  connectWS();
}

$('loginBtn').addEventListener('click', tryLogin);
$('passwordInput').addEventListener('keydown', e => { if (e.key === 'Enter') tryLogin(); });
$('logoutBtn').addEventListener('click', async () => {
  try { await api('POST', '/api/staff/logout', {}); } catch {}
  logout();
});
$('onlineToggle').addEventListener('change', async (e) => {
  try { await api('POST', '/api/lawyer/online', { is_online: e.target.checked }); }
  catch (err) { showToast(err.message); }
});

// ── Chat list ─────────────────────────────────
async function loadChats() {
  try {
    CHATS = await api('GET', '/api/lawyer/chats');
    renderChats();
  } catch (e) { showToast(e.message); }
}

function renderChats() {
  const wrap = $('chatList');
  if (!CHATS.length) {
    wrap.innerHTML = `<div style="padding:24px;color:var(--text-secondary);text-align:center;font-size:13px">Пока нет назначенных чатов.</div>`;
    return;
  }
  wrap.innerHTML = '';
  for (const chat of CHATS) {
    const item = document.createElement('div');
    item.className = 'chat-list-item';
    if (chat.id === CURRENT_CHAT_ID) item.classList.add('active');
    const u = chat.user || {};
    const name = [u.first_name, u.last_name].filter(Boolean).join(' ') || u.username || `User #${chat.user_id}`;
    const preview = chat.last_message?.content || 'Нет сообщений';
    item.innerHTML = `
      <div class="chat-item-name">${escapeHtml(name)}</div>
      <div class="chat-item-preview">${escapeHtml(preview)}</div>
      <div class="chat-item-meta">${chat.message_count} сообщ. · ${fmtTime(chat.updated_at)}</div>
    `;
    item.addEventListener('click', () => openChat(chat));
    wrap.appendChild(item);
  }
}

// ── Chat detail ───────────────────────────────
async function openChat(chat) {
  CURRENT_CHAT_ID = chat.id;
  renderChats();
  const u = chat.user || {};
  const name = [u.first_name, u.last_name].filter(Boolean).join(' ') || u.username || `User #${chat.user_id}`;

  const detail = $('chatDetail');
  detail.innerHTML = `
    <div class="chat-header-bar">
      <div class="chat-header-name">${escapeHtml(name)}</div>
      <div class="chat-header-meta">${u.username ? '@' + escapeHtml(u.username) : ''} · TG ${u.telegram_id || '—'}</div>
    </div>
    <div class="chat-messages" id="chatMessages"></div>
    <div class="chat-reply-area">
      <textarea class="chat-reply-input" id="replyInput" rows="1" placeholder="Сообщение пользователю..."></textarea>
      <button class="chat-reply-send" id="replyBtn" title="Отправить">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
          <line x1="22" y1="2" x2="11" y2="13"/><polygon points="22,2 15,22 11,13 2,9"/>
        </svg>
      </button>
    </div>
  `;

  try {
    const msgs = await api('GET', `/api/lawyer/chats/${chat.id}/messages`);
    renderMessages(msgs);
  } catch (e) { showToast(e.message); }

  $('replyInput').addEventListener('input', (e) => {
    e.target.style.height = 'auto';
    e.target.style.height = Math.min(e.target.scrollHeight, 100) + 'px';
  });
  $('replyInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendReply(); }
  });
  $('replyBtn').addEventListener('click', sendReply);
}

function renderMessages(msgs) {
  const wrap = $('chatMessages');
  if (!wrap) return;
  wrap.innerHTML = '';
  for (const m of msgs) {
    wrap.appendChild(messageEl(m));
  }
  wrap.scrollTop = wrap.scrollHeight;
}

function messageEl(m) {
  const w = document.createElement('div');
  const kind = m.sender_type === 'user' ? 'from-user' :
               m.sender_type === 'system' ? 'from-system' : 'from-staff';
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
    b.innerHTML = `<a href="${m.file_url}" target="_blank" style="color:inherit;text-decoration:underline">${escapeHtml(m.file_name || 'Файл')}</a>`;
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
    t.textContent = fmtTime(m.created_at);
    w.appendChild(t);
  }
  return w;
}

async function sendReply() {
  const input = $('replyInput');
  const text = input.value.trim();
  if (!text || !CURRENT_CHAT_ID) return;
  input.value = '';
  input.style.height = 'auto';
  try {
    const payload = await api('POST', `/api/lawyer/chats/${CURRENT_CHAT_ID}/messages`, { content: text });
    $('chatMessages').appendChild(messageEl(payload));
    const m = $('chatMessages');
    m.scrollTop = m.scrollHeight;
    // Refresh sidebar
    loadChats();
  } catch (e) { showToast(e.message); }
}

// ── WebSocket for realtime updates ────────────
function connectWS() {
  if (!TOKEN) return;
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  WS = new WebSocket(`${proto}://${location.host}/ws/staff?token=${encodeURIComponent(TOKEN)}`);
  WS.onmessage = (e) => {
    let data; try { data = JSON.parse(e.data); } catch { return; }
    if (data.type === 'message' || data.type === 'new_message') {
      if (data.chat_id === CURRENT_CHAT_ID) {
        $('chatMessages')?.appendChild(messageEl(data));
        const m = $('chatMessages');
        if (m) m.scrollTop = m.scrollHeight;
      }
      loadChats();
    } else if (data.type === 'chat_assigned') {
      loadChats();
      showToast('Вам назначен новый чат');
    }
  };
  WS.onclose = () => setTimeout(connectWS, 3000);
  setInterval(() => { try { WS?.send(JSON.stringify({type:'ping'})); } catch {} }, 25000);
}

// ── Start ─────────────────────────────────────
checkAuth();
