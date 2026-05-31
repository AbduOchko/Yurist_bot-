/* ─────────────────────────────────────────────────────────────
   Lawyer panel — mobile-first, with polish, animations, haptics
   ───────────────────────────────────────────────────────────── */

const TOKEN_KEY = 'yurist_lawyer_token';
let TOKEN = localStorage.getItem(TOKEN_KEY) || '';
let ME = null;
let CHATS = [];
let CURRENT_CHAT_ID = null;
let WS = null;

// NB: `tg` is already declared as a global `const` in the <head> inline script
// of index.html. In classic (non-module) scripts, top-level `const`/`let`
// declarations share a single script scope across all <script> tags, so
// re-declaring it here would throw a SyntaxError at parse time and silently
// kill the entire file (no event listeners attached). We just reuse the
// global.
const $ = (id) => document.getElementById(id);

// ── Utils ─────────────────────────────────────
function escapeHtml(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function initials(name) {
  const parts = String(name || '').trim().split(/\s+/);
  return ((parts[0]?.[0] || '') + (parts[1]?.[0] || '')).toUpperCase() || '?';
}

/** Deterministic pastel color id 0..7 from a name. Same name → same color. */
function avatarColorFromName(name) {
  const s = String(name || '');
  let hash = 0;
  for (let i = 0; i < s.length; i++) hash = ((hash << 5) - hash + s.charCodeAt(i)) | 0;
  return Math.abs(hash) % 8;
}

/** Smart relative time: "только что" / "5 мин назад" / "сегодня в 14:23" / "вчера в 14:23" / "пн в 14:23" / "31 мая" */
function smartTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const now = new Date();
  const sec = Math.floor((now - d) / 1000);
  if (sec < 60) return 'только что';
  if (sec < 3600) {
    const min = Math.floor(sec / 60);
    return `${min} мин назад`;
  }
  const same = d.toDateString() === now.toDateString();
  if (same) return d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });

  const yest = new Date(now);
  yest.setDate(yest.getDate() - 1);
  if (d.toDateString() === yest.toDateString())
    return 'вчера в ' + d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });

  const dayDiff = Math.floor((now.setHours(0,0,0,0) - new Date(d).setHours(0,0,0,0)) / 86400000);
  if (dayDiff < 7)
    return d.toLocaleDateString('ru-RU', { weekday: 'short' }) +
           ' в ' + d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });

  if (d.getFullYear() === new Date().getFullYear())
    return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
  return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: '2-digit' });
}

/** Full time inside a message bubble (always show hours+minutes for in-context). */
function fmtMsgTime(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
}

/** Section header above message groups: "Сегодня" / "Вчера" / "Понедельник" / "31 мая" */
function formatDateSeparator(iso) {
  const d = new Date(iso);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return 'Сегодня';
  const yest = new Date(now);
  yest.setDate(yest.getDate() - 1);
  if (d.toDateString() === yest.toDateString()) return 'Вчера';
  const dayDiff = Math.floor((now.setHours(0,0,0,0) - new Date(d).setHours(0,0,0,0)) / 86400000);
  if (dayDiff < 7) return d.toLocaleDateString('ru-RU', { weekday: 'long' });
  if (d.getFullYear() === new Date().getFullYear())
    return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
  return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });
}

/** Telegram WebApp haptic feedback — silent no-op outside Telegram. */
function haptic(type) {
  const hf = tg?.HapticFeedback;
  if (!hf) return;
  try {
    if (type === 'light' || type === 'medium' || type === 'heavy' || type === 'rigid' || type === 'soft') {
      hf.impactOccurred?.(type === 'soft' ? 'light' : type);
    } else if (type === 'success' || type === 'error' || type === 'warning') {
      hf.notificationOccurred?.(type);
    } else if (type === 'select') {
      hf.selectionChanged?.();
    }
  } catch {}
}

// ── HTTP ──────────────────────────────────────
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

// ── Toast ─────────────────────────────────────
function showToast(msg, duration = 2500) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.remove('exit');
  t.classList.add('show');
  clearTimeout(showToast._t);
  clearTimeout(showToast._exit);
  showToast._t = setTimeout(() => {
    t.classList.add('exit');
    showToast._exit = setTimeout(() => {
      t.classList.remove('show', 'exit');
    }, 220);
  }, duration);
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
      haptic('error');
      return;
    }
    TOKEN = data.token;
    localStorage.setItem(TOKEN_KEY, TOKEN);
    ME = data;
    haptic('success');
    enterApp();
  } catch (e) {
    $('loginError').textContent = e.message;
    haptic('error');
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
  setTgBackButton(false);
}
function logout() {
  localStorage.removeItem(TOKEN_KEY);
  TOKEN = ''; ME = null;
  showLogin();
}

$('loginBtn').addEventListener('click', tryLogin);
$('passwordInput').addEventListener('keydown', e => { if (e.key === 'Enter') tryLogin(); });
$('loginInput').addEventListener('keydown', e => { if (e.key === 'Enter') $('passwordInput').focus(); });

// ── Logout with confirmation modal ────────────
function openLogoutModal() {
  const text = CURRENT_CHAT_ID
    ? 'У вас открыт чат с клиентом. Если выйдете — придётся войти заново.'
    : 'Вы выйдете из панели и потеряете доступ к чатам до следующего входа.';
  $('logoutModalText').textContent = text;
  $('logoutModal').classList.remove('hidden', 'exit');
  haptic('light');
}

function closeLogoutModal() {
  const m = $('logoutModal');
  m.classList.add('exit');
  setTimeout(() => m.classList.add('hidden'), 220);
}

$('logoutBtn').addEventListener('click', openLogoutModal);
$('logoutCancel').addEventListener('click', () => { haptic('light'); closeLogoutModal(); });
$('logoutConfirm').addEventListener('click', async () => {
  haptic('warning');
  closeLogoutModal();
  try { await api('POST', '/api/staff/logout', {}); } catch {}
  logout();
});
// Click backdrop to close
$('logoutModal').addEventListener('click', (e) => {
  if (e.target === $('logoutModal')) closeLogoutModal();
});

// ── Online toggle ─────────────────────────────
$('onlineToggle').addEventListener('change', async (e) => {
  const isOn = e.target.checked;
  $('onlineLabel').textContent = isOn ? 'Онлайн' : 'Оффлайн';
  haptic(isOn ? 'medium' : 'light');
  if (isOn) {
    $('meAvatar').classList.remove('burst');
    void $('meAvatar').offsetWidth;
    $('meAvatar').classList.add('burst');
    setTimeout(() => $('meAvatar').classList.remove('burst'), 700);
  }
  try { await api('POST', '/api/lawyer/online', { is_online: isOn }); }
  catch (err) {
    showToast(err.message);
    haptic('error');
    e.target.checked = !isOn;
    $('onlineLabel').textContent = !isOn ? 'Онлайн' : 'Оффлайн';
  }
});

// ── App entry ─────────────────────────────────
function enterApp() {
  $('loginPage').classList.add('hidden');
  $('appShell').classList.remove('hidden');

  $('meName').textContent = ME.full_name || 'Юрист';
  const roleLabel = ME.role === 'owner' ? 'Владелец' : 'Юрист';
  $('meRole').textContent = `${roleLabel} · ${ME.specialization || 'Общее право'}`;
  $('meAvatar').textContent = initials(ME.full_name);

  $('onlineToggle').checked = !!ME.is_online;
  $('onlineLabel').textContent = ME.is_online ? 'Онлайн' : 'Оффлайн';

  loadChats();
  connectWS();
}

// ── Telegram BackButton integration ───────────
function setTgBackButton(show) {
  if (!tg?.BackButton) return;
  try {
    if (show) {
      tg.BackButton.show();
      tg.BackButton.onClick(handleTgBack);
    } else {
      tg.BackButton.offClick(handleTgBack);
      tg.BackButton.hide();
    }
  } catch {}
}
function handleTgBack() { haptic('light'); showView('list'); }

// ── View navigation ───────────────────────────
function showView(name) {
  if (name === 'chat') {
    $('listView').classList.remove('active');
    $('chatView').classList.add('active');
    if (window.innerWidth < 900) setTgBackButton(true);
  } else {
    $('chatView').classList.remove('active');
    $('listView').classList.add('active');
    CURRENT_CHAT_ID = null;
    document.querySelectorAll('.lawyer-chat-item.active').forEach(el => el.classList.remove('active'));
    setTgBackButton(false);
  }
}
$('backBtn').addEventListener('click', () => { haptic('light'); showView('list'); });

// ── Chat list ─────────────────────────────────
async function loadChats() {
  try {
    CHATS = await api('GET', '/api/lawyer/chats');
    renderChats();
    updateEmptyHint();
  } catch (e) { showToast(e.message); }
}

function renderChats() {
  const wrap = $('chatList');
  const meta = $('listMeta');

  if (!CHATS.length) {
    meta.textContent = 'Чатов пока нет';
    wrap.innerHTML = `
      <div class="lawyer-list-empty">
        <div class="lawyer-list-empty-icon">📭</div>
        <div class="lawyer-list-empty-title">Запросов нет</div>
        <div class="lawyer-list-empty-text">Когда пользователь напишет в «Личный юрист» — запрос появится здесь. Тем временем можно отдохнуть&nbsp;☕</div>
      </div>`;
    return;
  }

  const free = CHATS.filter(c => c.is_free).length;
  const mine = CHATS.length - free;
  meta.innerHTML =
    `<strong>${CHATS.length}</strong> ${pluralRu(CHATS.length, 'запрос', 'запроса', 'запросов')}` +
    (free > 0 ? ` · <span class="meta-accent">🔔 ${free} ${pluralRu(free, 'новый', 'новых', 'новых')}</span>` : '') +
    (mine > 0 ? ` · <span class="meta-success">✔ ${mine} ${pluralRu(mine, 'ваш', 'ваших', 'ваших')}</span>` : '');

  wrap.innerHTML = '';
  CHATS.forEach((chat, index) => {
    const u = chat.user || {};
    const name = [u.first_name, u.last_name].filter(Boolean).join(' ') ||
                 u.username || `Пользователь #${chat.user_id}`;
    const lastMsg = chat.last_message;
    const lastIsSelf = lastMsg?.sender_type === 'lawyer';
    const lastIsSystem = lastMsg?.sender_type === 'system';
    const senderLabel = lastIsSelf ? 'Вы' : lastIsSystem ? 'Система' : (u.first_name || 'Клиент');
    const previewBody = lastMsg?.content || '—';
    const time = smartTime(lastMsg?.created_at || chat.updated_at);
    const isFree = chat.is_free;
    const isMine = !isFree && chat.lawyer_staff_id === ME.id;

    const item = document.createElement('div');
    item.className = 'lawyer-chat-item' +
      (chat.id === CURRENT_CHAT_ID ? ' active' : '') +
      (isFree ? ' is-free' : '');
    item.dataset.id = chat.id;
    item.style.setProperty('--item-delay', `${Math.min(index * 40, 320)}ms`);

    const avatarColor = avatarColorFromName(name);
    item.innerHTML = `
      <div class="lawyer-chat-item-avatar" data-color="${avatarColor}">${
        u.photo_url
          ? `<img src="${escapeHtml(u.photo_url)}" alt=""/>`
          : escapeHtml(initials(name))
      }</div>
      <div class="lawyer-chat-item-body">
        <div class="lawyer-chat-item-top">
          <div class="lawyer-chat-item-name">${escapeHtml(name)}</div>
          <div class="lawyer-chat-item-time">${escapeHtml(time)}</div>
        </div>
        <div class="lawyer-chat-item-preview"><span class="preview-sender${lastIsSelf ? ' is-self' : ''}">${escapeHtml(senderLabel)}:</span> ${escapeHtml(previewBody)}</div>
        <div class="lawyer-chat-item-badges">
          ${isFree ? '<span class="lawyer-badge free">🔔 Новый запрос</span>' : ''}
          ${isMine ? '<span class="lawyer-badge mine">✔ Ваш клиент</span>' : ''}
          <span class="lawyer-badge count">${chat.message_count} ${pluralRu(chat.message_count, 'сообщ.', 'сообщ.', 'сообщ.')}</span>
        </div>
      </div>`;

    item.addEventListener('click', () => { haptic('light'); openChat(chat); });
    wrap.appendChild(item);
  });
}

function pluralRu(n, one, few, many) {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return few;
  return many;
}

function updateEmptyHint() {
  const hint = $('chatEmptyHint');
  if (!hint) return;
  const free = CHATS.filter(c => c.is_free).length;
  if (CURRENT_CHAT_ID) { hint.classList.remove('show'); return; }
  if (free > 0) {
    hint.textContent = `🔔 ${free} ${pluralRu(free, 'свободный запрос ждёт', 'свободных запроса ждут', 'свободных запросов ждут')} вашего ответа`;
    hint.classList.add('show');
  } else if (CHATS.length > 0) {
    hint.textContent = 'Все запросы взяты — отличная работа!';
    hint.classList.add('show');
  } else {
    hint.classList.remove('show');
  }
}

// ── Open chat ─────────────────────────────────
async function openChat(chat) {
  CURRENT_CHAT_ID = chat.id;
  document.querySelectorAll('.lawyer-chat-item.active').forEach(el => el.classList.remove('active'));
  document.querySelector(`.lawyer-chat-item[data-id="${chat.id}"]`)?.classList.add('active');

  const u = chat.user || {};
  const firstName = u.first_name || u.username || 'клиент';
  const name = [u.first_name, u.last_name].filter(Boolean).join(' ') || u.username || `Пользователь #${chat.user_id}`;
  const sub = [
    u.username ? '@' + u.username : null,
    `Telegram ID ${u.telegram_id || '—'}`,
  ].filter(Boolean).join(' · ');

  $('chatHeaderName').textContent = name;
  $('chatHeaderSub').textContent = sub;
  $('chatAvatar').setAttribute('data-color', avatarColorFromName(name));
  // Apply pastel via CSS variable on the chat avatar too
  $('chatAvatar').className = 'lawyer-chat-avatar';
  $('chatAvatar').style.background = '';
  $('chatAvatar').innerHTML = u.photo_url
    ? `<img src="${escapeHtml(u.photo_url)}" alt=""/>`
    : escapeHtml(initials(name));
  // Apply the deterministic gradient inline (since chat avatar isn't .lawyer-chat-item-avatar)
  const pastel = avatarColorFromName(name);
  $('chatAvatar').style.background = [
    'linear-gradient(135deg,#6366f1,#4338ca)',
    'linear-gradient(135deg,#ec4899,#be185d)',
    'linear-gradient(135deg,#06b6d4,#0e7490)',
    'linear-gradient(135deg,#8b5cf6,#6d28d9)',
    'linear-gradient(135deg,#14b8a6,#0f766e)',
    'linear-gradient(135deg,#f59e0b,#b45309)',
    'linear-gradient(135deg,#ef4444,#b91c1c)',
    'linear-gradient(135deg,#84cc16,#4d7c0f)',
  ][pastel];

  $('claimBar').classList.toggle('hidden', !chat.is_free);
  $('chatEmpty').style.display = 'none';
  $('chatMessages').classList.remove('hidden');
  $('replyArea').classList.remove('hidden');

  $('replyInput').placeholder = `Ваш ответ ${firstName}…`;
  $('replyInput').value = '';
  $('replyInput').style.height = 'auto';
  $('charCounter').classList.remove('show', 'warning', 'danger');

  showView('chat');

  // Load messages
  try {
    const msgs = await api('GET', `/api/lawyer/chats/${chat.id}/messages`);
    renderMessages(msgs);
  } catch (e) { showToast(e.message); }

  // Focus textarea after the slide-in completes (don't fight the animation)
  if (window.innerWidth >= 900) {
    setTimeout(() => $('replyInput').focus(), 50);
  }
}

// ── Render messages with date separators + sender grouping ────
function renderMessages(msgs) {
  const wrap = $('chatMessages');
  wrap.innerHTML = '';

  let lastDateKey = null;
  let lastSenderKey = null;

  msgs.forEach((m, idx) => {
    const dateKey = m.created_at ? new Date(m.created_at).toDateString() : null;
    if (dateKey && dateKey !== lastDateKey) {
      const sep = document.createElement('div');
      sep.className = 'msg-date-separator';
      sep.textContent = formatDateSeparator(m.created_at);
      wrap.appendChild(sep);
      lastDateKey = dateKey;
      lastSenderKey = null; // group resets at a new date
    }

    const senderKey = `${m.sender_type}:${m.sender_id || m.sender_name || ''}`;
    const isCont = senderKey === lastSenderKey && m.sender_type !== 'system';

    // Check if this message is the LAST in its group (look ahead)
    const next = msgs[idx + 1];
    const nextSenderKey = next ? `${next.sender_type}:${next.sender_id || next.sender_name || ''}` : null;
    const nextDateKey = next && next.created_at ? new Date(next.created_at).toDateString() : null;
    const isLastInGroup = !next || nextSenderKey !== senderKey || nextDateKey !== dateKey || next.sender_type === 'system';

    const el = messageEl(m, { isCont, isLastInGroup });
    wrap.appendChild(el);

    lastSenderKey = m.sender_type === 'system' ? null : senderKey;
  });

  wrap.scrollTop = wrap.scrollHeight;
}

function messageEl(m, opts = {}) {
  const { isCont = false, isLastInGroup = true } = opts;
  const w = document.createElement('div');
  if (m.id != null) w.dataset.mid = m.id;
  const kind = m.sender_type === 'user' ? 'from-user'
             : m.sender_type === 'system' ? 'from-system'
             : 'from-staff';
  w.className = `msg-wrap ${kind}` + (isCont ? ' group-cont' : '') + (isLastInGroup ? ' group-last' : '');

  if (!isCont && kind === 'from-staff' && m.sender_name) {
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

  if (m.created_at && isLastInGroup && m.sender_type !== 'system') {
    const t = document.createElement('div');
    t.className = 'msg-time';
    t.textContent = fmtMsgTime(m.created_at);
    w.appendChild(t);
  }
  return w;
}

/** Add a message only if not already present. Used by HTTP-reply path and WS path. */
function addMessageIfNew(m) {
  if (m == null || m.id == null) return;
  const wrap = $('chatMessages');
  if (!wrap) return;
  if (wrap.querySelector(`[data-mid="${m.id}"]`)) return;

  // Determine if previous message in DOM was from same sender (for grouping)
  const lastEl = wrap.querySelector('.msg-wrap:last-child');
  const lastSenderKey = lastEl ? lastEl.dataset.sk : null;
  const senderKey = `${m.sender_type}:${m.sender_id || m.sender_name || ''}`;
  const isCont = lastEl && lastSenderKey === senderKey && m.sender_type !== 'system';

  // If last element was the "last in group" with a visible time, demote it to continuation
  if (isCont && lastEl) {
    lastEl.classList.add('group-cont');
    lastEl.classList.remove('group-last');
    lastEl.querySelector('.msg-time')?.remove();
    lastEl.querySelector('.msg-sender')?.remove();
  }

  const el = messageEl(m, { isCont, isLastInGroup: true });
  el.dataset.sk = senderKey;
  el.classList.add('msg-new');
  wrap.appendChild(el);

  // Only auto-scroll if user is near the bottom (don't yank away from history)
  const distFromBottom = wrap.scrollHeight - wrap.scrollTop - wrap.clientHeight;
  if (distFromBottom < 120) {
    wrap.scrollTo({ top: wrap.scrollHeight, behavior: 'smooth' });
  }
}

// ── Send reply ────────────────────────────────
async function sendReply() {
  const input = $('replyInput');
  const btn = $('replyBtn');
  const text = input.value.trim();
  if (!text || !CURRENT_CHAT_ID) return;

  input.value = '';
  input.style.height = 'auto';
  $('charCounter').classList.remove('show', 'warning', 'danger');

  btn.classList.add('sending');
  haptic('medium');

  try {
    const payload = await api('POST', `/api/lawyer/chats/${CURRENT_CHAT_ID}/messages`, { content: text });
    btn.classList.remove('sending');
    btn.classList.add('success');
    haptic('success');
    setTimeout(() => btn.classList.remove('success'), 380);
    addMessageIfNew(payload);
    loadChats();
  } catch (e) {
    btn.classList.remove('sending');
    showToast(e.message);
    haptic('error');
    input.value = text;
  }
}

$('replyBtn').addEventListener('click', sendReply);

const REPLY_MAX = 4000;
$('replyInput').addEventListener('input', (e) => {
  // Auto-grow
  e.target.style.height = 'auto';
  e.target.style.height = Math.min(e.target.scrollHeight, 130) + 'px';

  // Character counter (appears at 400+)
  const len = e.target.value.length;
  const counter = $('charCounter');
  if (len >= 400) {
    counter.textContent = `${len} / ${REPLY_MAX}`;
    counter.classList.add('show');
    counter.classList.toggle('warning', len >= REPLY_MAX * 0.8);
    counter.classList.toggle('danger', len >= REPLY_MAX);
  } else {
    counter.classList.remove('show', 'warning', 'danger');
  }
});

$('replyInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendReply(); }
});

// On focus, scroll into view (mobile keyboard hides input otherwise)
$('replyInput').addEventListener('focus', () => {
  setTimeout(() => {
    try { $('replyInput').scrollIntoView({ behavior: 'smooth', block: 'nearest' }); } catch {}
  }, 200);
});

// ── WebSocket ─────────────────────────────────
function connectWS() {
  if (!TOKEN) return;
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  WS = new WebSocket(`${proto}://${location.host}/ws/staff?token=${encodeURIComponent(TOKEN)}`);

  WS.onmessage = (e) => {
    let data; try { data = JSON.parse(e.data); } catch { return; }

    if (data.type === 'message' || data.type === 'new_message') {
      if (data.chat_id === CURRENT_CHAT_ID) {
        addMessageIfNew(data);
      } else {
        // Pulse the list item if message belongs to another chat we have open
        const item = document.querySelector(`.lawyer-chat-item[data-id="${data.chat_id}"]`);
        if (item) {
          item.classList.remove('pulse');
          void item.offsetWidth;
          item.classList.add('pulse');
          setTimeout(() => item.classList.remove('pulse'), 1100);
        }
        if (data.sender_type === 'user') haptic('light');
      }
      loadChats();
    } else if (data.type === 'chat_assigned') {
      haptic('warning');
      showToast('✨ Вам назначили новый чат', 3500);
      loadChats();
    } else if (data.type === 'chat_claimed') {
      if (data.claimed_by !== ME.id) {
        if (CURRENT_CHAT_ID === data.chat_id) {
          haptic('warning');
          showToast('Этот чат уже взял другой юрист', 3000);
          setTimeout(() => showView('list'), 400);
        }
        loadChats();
      }
    }
  };

  WS.onclose = () => setTimeout(connectWS, 3000);
  // Heartbeat
  setInterval(() => { try { WS?.send(JSON.stringify({type:'ping'})); } catch {} }, 25000);
}

// ── Initial render ────────────────────────────
checkAuth();
