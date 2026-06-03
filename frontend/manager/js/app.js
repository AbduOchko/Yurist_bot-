/* ─────────────────────────────────────────────────────────────
   Manager panel — mobile-first, lawyer-style polish.
   Чаты: единый инбокс всех пользователей (общение 1-на-1).
   Юристы: база юристов по категориям (специализациям).
   ───────────────────────────────────────────────────────────── */

const TOKEN_KEY = 'yurist_manager_token';
let TOKEN = localStorage.getItem(TOKEN_KEY) || '';
let ME = null;
let USERS = [];
let LAWYERS = [];
let GROUPS = [];
let CURRENT_CHAT_ID = null;
let CURRENT_USER = null;
let CURRENT_GROUP_ID = null;
let ASSIGN_USER_ID = null;
let WS = null;

// `tg` уже объявлен глобально в inline-скрипте <head>.
const $ = (id) => document.getElementById(id);

const AVATAR_GRADIENTS = [
  'linear-gradient(135deg,#6366f1,#4338ca)', 'linear-gradient(135deg,#ec4899,#be185d)',
  'linear-gradient(135deg,#06b6d4,#0e7490)', 'linear-gradient(135deg,#8b5cf6,#6d28d9)',
  'linear-gradient(135deg,#14b8a6,#0f766e)', 'linear-gradient(135deg,#f59e0b,#b45309)',
  'linear-gradient(135deg,#ef4444,#b91c1c)', 'linear-gradient(135deg,#84cc16,#4d7c0f)',
];

// ── Utils ─────────────────────────────────────
function escapeHtml(s) { return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function initials(name) {
  const p = String(name || '').trim().split(/\s+/);
  return ((p[0]?.[0] || '') + (p[1]?.[0] || '')).toUpperCase() || '?';
}
function avatarColorFromName(name) {
  const s = String(name || '');
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return Math.abs(h) % 8;
}
function smartTime(iso) {
  if (!iso) return '';
  const d = new Date(iso), now = new Date();
  const sec = Math.floor((now - d) / 1000);
  if (sec < 60) return 'только что';
  if (sec < 3600) return `${Math.floor(sec / 60)} мин назад`;
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  const yest = new Date(now); yest.setDate(yest.getDate() - 1);
  if (d.toDateString() === yest.toDateString()) return 'вчера';
  const dayDiff = Math.floor((now.setHours(0,0,0,0) - new Date(d).setHours(0,0,0,0)) / 86400000);
  if (dayDiff < 7) return d.toLocaleDateString('ru-RU', { weekday: 'short' });
  if (d.getFullYear() === new Date().getFullYear()) return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });
  return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short', year: '2-digit' });
}
function fmtMsgTime(iso) { return iso ? new Date(iso).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }) : ''; }
function formatDateSeparator(iso) {
  const d = new Date(iso), now = new Date();
  if (d.toDateString() === now.toDateString()) return 'Сегодня';
  const yest = new Date(now); yest.setDate(yest.getDate() - 1);
  if (d.toDateString() === yest.toDateString()) return 'Вчера';
  const dayDiff = Math.floor((now.setHours(0,0,0,0) - new Date(d).setHours(0,0,0,0)) / 86400000);
  if (dayDiff < 7) return d.toLocaleDateString('ru-RU', { weekday: 'long' });
  if (d.getFullYear() === new Date().getFullYear()) return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
  return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });
}
function pluralRu(n, one, few, many) {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) return few;
  return many;
}
function haptic(type) {
  const hf = tg?.HapticFeedback; if (!hf) return;
  try {
    if (['light','medium','heavy','rigid','soft'].includes(type)) hf.impactOccurred?.(type === 'soft' ? 'light' : type);
    else if (['success','error','warning'].includes(type)) hf.notificationOccurred?.(type);
    else if (type === 'select') hf.selectionChanged?.();
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
  if (!res.ok) throw new Error(typeof data.detail === 'string' ? data.detail : `HTTP ${res.status}`);
  return data;
}

// ── Toast ─────────────────────────────────────
function showToast(msg, duration = 2500) {
  const t = $('toast');
  t.textContent = msg; t.classList.remove('exit'); t.classList.add('show');
  clearTimeout(showToast._t); clearTimeout(showToast._exit);
  showToast._t = setTimeout(() => {
    t.classList.add('exit');
    showToast._exit = setTimeout(() => t.classList.remove('show', 'exit'), 220);
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
    if (data.role !== 'manager' && data.role !== 'owner') {
      $('loginError').textContent = 'Этот логин не для панели менеджера'; haptic('error'); return;
    }
    TOKEN = data.token; localStorage.setItem(TOKEN_KEY, TOKEN); ME = data;
    haptic('success'); enterApp();
  } catch (e) { $('loginError').textContent = e.message; haptic('error'); }
}

async function checkAuth() {
  if (!TOKEN) { showLogin(); return; }
  try {
    const data = await api('POST', '/api/staff/verify', {});
    if (data.role !== 'manager' && data.role !== 'owner') { logout(); return; }
    ME = data; enterApp();
  } catch { showLogin(); }
}

function showLogin() {
  $('loginPage').classList.remove('hidden');
  $('appShell').classList.add('hidden');
  if (WS) { WS.close(); WS = null; }
  setTgBackButton(false);
}
function logout() {
  localStorage.removeItem(TOKEN_KEY); TOKEN = ''; ME = null;
  showLogin();
}

$('loginBtn').addEventListener('click', tryLogin);
$('passwordInput').addEventListener('keydown', e => { if (e.key === 'Enter') tryLogin(); });
$('loginInput').addEventListener('keydown', e => { if (e.key === 'Enter') $('passwordInput').focus(); });
$('logoutBtn').addEventListener('click', async () => {
  try { await api('POST', '/api/staff/logout', {}); } catch {}
  logout();
});

function enterApp() {
  $('loginPage').classList.add('hidden');
  $('appShell').classList.remove('hidden');
  $('meName').textContent = ME.full_name || 'Менеджер';
  $('meRole').textContent = ME.role === 'owner' ? 'Владелец · режим менеджера' : 'Менеджер';
  loadUsers();
  loadLawyers();
  connectWS();
}

// ── Segmented control (Чаты / Юристы) ─────────
document.querySelectorAll('.mgr-seg-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    haptic('select');
    document.querySelectorAll('.mgr-seg-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    const v = btn.dataset.view;
    $('view-chats').classList.toggle('active', v === 'chats');
    $('view-groups').classList.toggle('active', v === 'groups');
    $('view-lawyers').classList.toggle('active', v === 'lawyers');
    if (v === 'lawyers') loadLawyers();
    else if (v === 'groups') loadGroups();
    else loadUsers();
  });
});

// ── Telegram BackButton ───────────────────────
function setTgBackButton(show) {
  if (!tg?.BackButton) return;
  try {
    if (show) { tg.BackButton.show(); tg.BackButton.onClick(handleTgBack); }
    else { tg.BackButton.offClick(handleTgBack); tg.BackButton.hide(); }
  } catch {}
}
function handleTgBack() {
  haptic('light');
  if ($('view-groups').classList.contains('active')) showGroupView('list');
  else showView('list');
}

function showView(name) {
  if (name === 'chat') {
    $('listView').classList.remove('active');
    $('chatView').classList.add('active');
    if (window.innerWidth < 900) setTgBackButton(true);
  } else {
    $('chatView').classList.remove('active');
    $('listView').classList.add('active');
    CURRENT_CHAT_ID = null; CURRENT_USER = null;
    document.querySelectorAll('.lawyer-chat-item.active').forEach(el => el.classList.remove('active'));
    setTgBackButton(false);
  }
}
$('backBtn').addEventListener('click', () => { haptic('light'); showView('list'); });

// ── Inbox (all users) ─────────────────────────
async function loadUsers() {
  try { USERS = await api('GET', '/api/manager/users'); renderUsers(); }
  catch (e) { showToast(e.message); }
}

function renderUsers() {
  const wrap = $('usersList'), meta = $('listMeta');
  if (!USERS.length) {
    meta.textContent = 'Пользователей пока нет';
    wrap.innerHTML = `<div class="lawyer-list-empty"><div class="lawyer-list-empty-icon">👥</div><div class="lawyer-list-empty-title">Пока пусто</div><div class="lawyer-list-empty-text">Когда кто-то напишет боту — он появится здесь.</div></div>`;
    return;
  }
  const withMsgs = USERS.filter(u => u.message_count > 0).length;
  meta.innerHTML = `<strong>${USERS.length}</strong> ${pluralRu(USERS.length, 'пользователь', 'пользователя', 'пользователей')}` +
    (withMsgs > 0 ? ` · <span class="meta-accent">${withMsgs} с перепиской</span>` : '');

  wrap.innerHTML = '';
  USERS.forEach((u, i) => {
    const name = [u.first_name, u.last_name].filter(Boolean).join(' ') || u.username || `Пользователь #${u.user_id}`;
    const last = u.last_message;
    const lastIsSelf = last && last.sender_type && last.sender_type !== 'user' && last.sender_type !== 'system';
    const senderLabel = lastIsSelf ? 'Вы' : (last?.sender_type === 'system' ? 'Система' : (u.first_name || 'Клиент'));
    const preview = last?.content || 'Нет сообщений';
    const time = smartTime(last?.created_at || u.updated_at || u.created_at);

    const item = document.createElement('div');
    item.className = 'lawyer-chat-item' + (u.chat_id && u.chat_id === CURRENT_CHAT_ID ? ' active' : '');
    item.dataset.id = u.user_id;
    if (u.chat_id) item.dataset.chatId = u.chat_id;
    item.style.setProperty('--item-delay', `${Math.min(i * 35, 320)}ms`);
    const color = avatarColorFromName(name);
    item.innerHTML = `
      <div class="lawyer-chat-item-avatar" data-color="${color}">${
        u.photo_url ? `<img src="${escapeHtml(u.photo_url)}" alt=""/>` : escapeHtml(initials(name))
      }</div>
      <div class="lawyer-chat-item-body">
        <div class="lawyer-chat-item-top">
          <div class="lawyer-chat-item-name">${escapeHtml(name)}</div>
          <div class="lawyer-chat-item-time">${escapeHtml(time)}</div>
        </div>
        <div class="lawyer-chat-item-preview"><span class="preview-sender${lastIsSelf ? ' is-self' : ''}">${escapeHtml(senderLabel)}:</span> ${escapeHtml(preview)}</div>
        <div class="lawyer-chat-item-badges">
          ${u.message_count > 0
            ? `<span class="lawyer-badge count">${u.message_count} ${pluralRu(u.message_count, 'сообщ.', 'сообщ.', 'сообщ.')}</span>`
            : `<span class="lawyer-badge free">🆕 новый</span>`}
          ${u.username ? `<span class="lawyer-badge count">@${escapeHtml(u.username)}</span>` : ''}
        </div>
      </div>`;
    item.addEventListener('click', () => { haptic('light'); openChat(u); });
    wrap.appendChild(item);
  });
}

async function openChat(u) {
  CURRENT_USER = u;
  let chatId = u.chat_id;
  if (!chatId) {
    try { const r = await api('POST', '/api/manager/chats/open', { user_id: u.user_id }); chatId = r.chat_id; u.chat_id = chatId; }
    catch (e) { showToast(e.message); return; }
  }
  CURRENT_CHAT_ID = chatId;
  document.querySelectorAll('.lawyer-chat-item.active').forEach(el => el.classList.remove('active'));
  document.querySelector(`.lawyer-chat-item[data-id="${u.user_id}"]`)?.classList.add('active');

  const name = [u.first_name, u.last_name].filter(Boolean).join(' ') || u.username || `Пользователь #${u.user_id}`;
  const sub = [u.username ? '@' + u.username : null, `Telegram ID ${u.telegram_id || '—'}`].filter(Boolean).join(' · ');
  $('chatHeaderName').textContent = name;
  $('chatHeaderSub').textContent = sub;
  $('chatAvatar').innerHTML = u.photo_url ? `<img src="${escapeHtml(u.photo_url)}" alt=""/>` : escapeHtml(initials(name));
  $('chatAvatar').style.background = AVATAR_GRADIENTS[avatarColorFromName(name)];

  $('chatEmpty').style.display = 'none';
  $('chatMessages').classList.remove('hidden');
  $('replyArea').classList.remove('hidden');
  $('replyInput').value = ''; $('replyInput').style.height = 'auto';
  $('replyInput').placeholder = `Сообщение ${u.first_name || 'пользователю'}…`;
  $('charCounter').classList.remove('show', 'warning', 'danger');

  showView('chat');

  try { const msgs = await api('GET', `/api/manager/chats/${chatId}/messages`); renderMessages(msgs); }
  catch (e) { showToast(e.message); }
  if (window.innerWidth >= 900) setTimeout(() => $('replyInput').focus(), 50);
}

// ── Messages (grouped, Telegram-like) ─────────
function renderMessages(msgs) {
  const wrap = $('chatMessages');
  wrap.innerHTML = '';
  let lastDateKey = null, lastSenderKey = null;
  msgs.forEach((m, idx) => {
    const dateKey = m.created_at ? new Date(m.created_at).toDateString() : null;
    if (dateKey && dateKey !== lastDateKey) {
      const sep = document.createElement('div');
      sep.className = 'msg-date-separator';
      sep.textContent = formatDateSeparator(m.created_at);
      wrap.appendChild(sep);
      lastDateKey = dateKey; lastSenderKey = null;
    }
    const senderKey = `${m.sender_type}:${m.sender_id || m.sender_name || ''}`;
    const isCont = senderKey === lastSenderKey && m.sender_type !== 'system';
    const next = msgs[idx + 1];
    const nextKey = next ? `${next.sender_type}:${next.sender_id || next.sender_name || ''}` : null;
    const nextDate = next && next.created_at ? new Date(next.created_at).toDateString() : null;
    const isLast = !next || nextKey !== senderKey || nextDate !== dateKey || next.sender_type === 'system';
    const el = messageEl(m, { isCont, isLastInGroup: isLast });
    el.dataset.sk = senderKey;
    wrap.appendChild(el);
    lastSenderKey = m.sender_type === 'system' ? null : senderKey;
  });
  wrap.scrollTop = wrap.scrollHeight;
}

function messageEl(m, opts = {}) {
  const { isCont = false, isLastInGroup = true } = opts;
  const w = document.createElement('div');
  if (m.id != null) w.dataset.mid = m.id;
  const kind = m.sender_type === 'user' ? 'from-user' : m.sender_type === 'system' ? 'from-system' : 'from-staff';
  w.className = `msg-wrap ${kind}` + (isCont ? ' group-cont' : '') + (isLastInGroup ? ' group-last' : '');
  if (!isCont && kind === 'from-staff' && m.sender_name) {
    const s = document.createElement('div'); s.className = 'msg-sender'; s.textContent = m.sender_name; w.appendChild(s);
  }
  const b = document.createElement('div'); b.className = 'msg-bubble';
  if (m.file_url && m.message_type !== 'text' && m.message_type !== 'system') {
    b.innerHTML = `<a href="${escapeHtml(m.file_url)}" target="_blank" style="color:inherit;text-decoration:underline">${escapeHtml(m.file_name || 'Файл')}</a>`;
    if (m.content) { const c = document.createElement('div'); c.style.marginTop = '4px'; c.textContent = m.content; b.appendChild(c); }
  } else {
    b.textContent = m.content || '';
  }
  w.appendChild(b);
  if (m.created_at && isLastInGroup && m.sender_type !== 'system') {
    const t = document.createElement('div'); t.className = 'msg-time'; t.textContent = fmtMsgTime(m.created_at); w.appendChild(t);
  }
  return w;
}

function addMessageIfNew(m) {
  if (m == null || m.id == null) return;
  const wrap = $('chatMessages');
  if (!wrap || wrap.querySelector(`[data-mid="${m.id}"]`)) return;
  const lastEl = wrap.querySelector('.msg-wrap:last-child');
  const senderKey = `${m.sender_type}:${m.sender_id || m.sender_name || ''}`;
  const isCont = lastEl && lastEl.dataset.sk === senderKey && m.sender_type !== 'system';
  if (isCont && lastEl) {
    lastEl.classList.add('group-cont'); lastEl.classList.remove('group-last');
    lastEl.querySelector('.msg-time')?.remove();
    lastEl.querySelector('.msg-sender')?.remove();
  }
  const el = messageEl(m, { isCont, isLastInGroup: true });
  el.dataset.sk = senderKey;
  el.classList.add('msg-new');
  wrap.appendChild(el);
  const dist = wrap.scrollHeight - wrap.scrollTop - wrap.clientHeight;
  if (dist < 140) wrap.scrollTo({ top: wrap.scrollHeight, behavior: 'smooth' });
}

function applyEdit(m) {
  const wrap = $('chatMessages');
  const el = wrap?.querySelector(`[data-mid="${m.id}"]`);
  if (!el) return;
  const isCont = el.classList.contains('group-cont');
  const isLast = el.classList.contains('group-last');
  const sk = el.dataset.sk;
  const fresh = messageEl(m, { isCont, isLastInGroup: isLast });
  if (sk) fresh.dataset.sk = sk;
  el.replaceWith(fresh);
}
function applyDelete(messageId) {
  const el = $('chatMessages')?.querySelector(`[data-mid="${messageId}"]`);
  if (!el) return;
  const b = el.querySelector('.msg-bubble');
  if (b) { b.textContent = 'Сообщение удалено'; b.style.opacity = '0.55'; b.style.fontStyle = 'italic'; }
  el.querySelector('.msg-time')?.remove();
}

// ── Send reply ────────────────────────────────
async function sendReply() {
  const input = $('replyInput'), btn = $('replyBtn');
  const text = input.value.trim();
  if (!text || !CURRENT_CHAT_ID) return;
  input.value = ''; input.style.height = 'auto';
  $('charCounter').classList.remove('show', 'warning', 'danger');
  btn.classList.add('sending'); haptic('medium');
  try {
    const m = await api('POST', `/api/manager/chats/${CURRENT_CHAT_ID}/messages`, { content: text });
    btn.classList.remove('sending'); btn.classList.add('success'); haptic('success');
    setTimeout(() => btn.classList.remove('success'), 380);
    addMessageIfNew(m);
    loadUsers();
  } catch (e) { btn.classList.remove('sending'); showToast(e.message); haptic('error'); input.value = text; }
}
$('replyBtn').addEventListener('click', sendReply);

const REPLY_MAX = 4000;
$('replyInput').addEventListener('input', (e) => {
  e.target.style.height = 'auto';
  e.target.style.height = Math.min(e.target.scrollHeight, 130) + 'px';
  const len = e.target.value.length, counter = $('charCounter');
  if (len >= 400) {
    counter.textContent = `${len} / ${REPLY_MAX}`;
    counter.classList.add('show');
    counter.classList.toggle('warning', len >= REPLY_MAX * 0.8);
    counter.classList.toggle('danger', len >= REPLY_MAX);
  } else counter.classList.remove('show', 'warning', 'danger');
});
$('replyInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendReply(); }
});

// ── Assign lawyer ─────────────────────────────
$('assignBtn').addEventListener('click', openAssignModal);
function openAssignModal() {
  if (!CURRENT_USER) { showToast('Сначала выберите пользователя'); return; }
  ASSIGN_USER_ID = CURRENT_USER.user_id;
  const name = [CURRENT_USER.first_name, CURRENT_USER.last_name].filter(Boolean).join(' ') || CURRENT_USER.username || `#${CURRENT_USER.user_id}`;
  $('assignUserInfo').textContent = `Пользователь: ${name}`;
  const list = $('assignLawyerList'); list.innerHTML = '';
  const active = LAWYERS.filter(l => l.is_active);
  if (!active.length) {
    list.innerHTML = `<div style="padding:14px;color:var(--text-secondary);font-size:13px">Нет активных юристов — сначала добавьте во вкладке «Юристы».</div>`;
  } else {
    for (const l of active) {
      const r = document.createElement('div'); r.className = 'data-row';
      r.innerHTML = `
        <div class="grow">
          <div class="data-name">${escapeHtml(l.full_name)}</div>
          <div class="data-sub">${escapeHtml(l.specialization || 'без категории')} · ${l.is_online ? '🟢 онлайн' : '⚫ оффлайн'}</div>
        </div>
        <button class="btn-primary" style="width:auto;padding:8px 14px" data-id="${l.id}">Выбрать</button>`;
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
    showToast(`Юрист «${lawyerName}» назначен`); haptic('success');
  } catch (e) { showToast(e.message); }
}

// ── Lawyers by category ───────────────────────
async function loadLawyers() {
  try { LAWYERS = await api('GET', '/api/manager/lawyers'); renderLawyersByCategory(); }
  catch (e) { showToast(e.message); }
}

function renderLawyersByCategory() {
  const wrap = $('lawyersByCategory');
  if (!LAWYERS.length) {
    wrap.innerHTML = `<div class="lawyer-list-empty"><div class="lawyer-list-empty-icon">⚖️</div><div class="lawyer-list-empty-title">Юристов нет</div><div class="lawyer-list-empty-text">Добавьте первого юриста кнопкой выше.</div></div>`;
    return;
  }
  const groups = {};
  for (const l of LAWYERS) {
    const cat = (l.specialization || '').trim() || 'Без категории';
    (groups[cat] = groups[cat] || []).push(l);
  }
  const cats = Object.keys(groups).sort((a, b) =>
    a === 'Без категории' ? 1 : b === 'Без категории' ? -1 : a.localeCompare(b, 'ru'));
  wrap.innerHTML = '';
  for (const cat of cats) {
    const sec = document.createElement('div'); sec.className = 'mgr-cat';
    const title = document.createElement('div'); title.className = 'mgr-cat-title';
    title.innerHTML = `${escapeHtml(cat)} <span class="mgr-cat-count">${groups[cat].length}</span>`;
    sec.appendChild(title);
    for (const l of groups[cat]) sec.appendChild(lawyerCard(l));
    wrap.appendChild(sec);
  }
}

function lawyerCard(l) {
  const card = document.createElement('div');
  card.className = 'mgr-lawyer-card' + (l.is_active ? '' : ' inactive');
  const color = avatarColorFromName(l.full_name);
  card.innerHTML = `
    <div class="mgr-lawyer-av" data-color="${color}">${escapeHtml(initials(l.full_name))}</div>
    <div class="mgr-lawyer-info">
      <div class="mgr-lawyer-name">${escapeHtml(l.full_name)}</div>
      <div class="mgr-lawyer-sub">@${escapeHtml(l.login)} · TG ${l.telegram_id || '—'} · ${l.is_online ? '🟢 онлайн' : '⚫ оффлайн'}${l.is_active ? '' : ' · уволен'}</div>
    </div>
    ${l.is_active ? `<button class="btn-danger" data-id="${l.id}">Уволить</button>` : ''}`;
  const btn = card.querySelector('.btn-danger');
  if (btn) btn.addEventListener('click', async () => {
    if (!confirm(`Уволить юриста «${l.full_name}»?`)) return;
    try { await api('DELETE', `/api/manager/lawyers/${l.id}`); loadLawyers(); showToast('Юрист уволен'); }
    catch (e) { showToast(e.message); }
  });
  return card;
}

// ── Add lawyer modal ──────────────────────────
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
  if (!body.full_name || !body.login || !body.password) { $('lwError').textContent = 'Заполните ФИО, логин и пароль'; return; }
  try {
    await api('POST', '/api/manager/lawyers', body);
    $('lawyerModal').classList.add('hidden');
    loadLawyers(); showToast('Юрист добавлен'); haptic('success');
  } catch (e) { $('lwError').textContent = e.message; }
});

// ── Group chats (пользователь + юрист + менеджер) ─────────────────────
const GRP_GRADIENT = 'linear-gradient(135deg,#2563eb,#1e3a8a)';
function grpRoleLabel(t, name) {
  if (t === 'lawyer')  return `⚖️ ${name || 'Юрист'}`;
  if (t === 'manager') return `🧭 ${name || 'Менеджер'}`;
  return `👤 ${name || 'Клиент'}`;
}
function grpRoleColor(t) {
  if (t === 'lawyer')  return '#60a5fa';
  if (t === 'manager') return '#fbbf24';
  return '#a78bfa';
}

async function loadGroups() {
  try { GROUPS = await api('GET', '/api/manager/groups'); renderGroupsList(); }
  catch (e) { showToast(e.message); }
}

function renderGroupsList() {
  const wrap = $('groupsList');
  if (!GROUPS.length) {
    wrap.innerHTML = `<div class="lawyer-list-empty"><div class="lawyer-list-empty-icon">👥</div><div class="lawyer-list-empty-title">Групп пока нет</div><div class="lawyer-list-empty-text">Создайте общий чат — пользователь, юрист и вы в одном чате.</div></div>`;
    return;
  }
  wrap.innerHTML = '';
  GROUPS.forEach((g, i) => {
    const u = g.user || {};
    const name = [u.first_name, u.last_name].filter(Boolean).join(' ') || u.username || `Пользователь #${g.user_id}`;
    const last = g.last_message;
    const preview = last?.content || 'Нет сообщений';
    const time = smartTime(last?.created_at || g.updated_at);
    const item = document.createElement('div');
    item.className = 'lawyer-chat-item' + (g.id === CURRENT_GROUP_ID ? ' active' : '');
    item.dataset.chatId = g.id;
    item.style.setProperty('--item-delay', `${Math.min(i * 35, 320)}ms`);
    item.innerHTML = `
      <div class="lawyer-chat-item-avatar" style="background:${GRP_GRADIENT}">👥</div>
      <div class="lawyer-chat-item-body">
        <div class="lawyer-chat-item-top">
          <div class="lawyer-chat-item-name">${escapeHtml(name)}</div>
          <div class="lawyer-chat-item-time">${escapeHtml(time)}</div>
        </div>
        <div class="lawyer-chat-item-preview">${escapeHtml(preview)}</div>
        <div class="lawyer-chat-item-badges">
          <span class="lawyer-badge free">⚖️ ${escapeHtml(g.lawyer_name || 'юрист')}</span>
          <span class="lawyer-badge count">${g.message_count} ${pluralRu(g.message_count, 'сообщ.', 'сообщ.', 'сообщ.')}</span>
        </div>
      </div>`;
    item.addEventListener('click', () => { haptic('light'); openGroup(g); });
    wrap.appendChild(item);
  });
}

async function openGroup(g) {
  CURRENT_GROUP_ID = g.id;
  document.querySelectorAll('#groupsList .lawyer-chat-item.active').forEach(el => el.classList.remove('active'));
  document.querySelector(`#groupsList .lawyer-chat-item[data-chat-id="${g.id}"]`)?.classList.add('active');
  const u = g.user || {};
  const name = [u.first_name, u.last_name].filter(Boolean).join(' ') || u.username || `Пользователь #${g.user_id}`;
  $('groupHeaderName').textContent = 'Общий чат';
  const parts = [`👤 ${name}`];
  if (g.lawyer_name) parts.push(`⚖️ ${g.lawyer_name}`);
  if (g.manager_name) parts.push(`🧭 ${g.manager_name}`);
  $('groupHeaderSub').textContent = parts.join(' · ');
  $('groupChatEmpty').style.display = 'none';
  $('groupMessages').classList.remove('hidden');
  $('groupReplyArea').classList.remove('hidden');
  $('groupReplyInput').value = ''; $('groupReplyInput').style.height = 'auto';
  showGroupView('chat');
  try { const msgs = await api('GET', `/api/manager/chats/${g.id}/messages`); renderGroupMessages(msgs); }
  catch (e) { showToast(e.message); }
  if (window.innerWidth >= 900) setTimeout(() => $('groupReplyInput').focus(), 50);
}

function renderGroupMessages(msgs) {
  const wrap = $('groupMessages'); wrap.innerHTML = '';
  let lastDateKey = null, lastSenderKey = null;
  msgs.forEach(m => {
    const dateKey = m.created_at ? new Date(m.created_at).toDateString() : null;
    if (dateKey && dateKey !== lastDateKey) {
      const sep = document.createElement('div'); sep.className = 'msg-date-separator';
      sep.textContent = formatDateSeparator(m.created_at); wrap.appendChild(sep);
      lastDateKey = dateKey; lastSenderKey = null;
    }
    const senderKey = `${m.sender_type}:${m.sender_id || m.sender_name || ''}`;
    const isCont = senderKey === lastSenderKey && m.sender_type !== 'system';
    const el = groupMessageEl(m, { isCont }); el.dataset.sk = senderKey; wrap.appendChild(el);
    lastSenderKey = m.sender_type === 'system' ? null : senderKey;
  });
  wrap.scrollTop = wrap.scrollHeight;
}

// myType for the manager view is 'manager' (own messages on the right).
function groupMessageEl(m, opts = {}) {
  const { isCont = false } = opts;
  const mine = m.sender_type === 'manager';
  const kind = m.sender_type === 'system' ? 'from-system' : (mine ? 'from-staff' : 'from-user');
  const w = document.createElement('div'); if (m.id != null) w.dataset.mid = m.id;
  w.className = `msg-wrap ${kind}` + (isCont ? ' group-cont' : '') + ' group-last';
  if (!isCont && !mine && m.sender_type !== 'system' && m.sender_name) {
    const s = document.createElement('div'); s.className = 'msg-sender';
    s.textContent = grpRoleLabel(m.sender_type, m.sender_name);
    s.style.color = grpRoleColor(m.sender_type);
    w.appendChild(s);
  }
  const b = document.createElement('div'); b.className = 'msg-bubble';
  if (m.file_url && m.message_type !== 'text' && m.message_type !== 'system') {
    b.innerHTML = `<a href="${escapeHtml(m.file_url)}" target="_blank" style="color:inherit;text-decoration:underline">${escapeHtml(m.file_name || 'Файл')}</a>`;
    if (m.content) { const c = document.createElement('div'); c.style.marginTop = '4px'; c.textContent = m.content; b.appendChild(c); }
  } else b.textContent = m.content || '';
  w.appendChild(b);
  if (m.created_at && m.sender_type !== 'system') { const t = document.createElement('div'); t.className = 'msg-time'; t.textContent = fmtMsgTime(m.created_at); w.appendChild(t); }
  return w;
}

function addGroupMessageIfNew(m) {
  if (m == null || m.id == null) return;
  const wrap = $('groupMessages'); if (!wrap || wrap.querySelector(`[data-mid="${m.id}"]`)) return;
  const lastEl = wrap.querySelector('.msg-wrap:last-child');
  const senderKey = `${m.sender_type}:${m.sender_id || m.sender_name || ''}`;
  const isCont = lastEl && lastEl.dataset.sk === senderKey && m.sender_type !== 'system';
  if (isCont && lastEl) { lastEl.querySelector('.msg-time')?.remove(); lastEl.querySelector('.msg-sender')?.remove(); }
  const el = groupMessageEl(m, { isCont }); el.dataset.sk = senderKey; el.classList.add('msg-new'); wrap.appendChild(el);
  const dist = wrap.scrollHeight - wrap.scrollTop - wrap.clientHeight;
  if (dist < 140) wrap.scrollTo({ top: wrap.scrollHeight, behavior: 'smooth' });
}

function applyGroupEdit(m) {
  const el = $('groupMessages')?.querySelector(`[data-mid="${m.id}"]`); if (!el) return;
  const isCont = el.classList.contains('group-cont'); const sk = el.dataset.sk;
  const fresh = groupMessageEl(m, { isCont }); if (sk) fresh.dataset.sk = sk; el.replaceWith(fresh);
}
function applyGroupDelete(messageId) {
  const el = $('groupMessages')?.querySelector(`[data-mid="${messageId}"]`); if (!el) return;
  const b = el.querySelector('.msg-bubble'); if (b) { b.textContent = 'Сообщение удалено'; b.style.opacity = '0.55'; b.style.fontStyle = 'italic'; }
  el.querySelector('.msg-time')?.remove();
}

async function sendGroupReply() {
  const input = $('groupReplyInput'), btn = $('groupReplyBtn');
  const text = input.value.trim(); if (!text || !CURRENT_GROUP_ID) return;
  input.value = ''; input.style.height = 'auto';
  btn.classList.add('sending'); haptic('medium');
  try {
    const m = await api('POST', `/api/manager/chats/${CURRENT_GROUP_ID}/messages`, { content: text });
    btn.classList.remove('sending'); btn.classList.add('success'); haptic('success');
    setTimeout(() => btn.classList.remove('success'), 380);
    addGroupMessageIfNew(m); loadGroups();
  } catch (e) { btn.classList.remove('sending'); showToast(e.message); haptic('error'); input.value = text; }
}
$('groupReplyBtn').addEventListener('click', sendGroupReply);
$('groupReplyInput').addEventListener('input', (e) => { e.target.style.height = 'auto'; e.target.style.height = Math.min(e.target.scrollHeight, 130) + 'px'; });
$('groupReplyInput').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendGroupReply(); } });

function showGroupView(name) {
  if (name === 'chat') {
    $('groupListView').classList.remove('active'); $('groupChatView').classList.add('active');
    if (window.innerWidth < 900) setTgBackButton(true);
  } else {
    $('groupChatView').classList.remove('active'); $('groupListView').classList.add('active');
    CURRENT_GROUP_ID = null;
    document.querySelectorAll('#groupsList .lawyer-chat-item.active').forEach(el => el.classList.remove('active'));
    setTgBackButton(false);
  }
}
$('groupBackBtn').addEventListener('click', () => { haptic('light'); showGroupView('list'); });

// Create group modal
$('createGroupBtn').addEventListener('click', () => {
  $('grpUser').innerHTML = USERS.length
    ? USERS.map(u => `<option value="${u.user_id}">${escapeHtml([u.first_name, u.last_name].filter(Boolean).join(' ') || u.username || ('#' + u.user_id))}</option>`).join('')
    : '<option value="">— нет пользователей —</option>';
  const active = LAWYERS.filter(l => l.is_active);
  $('grpLawyer').innerHTML = active.length
    ? active.map(l => `<option value="${l.id}">${escapeHtml(l.full_name)}${l.specialization ? ` — ${escapeHtml(l.specialization)}` : ''}</option>`).join('')
    : '<option value="">— нет юристов —</option>';
  $('grpError').textContent = '';
  $('groupModal').classList.remove('hidden');
});
$('grpCancel').addEventListener('click', () => $('groupModal').classList.add('hidden'));
$('grpSave').addEventListener('click', async () => {
  const user_id = parseInt($('grpUser').value);
  const lawyer_id = parseInt($('grpLawyer').value);
  if (!user_id || !lawyer_id) { $('grpError').textContent = 'Выберите пользователя и юриста'; return; }
  try {
    const r = await api('POST', '/api/manager/groups', { user_id, lawyer_id });
    $('groupModal').classList.add('hidden'); showToast('Общий чат создан'); haptic('success');
    await loadGroups();
    const g = GROUPS.find(x => x.id === r.chat_id); if (g) openGroup(g);
  } catch (e) { $('grpError').textContent = e.message; }
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
      if (data.chat_id === CURRENT_GROUP_ID) addGroupMessageIfNew(data);
      if (data.chat_id !== CURRENT_CHAT_ID && data.chat_id !== CURRENT_GROUP_ID) {
        const item = document.querySelector(`.lawyer-chat-item[data-chat-id="${data.chat_id}"]`);
        if (item) { item.classList.remove('pulse'); void item.offsetWidth; item.classList.add('pulse'); setTimeout(() => item.classList.remove('pulse'), 1100); }
        if (data.sender_type === 'user') haptic('light');
      }
      loadUsers(); loadGroups();
    } else if (data.type === 'edit') {
      applyEdit(data); applyGroupEdit(data); loadUsers(); loadGroups();
    } else if (data.type === 'delete') {
      applyDelete(data.message_id); applyGroupDelete(data.message_id); loadUsers(); loadGroups();
    }
  };
  WS.onclose = () => setTimeout(connectWS, 3000);
  setInterval(() => { try { WS?.send(JSON.stringify({ type: 'ping' })); } catch {} }, 25000);
}

// ── Start ─────────────────────────────────────
checkAuth();
