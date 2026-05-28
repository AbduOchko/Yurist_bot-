/* ───────────────────────────────────────────
   Юрист Бот – Admin Panel
─────────────────────────────────────────── */

let ADMIN_PASSWORD = null;
let adminWs = null;
let currentLawyerChatId = null;
let currentMatchChatId = null;
let currentAiChatId = null;
let refreshInterval = null;

// DOM refs
const $loginPage = document.getElementById('loginPage');
const $adminLayout = document.getElementById('adminLayout');
const $passwordInput = document.getElementById('passwordInput');
const $loginBtn = document.getElementById('loginBtn');
const $loginError = document.getElementById('loginError');
const $adminToast = document.getElementById('adminToast');
const $logoutBtn = document.getElementById('logoutBtn');

// ── Login ─────────────────────────────────────
$loginBtn.addEventListener('click', login);
$passwordInput.addEventListener('keydown', e => { if (e.key === 'Enter') login(); });

async function login() {
  const pwd = $passwordInput.value.trim();
  if (!pwd) return;
  try {
    const res = await fetch('/api/admin/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: pwd }),
    });
    if (!res.ok) {
      $loginError.classList.add('show');
      return;
    }
    ADMIN_PASSWORD = pwd;
    $loginError.classList.remove('show');
    $loginPage.style.display = 'none';
    $adminLayout.classList.add('show');
    onAdminReady();
  } catch {
    $loginError.classList.add('show');
  }
}

$logoutBtn.addEventListener('click', () => {
  ADMIN_PASSWORD = null;
  $adminLayout.classList.remove('show');
  $loginPage.style.display = '';
  $passwordInput.value = '';
  if (adminWs) { adminWs.close(); adminWs = null; }
  clearInterval(refreshInterval);
});

// ── Admin API helper ──────────────────────────
async function adminApi(path) {
  const res = await fetch(path, {
    headers: { 'X-Admin-Password': ADMIN_PASSWORD },
  });
  if (!res.ok) throw new Error('API error');
  return res.json();
}

// ── On Admin Ready ────────────────────────────
function onAdminReady() {
  loadStats();
  loadUsers();
  loadChatList('lawyer');
  loadChatList('match');
  loadChatList('ai');
  connectAdminWS();
  refreshInterval = setInterval(() => {
    loadStats();
    loadChatList('lawyer');
    loadChatList('match');
    loadChatList('ai');
  }, 15000);
}

// ── Navigation (sidebar + mobile bottom nav) ──
function switchPanel(panel) {
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  document.querySelectorAll('.mobile-nav-btn').forEach(n => n.classList.remove('active'));
  document.querySelectorAll(`[data-panel="${panel}"]`).forEach(n => n.classList.add('active'));
  document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
  document.getElementById(`panel-${panel}`)?.classList.add('active');
}

document.querySelectorAll('.nav-item, .mobile-nav-btn').forEach(item => {
  item.addEventListener('click', () => switchPanel(item.dataset.panel));
});

// Apply mobile-mode class when inside Telegram WebApp or on narrow screen
function updateLayout() {
  const isMobile = !!(window.Telegram?.WebApp?.initData) || window.innerWidth < 900;
  document.body.classList.toggle('mobile-mode', isMobile);
}
updateLayout();
window.addEventListener('resize', updateLayout);

// ── Stats ─────────────────────────────────────
async function loadStats() {
  try {
    const s = await adminApi('/api/admin/stats');
    document.getElementById('statUsers').textContent = s.total_users;
    document.getElementById('statAiChats').textContent = s.ai_chats;
    document.getElementById('statLawyerChats').textContent = s.lawyer_chats;
    document.getElementById('statMatchChats').textContent = s.match_chats;
    document.getElementById('statMessages').textContent = s.total_messages;
    document.getElementById('usersBadge').textContent = s.total_users;
    document.getElementById('lawyerBadge').textContent = s.lawyer_chats;
    document.getElementById('matchBadge').textContent = s.match_chats;
    document.getElementById('aiBadge').textContent = s.ai_chats;
  } catch {}
}

// ── Users ─────────────────────────────────────
async function loadUsers() {
  try {
    const users = await adminApi('/api/admin/users');
    renderUsers(users);
    document.getElementById('usersSearch').addEventListener('input', (e) => {
      const q = e.target.value.toLowerCase();
      const filtered = users.filter(u =>
        (u.first_name || '').toLowerCase().includes(q) ||
        (u.username || '').toLowerCase().includes(q) ||
        String(u.telegram_id).includes(q)
      );
      renderUsers(filtered);
    });
  } catch {}
}

function renderUsers(users) {
  const tbody = document.getElementById('usersTable');
  tbody.innerHTML = users.map(u => `
    <tr>
      <td>${u.id}</td>
      <td>${escHtml((u.first_name || '') + ' ' + (u.last_name || ''))}</td>
      <td class="td-secondary">${u.username ? '@' + u.username : '—'}</td>
      <td class="td-secondary">${u.telegram_id}</td>
      <td class="td-secondary">${new Date(u.created_at).toLocaleDateString('ru-RU')}</td>
    </tr>`).join('');
}

// ── Chat Lists ────────────────────────────────
async function loadChatList(type) {
  try {
    const chats = await adminApi(`/api/admin/chats?chat_type=${type}`);
    const listEl = document.getElementById(`${type}ChatList`);
    listEl.innerHTML = '';
    chats.forEach(chat => {
      const item = document.createElement('div');
      item.className = 'chat-list-item';
      const name = `${chat.user.first_name || ''} ${chat.user.last_name || ''}`.trim() || `User ${chat.user_id}`;
      const preview = chat.last_message?.content || 'Нет сообщений';
      const time = chat.last_message ? new Date(chat.last_message.created_at).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }) : '';
      item.innerHTML = `
        <div class="chat-item-header">
          <span class="chat-item-name">${escHtml(name)}</span>
          <span class="chat-item-time">${time}</span>
        </div>
        <div class="chat-item-preview">${escHtml(truncate(preview, 50))}</div>
        <div class="chat-item-type">${chat.message_count} сообщений</div>`;
      item.addEventListener('click', () => openChat(chat, type));
      listEl.appendChild(item);
    });
  } catch {}
}

// ── Open Chat (admin view) ────────────────────
async function openChat(chat, type) {
  const detailEl = document.getElementById(`${type}ChatDetail`);
  if (type === 'lawyer') currentLawyerChatId = chat.id;
  if (type === 'match') currentMatchChatId = chat.id;
  if (type === 'ai') currentAiChatId = chat.id;

  // Mark active in list
  document.querySelectorAll(`#${type}ChatList .chat-list-item`).forEach(el => el.classList.remove('active'));
  event.currentTarget?.classList.add('active');

  const name = `${chat.user.first_name || ''} ${chat.user.last_name || ''}`.trim() || `User ${chat.user_id}`;
  const typeLabel = { ai: 'ИИ-Советник', lawyer: 'Личный Юрист', match: 'Подбор Юриста' }[type];

  // Load messages
  const messages = await adminApi(`/api/admin/chats/${chat.id}/messages`);

  const isReadOnly = type === 'ai';
  const replyArea = isReadOnly ? '' : `
    <div class="admin-reply-area">
      <textarea class="admin-input" id="${type}ReplyInput" placeholder="Ответить..." rows="1"></textarea>
      <button class="admin-send-btn" id="${type}SendBtn">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
          <line x1="22" y1="2" x2="11" y2="13"/><polygon points="22,2 15,22 11,13 2,9"/>
        </svg>
      </button>
    </div>`;

  detailEl.innerHTML = `
    <div class="chat-detail-header">
      <div class="chat-detail-name">${escHtml(name)}</div>
      <div class="chat-detail-meta">${typeLabel} · ${chat.message_count} сообщений</div>
    </div>
    <div class="chat-detail-messages" id="${type}Messages"></div>
    ${replyArea}`;

  renderAdminMessages(messages, `${type}Messages`);

  if (!isReadOnly) {
    const input = document.getElementById(`${type}ReplyInput`);
    const sendBtn = document.getElementById(`${type}SendBtn`);
    input.addEventListener('input', () => {
      input.style.height = 'auto';
      input.style.height = Math.min(input.scrollHeight, 100) + 'px';
    });
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendAdminMessage(chat.id, type); }
    });
    sendBtn.addEventListener('click', () => sendAdminMessage(chat.id, type));
  }
}

function renderAdminMessages(messages, containerId) {
  const container = document.getElementById(containerId);
  if (!container) return;
  container.innerHTML = '';
  messages.forEach(msg => {
    const isUser = msg.sender_type === 'user';
    const wrap = document.createElement('div');
    wrap.className = `admin-message-wrap ${isUser ? 'user' : 'other'}`;

    if (!isUser) {
      const sender = document.createElement('div');
      sender.className = 'admin-sender';
      sender.textContent = msg.sender_name || msg.sender_type;
      wrap.appendChild(sender);
    }

    const bubble = document.createElement('div');
    bubble.className = 'admin-bubble';
    if (msg.file_url) {
      bubble.innerHTML = `<a href="${msg.file_url}" target="_blank" style="color:inherit">${escHtml(msg.file_name || 'Файл')}</a>`;
    } else {
      bubble.textContent = msg.content || '[пусто]';
    }
    wrap.appendChild(bubble);

    const time = document.createElement('div');
    time.className = 'admin-time';
    time.textContent = new Date(msg.created_at).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
    wrap.appendChild(time);

    container.appendChild(wrap);
  });
  container.scrollTop = container.scrollHeight;
}

async function sendAdminMessage(chatId, type) {
  const input = document.getElementById(`${type}ReplyInput`);
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  input.style.height = 'auto';

  if (adminWs?.readyState === WebSocket.OPEN) {
    adminWs.send(JSON.stringify({
      type: 'admin_message',
      chat_id: chatId,
      content: text,
      sender_name: 'Юрист',
    }));
  }
}

// ── Admin WebSocket ───────────────────────────
function connectAdminWS() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  adminWs = new WebSocket(`${proto}://${location.host}/ws/admin/1`);

  adminWs.onopen = () => console.log('Admin WS connected');

  adminWs.onmessage = (e) => {
    const data = JSON.parse(e.data);
    handleAdminWSMessage(data);
  };

  adminWs.onclose = () => {
    setTimeout(connectAdminWS, 3000);
  };

  setInterval(() => {
    if (adminWs?.readyState === WebSocket.OPEN) {
      adminWs.send(JSON.stringify({ type: 'ping' }));
    }
  }, 25000);
}

function handleAdminWSMessage(data) {
  if (data.type === 'new_message' || data.type === 'message') {
    const chatType = data.chat_type || '';
    const suffix = data.from_admin ? '' : '';

    // Append to open chat if visible
    if (chatType === 'lawyer' && data.chat_id === currentLawyerChatId) {
      appendAdminMessage(data, 'lawyerMessages');
    } else if (chatType === 'match' && data.chat_id === currentMatchChatId) {
      appendAdminMessage(data, 'matchMessages');
    }

    // Show notification
    if (!data.from_admin && (chatType === 'lawyer' || chatType === 'match')) {
      showAdminToast('Новое сообщение от пользователя');
      loadChatList(chatType);
    }
  }
}

function appendAdminMessage(msg, containerId) {
  const container = document.getElementById(containerId);
  if (!container) return;
  const isUser = msg.sender_type === 'user';
  const wrap = document.createElement('div');
  wrap.className = `admin-message-wrap ${isUser ? 'user' : 'other'}`;

  if (!isUser) {
    const s = document.createElement('div');
    s.className = 'admin-sender';
    s.textContent = msg.sender_name || msg.sender_type;
    wrap.appendChild(s);
  }

  const bubble = document.createElement('div');
  bubble.className = 'admin-bubble';
  bubble.textContent = msg.content || '';
  wrap.appendChild(bubble);

  const time = document.createElement('div');
  time.className = 'admin-time';
  time.textContent = new Date(msg.created_at || Date.now()).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  wrap.appendChild(time);

  container.appendChild(wrap);
  container.scrollTop = container.scrollHeight;
}

// ── Helpers ───────────────────────────────────
function escHtml(str) {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function truncate(str, n) {
  return str.length > n ? str.slice(0, n) + '…' : str;
}

let toastTimer;
function showAdminToast(msg) {
  $adminToast.textContent = msg;
  $adminToast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $adminToast.classList.remove('show'), 3000);
}
