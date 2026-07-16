/* ───────────────────────────────────────────
   Юрист Бот – Chat Page Logic
─────────────────────────────────────────── */

// ── Block text selection everywhere except inputs ──
document.addEventListener('selectstart', e => {
  if (!e.target.closest('input, textarea, [contenteditable]')) {
    e.preventDefault();
  }
});
document.addEventListener('contextmenu', e => {
  // Prevent long-press context menu on iOS (triggers selection highlight)
  if (!e.target.closest('input, textarea, [contenteditable]')) {
    e.preventDefault();
  }
});

const tg = window.Telegram?.WebApp;
if (tg) {
  tg.ready();
  tg.expand();
  try { tg.setHeaderColor('#0a1024'); } catch(e) {}
  try { tg.setBackgroundColor('#0a1024'); } catch(e) {}
  tg.BackButton.show();
  tg.BackButton.onClick(() => leaveChat());
}

// Per-browser id для запуска вне Telegram — дублирует хелпер из app.js с тем же
// ключом localStorage (общего модуля в проекте нет, chat.html грузит только
// chat.js). Внутри Telegram не используется. Ключ обязан совпадать с app.js,
// иначе экран входа и чат увидят разных пользователей.
const FALLBACK_TGID_KEY = 'yurist_fallback_tgid';
function fallbackTgId() {
  let id = localStorage.getItem(FALLBACK_TGID_KEY);
  if (!id) {
    id = String(Math.floor(1e11 + Math.random() * 9e11));
    localStorage.setItem(FALLBACK_TGID_KEY, id);
  }
  return parseInt(id, 10);
}

// Плавный выход из чата
function leaveChat() {
  const page = document.querySelector('.chat-page');
  if (page) page.classList.add('leaving');
  setTimeout(() => { window.location.href = '/'; }, 190);
}

// Guard: redirect to main page if no auth token
(async function guardAuth() {
  const token = localStorage.getItem('yurist_auth_token');
  if (!token) { window.location.href = '/'; return; }
  try {
    const res = await fetch('/api/auth/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    });
    if (!res.ok) {
      localStorage.removeItem('yurist_auth_token');
      window.location.href = '/';
    }
  } catch {}
})();

// ── URL params ──────────────────────────────
const params = new URLSearchParams(location.search);
const CHAT_TYPE = params.get('type') || 'ai';
// Групповые чаты открываются по конкретному id (у пользователя их может быть много).
const FORCED_CHAT_ID = params.get('chat_id') ? parseInt(params.get('chat_id')) : null;
const API_BASE = '';  // same origin

const CHAT_CONFIG = {
  ai:      { title: 'ИИ-Советник',    status: 'Всегда онлайн', icon: 'ai'      },
  lawyer:  { title: 'Личный Юрист',   status: 'онлайн',         icon: 'lawyer'  },
  match:   { title: 'Подбор Юриста',  status: 'онлайн',         icon: 'match'   },
  support: { title: 'Поддержка',      status: 'онлайн',         icon: 'support' },
  group:   { title: 'Общий чат',      status: 'юрист и менеджер', icon: 'group' },
};

// Роли участников в групповом чате — для подписи «кто пишет».
function roleLabel(senderType, name) {
  if (senderType === 'lawyer')  return `⚖️ ${name || 'Юрист'}`;
  if (senderType === 'manager') return `🧭 ${name || 'Менеджер'}`;
  return `👤 ${name || 'Клиент'}`;
}
function roleColor(senderType) {
  if (senderType === 'lawyer')  return '#60a5fa';
  if (senderType === 'manager') return '#fbbf24';
  return '#a78bfa';
}

const FORWARD_TARGETS = {
  ai:     { title: 'ИИ-Советник',   desc: 'Консультация с ИИ'           },
  lawyer: { title: 'Личный Юрист',  desc: 'Чат с живым юристом'         },
  match:  { title: 'Подбор Юриста', desc: 'Поиск специалиста'           },
};

// ── State ───────────────────────────────────
let USER = null;
let USER_ID_INT = null;
let CHAT_ID = null;
let ws = null;
let messages = [];           // {id, sender_type, content, message_type, file_url, file_name, is_pinned, reply_to, created_at, updated_at}
let editingMessageId = null;
let replyToMessage = null;
let forwardMessageId = null;
let selectedMessageId = null;
let aiStreamBuffer = '';
let aiStreamEl = null;
let mediaRecorder = null;
let audioChunks = [];
let isRecording = false;
let pinnedMessages = [];
let pendingMedia = null;   // { msgType, dataUrl, fileName, fileSize, durationSec? } — медиа, ожидающее подписи

// ── DOM refs ─────────────────────────────────
const $title     = document.getElementById('chatTitle');
const $statusDot = document.getElementById('statusDot');
const $statusTxt = document.getElementById('statusText');
const $list      = document.getElementById('messagesList');
const $input     = document.getElementById('textInput');
const $sendBtn   = document.getElementById('sendBtn');
const $backBtn   = document.getElementById('backBtn');
const $voiceBtn  = document.getElementById('voiceBtn');
const $attachBtn = document.getElementById('attachBtn');
const $attachMenu= document.getElementById('attachMenu');
const $pinnedBar = document.getElementById('pinnedBar');
const $pinnedTxt = document.getElementById('pinnedText');
const $editBanner    = document.getElementById('editBanner');
const $editBannerLbl = document.getElementById('editBannerLabel');
const $editBannerTxt = document.getElementById('editBannerText');
const $editBannerClose = document.getElementById('editBannerClose');
const $ctxMenu   = document.getElementById('contextMenu');
const $ctxOverlay= document.getElementById('contextOverlay');
const $toast     = document.getElementById('toast');
const $fwdModal  = document.getElementById('forwardModal');
const $fwdOpts   = document.getElementById('forwardOptions');
const $fwdCancel = document.getElementById('forwardCancel');
const $imgViewer = document.getElementById('imageViewer');
const $imgViewerImg  = document.getElementById('imageViewerImg');
const $imgViewerClose= document.getElementById('imageViewerClose');
const $mediaPreview      = document.getElementById('mediaPreview');
const $mediaPreviewThumb = document.getElementById('mediaPreviewThumb');
const $mediaPreviewTitle = document.getElementById('mediaPreviewTitle');
const $mediaPreviewClose = document.getElementById('mediaPreviewClose');

// ── Init ─────────────────────────────────────
async function init() {
  const cfg = CHAT_CONFIG[CHAT_TYPE];
  $title.textContent = cfg.title;
  $statusTxt.textContent = cfg.status;
  setChatAvatar(CHAT_TYPE);

  // Fallback user when not inside Telegram — тот же per-browser id, что и на
  // экране входа (app.js), иначе аккаунт и его чаты разъедутся. Ключ общий.
  USER = tg?.initDataUnsafe?.user || { id: fallbackTgId(), first_name: 'Гость', username: null, last_name: null };
  USER_ID_INT = USER.id;

  $list.innerHTML = '<div class="loading"><div class="loading-spinner"></div></div>';

  try {
    if (FORCED_CHAT_ID) {
      // Открыт конкретный чат по id (групповой). Регистрируем пользователя на
      // всякий случай, но чат не пере-создаём — используем переданный id.
      await api('POST', '/api/users/', {
        telegram_id: USER_ID_INT,
        username: USER.username || null,
        first_name: USER.first_name || 'Гость',
        last_name: USER.last_name || null,
      });
      CHAT_ID = FORCED_CHAT_ID;
      if (CHAT_TYPE === 'group') await loadGroupInfo();
    } else {
      const userRes = await api('POST', '/api/users/', {
        telegram_id: USER_ID_INT,
        username: USER.username || null,
        first_name: USER.first_name || 'Гость',
        last_name: USER.last_name || null,
      });

      const chatRes = await api('POST', '/api/chats/', {
        user_id: userRes.id,
        chat_type: CHAT_TYPE,
      });
      CHAT_ID = chatRes.id;
    }

    await loadMessages();
    connectWS();
    await loadPinned();
  } catch (e) {
    console.error('Init error:', e);
    $list.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-icon" style="font-size:28px">⚠️</div>
        <h3>Ошибка подключения</h3>
        <p>Не удалось загрузить чат. Проверьте соединение.</p>
        <button onclick="location.reload()" style="
          margin-top:16px;padding:12px 24px;background:#fff;color:#000;
          border:none;border-radius:12px;font-size:15px;font-weight:600;cursor:pointer;">
          Попробовать снова
        </button>
      </div>`;
  }
}

function setChatAvatar(type) {
  const icons = {
    ai:     `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 8v4l3 3"/></svg>`,
    lawyer: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>`,
    match:  `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/></svg>`,
    support:`<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="4"/><line x1="4.93" y1="4.93" x2="9.17" y2="9.17"/><line x1="14.83" y1="14.83" x2="19.07" y2="19.07"/><line x1="14.83" y1="9.17" x2="19.07" y2="4.93"/><line x1="4.93" y1="19.07" x2="9.17" y2="14.83"/></svg>`,
    group:  `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>`,
  };
  document.getElementById('chatAvatar').innerHTML = icons[type] || icons.ai;
}

// ── API helper ───────────────────────────────
async function api(method, path, body) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(API_BASE + path, opts);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// ── Load messages ────────────────────────────
async function loadMessages() {
  const data = await api('GET', `/api/messages/${CHAT_ID}?limit=100`);
  messages = data;
  renderMessages();
  scrollToBottom(false);
}

async function loadPinned() {
  try {
    pinnedMessages = await api('GET', `/api/chats/${CHAT_ID}/pinned`);
    updatePinnedBar();
  } catch {}
}

async function loadGroupInfo() {
  try {
    const info = await api('GET', `/api/chats/group-info/${CHAT_ID}`);
    $title.textContent = 'Общий чат';
    const parts = [];
    if (info.lawyer_name) parts.push(`⚖️ ${info.lawyer_name}`);
    if (info.manager_name) parts.push(`🧭 ${info.manager_name}`);
    $statusTxt.textContent = parts.join(' · ') || 'юрист и менеджер';
  } catch {}
}

// ── WebSocket ────────────────────────────────
function connectWS() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const wsUrl = `${proto}://${location.host}/ws/chat/${CHAT_ID}/${USER_ID_INT}`;
  ws = new WebSocket(wsUrl);

  ws.onopen = () => console.log('WS connected');

  ws.onmessage = (e) => {
    const data = JSON.parse(e.data);
    handleWSMessage(data);
  };

  ws.onclose = () => {
    setTimeout(connectWS, 3000);
  };

  // Heartbeat
  setInterval(() => {
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'ping' }));
    }
  }, 25000);
}

function handleWSMessage(data) {
  switch (data.type) {
    case 'message':
      if (!messages.find(m => m.id === data.id)) {
        messages.push(data);
        appendMessage(data);
        scrollToBottom(true);
      }
      break;

    case 'ai_chunk':
      handleAIChunk(data.content);
      break;

    case 'ai_done':
      finalizeAIMessage(data);
      break;

    case 'ai_error':
      // Remove typing indicator and streaming bubble
      $list.querySelector('.typing-indicator')?.remove();
      if (aiStreamEl) {
        $list.querySelector('[data-id="ai-stream"]')?.remove();
        aiStreamEl = null;
        aiStreamBuffer = '';
      }
      showToast(data.content || 'Ошибка ИИ-советника');
      break;

    case 'edit':
      updateMessage(data);
      break;

    case 'delete':
      markDeleted(data.message_id);
      break;

    case 'pin':
      updatePinState(data);
      break;

    case 'typing':
      if (data.user_id !== USER_ID_INT) showTypingIndicator();
      break;

    case 'voice_transcript':
      showVoiceTranscript(data.message_id, data.content);
      break;
  }
}

// Show recognized speech text under a voice message bubble
function showVoiceTranscript(messageId, text) {
  const wrap = $list.querySelector(`[data-id="${messageId}"]`);
  if (!wrap) return;
  let cap = wrap.querySelector('.voice-transcript');
  if (!cap) {
    cap = document.createElement('div');
    cap.className = 'voice-transcript';
    wrap.querySelector('.bubble')?.appendChild(cap);
  }
  cap.textContent = text;
}

// ── Render all messages ───────────────────────
function renderMessages() {
  $list.innerHTML = '';
  if (!messages.length) {
    renderEmpty();
    return;
  }
  let lastDate = null;
  messages.forEach(msg => {
    const date = new Date(msg.created_at).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
    if (date !== lastDate) {
      $list.appendChild(createDateSep(date));
      lastDate = date;
    }
    $list.appendChild(createMessageEl(msg));
  });
}

function renderEmpty() {
  const prompts = {
    ai:     { icon: '🤖', title: 'ИИ-Советник готов',    text: 'Задайте любой юридический вопрос — получите профессиональный ответ мгновенно.' },
    lawyer: { icon: '👨‍💼', title: 'Личный Юрист',        text: 'Напишите ваш вопрос — юрист ответит в ближайшее время.' },
    match:  { icon: '🔍', title: 'Подбор Юриста',        text: 'Опишите вашу проблему — мы подберём подходящего специалиста.' },
    support:{ icon: '🛟', title: 'Поддержка',            text: 'Напишите ваш вопрос — владелец проекта ответит вам напрямую.' },
    group:  { icon: '👥', title: 'Общий чат',            text: 'Здесь вы, ваш юрист и менеджер. Напишите сообщение — его увидят все участники.' },
  };
  const p = prompts[CHAT_TYPE];
  $list.innerHTML = `
    <div class="empty-state">
      <div class="empty-state-icon" style="font-size:28px">${p.icon}</div>
      <h3>${p.title}</h3>
      <p>${p.text}</p>
    </div>`;
}

function showError() {
  $list.innerHTML = `
    <div class="empty-state">
      <div class="empty-state-icon">⚠️</div>
      <h3>Ошибка подключения</h3>
      <p>Попробуйте обновить страницу</p>
    </div>`;
}

// ── Date separator ────────────────────────────
function createDateSep(text) {
  const el = document.createElement('div');
  el.className = 'date-separator';
  el.innerHTML = `<span>${text}</span>`;
  return el;
}

// ── Create message element ────────────────────
function createMessageEl(msg) {
  const isUser = msg.sender_type === 'user';
  const wrap = document.createElement('div');
  wrap.className = `message-wrap ${isUser ? 'user' : 'other'}`;
  wrap.dataset.id = msg.id;

  if (!isUser && msg.sender_name) {
    const lbl = document.createElement('div');
    lbl.className = 'message-group-label';
    if (CHAT_TYPE === 'group') {
      // В групповом чате подписываем «кто это» (роль + имя) и красим по роли.
      lbl.textContent = roleLabel(msg.sender_type, msg.sender_name);
      lbl.style.color = roleColor(msg.sender_type);
    } else {
      lbl.textContent = msg.sender_name;
    }
    wrap.appendChild(lbl);
  }

  const bubble = document.createElement('div');
  bubble.className = `bubble${msg.is_pinned ? ' pinned' : ''}${msg.is_deleted ? ' deleted' : ''}`;

  if (msg.is_deleted) {
    bubble.textContent = 'Сообщение удалено';
  } else {
    // Forwarded badge
    if (msg.forwarded_from_chat_type) {
      const fwd = document.createElement('div');
      fwd.className = 'forwarded-badge';
      const names = { ai: 'ИИ-Советник', lawyer: 'Личный Юрист', match: 'Подбор Юриста' };
      fwd.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="15,17 20,12 15,7"/><path d="M4 18v-2a4 4 0 0 1 4-4h12"/></svg> Переслано из ${names[msg.forwarded_from_chat_type] || ''}`;
      bubble.appendChild(fwd);
    }

    // Reply preview
    if (msg.reply_to) {
      const rv = document.createElement('div');
      rv.className = 'reply-preview';
      rv.innerHTML = `<div class="reply-sender">${msg.reply_to.sender_type === 'user' ? 'Вы' : 'Юрист'}</div><div>${truncate(msg.reply_to.content || '[медиа]', 80)}</div>`;
      bubble.appendChild(rv);
    }

    // Content based on type
    bubble.appendChild(renderContent(msg, isUser));
  }

  // Long-press handler
  let pressTimer;
  const showCtx = (e) => {
    e.preventDefault();
    showContextMenu(e, msg.id, isUser, msg);
  };
  wrap.addEventListener('contextmenu', showCtx);
  wrap.addEventListener('touchstart', () => { pressTimer = setTimeout(() => showContextMenu({ clientX: 80, clientY: 300 }, msg.id, isUser, msg), 600); }, { passive: true });
  wrap.addEventListener('touchend', () => clearTimeout(pressTimer), { passive: true });
  wrap.addEventListener('touchmove', () => clearTimeout(pressTimer), { passive: true });

  wrap.appendChild(bubble);

  // Meta line
  const meta = document.createElement('div');
  meta.className = 'message-meta';
  const time = document.createElement('span');
  time.className = 'message-time';
  time.textContent = formatTime(msg.created_at);
  meta.appendChild(time);
  if (msg.updated_at && msg.updated_at !== msg.created_at) {
    const ed = document.createElement('span');
    ed.className = 'message-edited';
    ed.textContent = '· изм.';
    meta.appendChild(ed);
  }
  if (msg.is_pinned) {
    meta.innerHTML += `<svg class="pin-icon-small" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>`;
  }
  wrap.appendChild(meta);

  return wrap;
}

function renderContent(msg, isUser) {
  const frag = document.createDocumentFragment();

  if (msg.message_type === 'image' && msg.file_url) {
    const img = document.createElement('img');
    img.className = 'bubble-image';
    img.src = msg.file_url;
    img.alt = msg.file_name || 'Изображение';
    img.loading = 'lazy';
    img.draggable = false;
    img.addEventListener('click', () => openImageViewer(msg.file_url));
    img.addEventListener('error', () => {
      const broken = document.createElement('div');
      broken.className = 'bubble-image-broken';
      broken.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21,15 16,10 5,21"/></svg><span>Изображение недоступно</span>`;
      img.replaceWith(broken);
    });
    frag.appendChild(img);
  } else if (msg.message_type === 'video' && msg.file_url) {
    const vid = document.createElement('video');
    vid.className = 'bubble-video';
    vid.src = msg.file_url;
    vid.controls = true;
    vid.playsinline = true;
    frag.appendChild(vid);
  } else if (msg.message_type === 'voice' && msg.file_url) {
    frag.appendChild(createVoicePlayer(msg, isUser));
  } else if (msg.message_type === 'audio' && msg.file_url) {
    const audio = document.createElement('audio');
    audio.className = 'bubble-audio';
    audio.src = msg.file_url;
    audio.controls = true;
    frag.appendChild(audio);
  } else if (msg.message_type === 'document' && msg.file_url) {
    frag.appendChild(createFileCard(msg));
  } else {
    const span = document.createElement('span');
    span.style.whiteSpace = 'pre-wrap';
    span.textContent = msg.content || '';
    frag.appendChild(span);
  }

  // Caption under any media (фото/видео/голос/файл)
  const capText = mediaCaption(msg);
  if (capText && msg.message_type !== 'text' && msg.message_type !== 'system') {
    const cap = document.createElement('div');
    cap.style.cssText = 'margin-top:6px;font-size:14px;white-space:pre-wrap;';
    cap.textContent = capText;
    frag.appendChild(cap);
  }

  return frag;
}

// Caption for a media message: prefer the dedicated field; fall back to legacy
// image captions that used to live in `content`.
function mediaCaption(msg) {
  if (msg.caption) return msg.caption;
  if (msg.message_type === 'image' && msg.content) return msg.content;
  return null;
}

// Global registry of active voice players
const _activePlayers = new Set();

/**
 * Convert base64 data URL → Blob URL synchronously via atob().
 * Blob URLs work on iOS where large data URLs sometimes fail.
 */
function dataUrlToBlobUrl(dataUrl) {
  try {
    const comma = dataUrl.indexOf(',');
    if (comma < 0) return null;
    const meta     = dataUrl.slice(0, comma);
    const mimeType = (meta.match(/:(.*?);/) || [])[1] || 'audio/mpeg';
    const binary   = atob(dataUrl.slice(comma + 1));
    const bytes    = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return URL.createObjectURL(new Blob([bytes], { type: mimeType }));
  } catch {
    return null;
  }
}

function createVoicePlayer(msg, isUser) {
  const storedSec = msg.content && !isNaN(parseFloat(msg.content))
    ? parseFloat(msg.content) : null;

  const initLabel = storedSec ? formatDuration(storedSec) : '0:00';

  const div = document.createElement('div');
  div.className = 'voice-player';
  div.innerHTML = `
    <button class="voice-play-btn">${playIcon()}</button>
    <div class="voice-waveform"><div class="voice-progress" style="width:0%"></div></div>
    <span class="voice-duration">${initLabel}</span>`;

  const $btn      = div.querySelector('.voice-play-btn');
  const $progress = div.querySelector('.voice-progress');
  const $dur      = div.querySelector('.voice-duration');

  if (!msg.file_url) return div;

  // Convert data URL → Blob URL synchronously (no fetch, no async).
  // Blob URL plays reliably on iOS; falls back to raw data URL if conversion fails.
  const blobUrl = msg.file_url.startsWith('data:')
    ? dataUrlToBlobUrl(msg.file_url)
    : null;

  const audio = new Audio(blobUrl || msg.file_url);
  audio.preload = 'auto';

  let playing = false;

  function resetToPlay() {
    playing = false;
    $btn.innerHTML = playIcon();
    $progress.style.width = '0%';
    $dur.textContent = storedSec ? formatDuration(storedSec) : '0:00';
    _activePlayers.delete(stopThis);
  }

  function stopThis() {
    if (audio.paused) return;
    audio.pause();
    audio.currentTime = 0;
    resetToPlay();
  }

  audio.addEventListener('loadedmetadata', () => {
    const d = audio.duration;
    if (d && isFinite(d) && d > 0) {
      $dur.textContent = formatDuration(d);
    }
  });

  audio.addEventListener('timeupdate', () => {
    const total = (audio.duration && isFinite(audio.duration))
      ? audio.duration : (storedSec || 1);
    $progress.style.width = Math.min(audio.currentTime / total * 100, 100) + '%';
    $dur.textContent = formatDuration(audio.currentTime);
  });

  audio.addEventListener('ended', () => {
    audio.currentTime = 0;
    resetToPlay();
  });

  audio.addEventListener('error', () => resetToPlay());

  // ── Click: play() вызывается СИНХРОННО в click handler (требование iOS) ──
  $btn.addEventListener('click', () => {
    if (!audio.paused) {
      audio.pause();
      playing = false;
      $btn.innerHTML = playIcon();
      _activePlayers.delete(stopThis);
      return;
    }

    // Stop all other players first
    _activePlayers.forEach(fn => fn());
    _activePlayers.clear();

    audio.play()
      .then(() => {
        playing = true;
        $btn.innerHTML = pauseIcon();
        _activePlayers.add(stopThis);
      })
      .catch(err => {
        resetToPlay();
        // If blob URL failed, try raw data URL as last resort
        if (blobUrl) {
          audio.src = msg.file_url;
          audio.play()
            .then(() => {
              playing = true;
              $btn.innerHTML = pauseIcon();
              _activePlayers.add(stopThis);
            })
            .catch(() => showToast('Не удалось воспроизвести'));
        } else {
          showToast('Не удалось воспроизвести');
        }
      });
  });

  return div;
}

function playIcon() {
  return `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polygon points="5,3 19,12 5,21 5,3"/></svg>`;
}
function pauseIcon() {
  return `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="6" y1="4" x2="6" y2="20"/><line x1="18" y1="4" x2="18" y2="20"/></svg>`;
}

function createFileCard(msg) {
  const div = document.createElement('div');
  div.className = 'file-card';
  div.innerHTML = `
    <div class="file-icon">
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
        <polyline points="14,2 14,8 20,8"/>
      </svg>
    </div>
    <div class="file-info">
      <div class="file-name">${escHtml(msg.file_name || 'Файл')}</div>
      <div class="file-size">${formatSize(msg.file_size)}</div>
    </div>`;
  div.addEventListener('click', () => downloadFile(msg.file_url, msg.file_name));
  return div;
}

// ── Append single message ─────────────────────
function appendMessage(msg) {
  // Remove empty state if present
  const es = $list.querySelector('.empty-state');
  if (es) es.remove();

  const messages_before = $list.querySelectorAll('.message-wrap');
  const lastWrap = messages_before[messages_before.length - 1];
  const lastDate = lastWrap ? new Date(messages.find(m => String(m.id) === lastWrap.dataset.id)?.created_at || 0).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' }) : null;
  const thisDate = new Date(msg.created_at).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
  if (thisDate !== lastDate) $list.appendChild(createDateSep(thisDate));
  const el = createMessageEl(msg);
  el.classList.add('msg-appear');          // плавное появление нового сообщения
  $list.appendChild(el);
}

// ── AI Streaming ──────────────────────────────
function handleAIChunk(chunk) {
  if (!aiStreamEl) {
    // Remove typing indicator
    const ti = $list.querySelector('.typing-indicator');
    if (ti) ti.remove();

    // Create streaming message element
    aiStreamBuffer = '';
    const wrap = document.createElement('div');
    wrap.className = 'message-wrap other';
    wrap.dataset.id = 'ai-stream';
    const lbl = document.createElement('div');
    lbl.className = 'message-group-label';
    lbl.textContent = 'ИИ-Советник';
    wrap.appendChild(lbl);
    const bubble = document.createElement('div');
    bubble.className = 'bubble';
    aiStreamEl = document.createElement('span');
    aiStreamEl.style.whiteSpace = 'pre-wrap';
    bubble.appendChild(aiStreamEl);
    wrap.appendChild(bubble);
    const meta = document.createElement('div');
    meta.className = 'message-meta';
    meta.innerHTML = `<span class="message-time">${formatTime(new Date().toISOString())}</span>`;
    wrap.appendChild(meta);
    $list.appendChild(wrap);
  }
  aiStreamBuffer += chunk;
  aiStreamEl.textContent = aiStreamBuffer;
  scrollToBottom(true);
}

function finalizeAIMessage(data) {
  // Replace streaming element with real message
  const streamEl = $list.querySelector('[data-id="ai-stream"]');
  if (streamEl) streamEl.remove();
  aiStreamEl = null;
  aiStreamBuffer = '';
  messages.push(data);
  appendMessage(data);
  scrollToBottom(true);
}

// ── Typing indicator ──────────────────────────
let typingTimeout;
function showTypingIndicator() {
  let ti = $list.querySelector('.typing-indicator');
  if (!ti) {
    ti = document.createElement('div');
    ti.className = 'typing-indicator';
    ti.innerHTML = '<div class="typing-dot"></div><div class="typing-dot"></div><div class="typing-dot"></div>';
    $list.appendChild(ti);
    scrollToBottom(true);
  }
  clearTimeout(typingTimeout);
  typingTimeout = setTimeout(() => ti?.remove(), 3000);
}

// ── Send message ──────────────────────────────
async function sendMessage() {
  if (editingMessageId) { await submitEdit($input.value.trim()); return; }
  if (pendingMedia) { await sendPendingMedia($input.value.trim()); return; }

  const text = $input.value.trim();
  if (!text) return;

  $input.value = '';
  autoResize();
  $sendBtn.disabled = true;

  if (CHAT_TYPE === 'ai') {
    // Show typing indicator immediately
    const ti = document.createElement('div');
    ti.className = 'typing-indicator';
    ti.innerHTML = '<div class="typing-dot"></div><div class="typing-dot"></div><div class="typing-dot"></div>';
    $list.appendChild(ti);
    scrollToBottom(true);

    try {
      const res = await fetch('/api/ai/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: CHAT_ID,
          user_message: text,
          user_id: USER_ID_INT,
        }),
      });
      if (!res.ok) {
        // Server error — remove typing indicator right away
        $list.querySelector('.typing-indicator')?.remove();
        showToast('Ошибка ИИ-советника. Попробуйте ещё раз.');
      }
    } catch (e) {
      $list.querySelector('.typing-indicator')?.remove();
      showToast('Нет связи с сервером');
    }
  } else {
    try {
      await api('POST', '/api/messages/', {
        chat_id: CHAT_ID,
        sender_type: 'user',
        sender_id: USER_ID_INT,
        sender_name: USER.first_name || 'Пользователь',
        content: text,
        message_type: 'text',
        reply_to_id: replyToMessage?.id || null,
      });
      clearReply();
    } catch (e) {
      showToast('Ошибка отправки');
    }
  }

  // Send typing event via WS
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'typing' }));
  }
}

// ── Edit message ──────────────────────────────
function startEdit(msg) {
  editingMessageId = msg.id;
  $input.value = msg.content || '';
  $input.focus();
  autoResize();
  $editBanner.classList.remove('hidden');
  $editBannerLbl.textContent = 'Редактирование';
  $editBannerTxt.textContent = msg.content || '';
  $sendBtn.disabled = false;
}

async function submitEdit(text) {
  try {
    await api('PATCH', `/api/messages/${editingMessageId}`, { content: text });
    cancelEdit();
  } catch (e) {
    showToast('Ошибка редактирования');
  }
}

function cancelEdit() {
  editingMessageId = null;
  $input.value = '';
  $editBanner.classList.add('hidden');
  autoResize();
}

// ── Reply ────────────────────────────────────
function startReply(msg) {
  replyToMessage = msg;
  $editBanner.classList.remove('hidden');
  $editBannerLbl.textContent = 'Ответ';
  $editBannerTxt.textContent = msg.content || '[медиа]';
  $input.focus();
}

function clearReply() {
  replyToMessage = null;
  if (!editingMessageId) $editBanner.classList.add('hidden');
}

// ── Delete ────────────────────────────────────
async function deleteMessage(msgId) {
  try {
    await api('DELETE', `/api/messages/${msgId}`);
  } catch (e) {
    showToast('Ошибка удаления');
  }
}

function markDeleted(msgId) {
  const wrap = $list.querySelector(`[data-id="${msgId}"]`);
  if (wrap) {
    const bubble = wrap.querySelector('.bubble');
    if (bubble) {
      bubble.className = 'bubble deleted deleting';   // анимация исчезновения
      bubble.textContent = 'Сообщение удалено';
      setTimeout(() => bubble.classList.remove('deleting'), 400);
    }
  }
  const idx = messages.findIndex(m => m.id === msgId);
  if (idx !== -1) messages[idx].is_deleted = true;
}

// ── Pin / Unpin ───────────────────────────────
async function togglePin(msgId) {
  try {
    await api('POST', `/api/messages/${msgId}/pin`);
  } catch (e) {
    showToast('Ошибка закрепления');
  }
}

function updatePinState(data) {
  const msg = messages.find(m => m.id === data.id);
  if (msg) msg.is_pinned = data.is_pinned;
  const wrap = $list.querySelector(`[data-id="${data.id}"]`);
  if (wrap) {
    const bubble = wrap.querySelector('.bubble');
    if (bubble) bubble.classList.toggle('pinned', data.is_pinned);
  }
  if (data.is_pinned) {
    pinnedMessages = pinnedMessages.filter(p => p.id !== data.id);
    pinnedMessages.unshift(data);
  } else {
    pinnedMessages = pinnedMessages.filter(p => p.id !== data.id);
  }
  updatePinnedBar();
}

function updatePinnedBar() {
  if (pinnedMessages.length > 0) {
    const p = pinnedMessages[0];
    $pinnedTxt.textContent = p.content || '[медиа]';
    $pinnedBar.classList.remove('hidden');
  } else {
    $pinnedBar.classList.add('hidden');
  }
}

function updateMessage(data) {
  const msg = messages.find(m => m.id === data.id);
  if (msg) Object.assign(msg, data);
  const wrap = $list.querySelector(`[data-id="${data.id}"]`);
  if (wrap) {
    const bubble = wrap.querySelector('.bubble');
    if (bubble) {
      const txtSpan = bubble.querySelector('span');
      if (txtSpan) txtSpan.textContent = data.content;
      // вспышка при редактировании
      bubble.classList.remove('flash');
      void bubble.offsetWidth;
      bubble.classList.add('flash');
      setTimeout(() => bubble.classList.remove('flash'), 700);
    }
    // Update meta
    const meta = wrap.querySelector('.message-meta');
    if (meta) {
      const edited = meta.querySelector('.message-edited');
      if (!edited) {
        const ed = document.createElement('span');
        ed.className = 'message-edited';
        ed.textContent = '· изм.';
        meta.appendChild(ed);
      }
    }
  }
}

// ── Context Menu ──────────────────────────────
function showContextMenu(e, msgId, isUser, msg) {
  selectedMessageId = msgId;
  const cm = $ctxMenu;
  cm.classList.remove('hidden');
  $ctxOverlay.classList.remove('hidden');

  // Update pin label
  document.getElementById('ctxPinText').textContent = msg.is_pinned ? 'Открепить' : 'Закрепить';

  // Show/hide edit & delete for own messages only
  document.getElementById('ctxEdit').style.display = isUser ? 'flex' : 'none';
  document.getElementById('ctxDelete').style.display = isUser ? 'flex' : 'none';
  document.getElementById('ctxCopy').style.display = msg.content ? 'flex' : 'none';
  document.getElementById('ctxDownload').style.display = msg.file_url ? 'flex' : 'none';

  // Position
  const x = Math.min(e.clientX || 80, window.innerWidth - 220);
  const y = Math.min(e.clientY || 300, window.innerHeight - cm.offsetHeight - 20);
  cm.style.left = x + 'px';
  cm.style.top = y + 'px';
}

function hideContextMenu() {
  $ctxMenu.classList.add('hidden');
  $ctxOverlay.classList.add('hidden');
  selectedMessageId = null;
}

function getSelectedMessage() {
  return messages.find(m => m.id === selectedMessageId);
}

// ── Forward Modal ─────────────────────────────
function showForwardModal(msgId) {
  forwardMessageId = msgId;
  $fwdOpts.innerHTML = '';
  const icons = {
    ai:     `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 8v4l3 3"/></svg>`,
    lawyer: `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>`,
    match:  `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/></svg>`,
  };
  Object.entries(FORWARD_TARGETS).forEach(([type, info]) => {
    const div = document.createElement('div');
    div.className = `forward-option${type === CHAT_TYPE ? ' current' : ''}`;
    div.innerHTML = `
      <div class="forward-option-icon">${icons[type]}</div>
      <div>
        <div class="forward-option-name">${info.title}</div>
        <div class="forward-option-desc">${info.desc}</div>
      </div>`;
    if (type !== CHAT_TYPE) {
      div.addEventListener('click', () => forwardMessage(type));
    }
    $fwdOpts.appendChild(div);
  });
  $fwdModal.classList.remove('hidden');
}

async function forwardMessage(targetType) {
  const msg = messages.find(m => m.id === forwardMessageId);
  if (!msg) return;
  $fwdModal.classList.add('hidden');

  try {
    const userRes = await api('POST', '/api/users/', {
      telegram_id: USER_ID_INT,
      username: USER.username,
      first_name: USER.first_name,
      last_name: USER.last_name,
    });
    const chatRes = await api('POST', '/api/chats/', {
      user_id: userRes.id,
      chat_type: targetType,
    });
    await api('POST', '/api/messages/', {
      chat_id: chatRes.id,
      sender_type: 'user',
      sender_id: USER_ID_INT,
      content: msg.content,
      message_type: msg.message_type,
      file_url: msg.file_url,
      file_name: msg.file_name,
      file_size: msg.file_size,
      forwarded_from_chat_type: CHAT_TYPE,
    });
    showToast('Сообщение переслано');
  } catch (e) {
    showToast('Ошибка пересылки');
  }
}

// ── Media helpers — store as base64 in DB (survives Railway restarts) ────────

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = e => resolve(e.target.result);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

function compressImage(file, maxPx = 1024, quality = 0.72) {
  return new Promise(resolve => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      let { width: w, height: h } = img;
      if (w > maxPx || h > maxPx) {
        if (w >= h) { h = Math.round(h * maxPx / w); w = maxPx; }
        else        { w = Math.round(w * maxPx / h); h = maxPx; }
      }
      const canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      canvas.getContext('2d').drawImage(img, 0, 0, w, h);
      resolve(canvas.toDataURL('image/jpeg', quality));
    };
    img.onerror = () => { URL.revokeObjectURL(url); resolve(null); };
    img.src = url;
  });
}

function getMimeType(file) {
  if (file.type.startsWith('image/')) return 'image';
  if (file.type.startsWith('video/')) return 'video';
  if (file.type.startsWith('audio/')) return 'audio';
  return 'document';
}

// Stage a picked file as a pending attachment (with optional caption) — does
// NOT send yet; the user can add a caption and press send.
async function stagePendingFile(file) {
  showToast('Обработка…');
  let dataUrl, msgType;
  try {
    if (file.type.startsWith('image/')) { dataUrl = await compressImage(file); msgType = 'image'; }
    else if (file.type.startsWith('video/')) { dataUrl = await blobToDataUrl(file); msgType = 'video'; }
    else if (file.type.startsWith('audio/')) { dataUrl = await blobToDataUrl(file); msgType = 'audio'; }
    else { dataUrl = await blobToDataUrl(file); msgType = 'document'; }
  } catch { dataUrl = null; }
  if (!dataUrl) { showToast('Не удалось обработать файл'); return; }
  pendingMedia = { msgType, dataUrl, fileName: file.name || 'file', fileSize: file.size };
  showMediaPreview();
}

// Stage a recorded voice note as a pending attachment.
async function stagePendingVoice(blob, durationSec) {
  let dataUrl;
  try { dataUrl = await blobToDataUrl(blob); } catch { dataUrl = null; }
  if (!dataUrl) { showToast('Ошибка записи'); return; }
  pendingMedia = { msgType: 'voice', dataUrl, fileName: `voice_${Date.now()}`, fileSize: blob.size, durationSec };
  showMediaPreview();
}

function showMediaPreview() {
  if (!pendingMedia) return;
  const pm = pendingMedia;
  let thumb, title;
  if (pm.msgType === 'image')      { thumb = `<img src="${pm.dataUrl}" alt=""/>`; title = 'Фото'; }
  else if (pm.msgType === 'voice') { thumb = '🎤'; title = `Голосовое · ${formatDuration(pm.durationSec || 0)}`; }
  else if (pm.msgType === 'video') { thumb = '🎞'; title = 'Видео'; }
  else if (pm.msgType === 'audio') { thumb = '🎵'; title = 'Аудио'; }
  else                             { thumb = '📄'; title = truncate(pm.fileName || 'Файл', 28); }
  $mediaPreviewThumb.innerHTML = thumb;
  $mediaPreviewTitle.textContent = title;
  $mediaPreview.classList.remove('hidden');
  $input.placeholder = 'Добавьте подпись…';
  $sendBtn.disabled = false;
  $input.focus();
}

function hideMediaPreview() {
  $mediaPreview.classList.add('hidden');
  $input.placeholder = 'Сообщение...';
}

function cancelPendingMedia() {
  pendingMedia = null;
  hideMediaPreview();
  $sendBtn.disabled = !$input.value.trim() && !editingMessageId;
}

// Send the staged attachment together with the caption — as ONE message.
async function sendPendingMedia(caption) {
  const pm = pendingMedia;
  if (!pm) return;
  pendingMedia = null;
  hideMediaPreview();
  $input.value = '';
  autoResize();
  $sendBtn.disabled = true;
  const cap = (caption || '').trim() || null;

  try {
    // AI chat: image → vision, voice → (caption answered or canned reply).
    if (CHAT_TYPE === 'ai' && (pm.msgType === 'image' || pm.msgType === 'voice')) {
      showAITyping();
      const res = await fetch('/api/ai/media', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: CHAT_ID,
          user_id: USER_ID_INT,
          message_type: pm.msgType,
          file_url: pm.dataUrl,
          file_name: pm.fileName,
          file_size: pm.fileSize,
          caption: cap,
          duration: pm.durationSec || null,
        }),
      });
      if (!res.ok) { $list.querySelector('.typing-indicator')?.remove(); showToast('Ошибка отправки'); }
      return;
    }

    await api('POST', '/api/messages/', {
      chat_id: CHAT_ID,
      sender_type: 'user',
      sender_id: USER_ID_INT,
      sender_name: USER.first_name || 'Пользователь',
      message_type: pm.msgType,
      content: pm.msgType === 'voice' ? String(pm.durationSec || 0) : null,
      caption: cap,
      file_url: pm.dataUrl,
      file_name: pm.fileName,
      file_size: pm.fileSize,
      reply_to_id: replyToMessage?.id || null,
    });
    clearReply();
  } catch (e) {
    $list.querySelector('.typing-indicator')?.remove();
    showToast('Ошибка отправки файла');
  }
}

// Show AI typing indicator (reused for media)
function showAITyping() {
  $list.querySelector('.typing-indicator')?.remove();
  const ti = document.createElement('div');
  ti.className = 'typing-indicator';
  ti.innerHTML = '<div class="typing-dot"></div><div class="typing-dot"></div><div class="typing-dot"></div>';
  $list.appendChild(ti);
  scrollToBottom(true);
}

// ── Voice recording ───────────────────────────
const MIN_VOICE_SEC = 2;
let recStartTime = 0;
let recTimerInterval = null;
let recStream = null;
let recCancelled = false;

const $recordingRow = document.getElementById('recordingRow');
const $inputRow     = document.getElementById('inputRow');
const $recTimer     = document.getElementById('recTimer');
const $recCancelBtn = document.getElementById('recCancelBtn');

function showRecordingUI() {
  $inputRow.classList.add('hidden');
  $recordingRow.classList.remove('hidden');
  recStartTime = Date.now();
  $recTimer.textContent = '0:00';
  recTimerInterval = setInterval(() => {
    const s = Math.floor((Date.now() - recStartTime) / 1000);
    $recTimer.textContent = formatDuration(s);
  }, 100);
}

function hideRecordingUI() {
  $recordingRow.classList.add('hidden');
  $inputRow.classList.remove('hidden');
  clearInterval(recTimerInterval);
  recTimerInterval = null;
}

$recCancelBtn.addEventListener('click', () => {
  recCancelled = true;
  stopRecording(true);
});

async function startRecording() {
  recCancelled = false;
  try {
    recStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    audioChunks = [];

    // Pick best supported mimeType — mp4 first for iOS Safari
    const mimes = [
      'audio/mp4',
      'audio/mp4;codecs=mp4a.40.2',
      'audio/webm;codecs=opus',
      'audio/webm',
      'audio/ogg;codecs=opus',
    ];
    const mimeType = mimes.find(m => MediaRecorder.isTypeSupported(m)) || '';

    mediaRecorder = new MediaRecorder(recStream, mimeType ? { mimeType } : {});
    mediaRecorder.ondataavailable = e => {
      if (e.data && e.data.size > 0) audioChunks.push(e.data);
    };

    mediaRecorder.onstop = async () => {
      recStream.getTracks().forEach(t => t.stop());
      recStream = null;
      hideRecordingUI();
      $voiceBtn.classList.remove('recording');

      if (recCancelled) return;

      const durationSec = Math.round((Date.now() - recStartTime) / 1000);

      if (durationSec < MIN_VOICE_SEC) {
        showToast('Держите дольше — минимум 2 секунды');
        return;
      }

      if (!audioChunks.length) {
        showToast('Ошибка записи — нет данных');
        return;
      }

      // Use actual recorded type; never override mp4 data with webm label
      const actualType = mediaRecorder.mimeType || mimeType || '';
      const blob = actualType
        ? new Blob(audioChunks, { type: actualType })
        : new Blob(audioChunks);   // let browser detect type

      if (blob.size < 100) {
        showToast('Ошибка записи — слишком маленький файл');
        return;
      }

      // Не отправляем сразу — показываем превью, чтобы можно было добавить подпись.
      await stagePendingVoice(blob, durationSec);
    };

    mediaRecorder.start(100); // chunk every 100ms for reliability
    isRecording = true;
    $voiceBtn.classList.add('recording');
    showRecordingUI();

  } catch (err) {
    hideRecordingUI();
    showToast('Нет доступа к микрофону');
  }
}

function stopRecording(cancel = false) {
  if (!isRecording) return;
  recCancelled = cancel;
  isRecording = false;
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    mediaRecorder.stop();
  }
}

// ── Image viewer ──────────────────────────────
function openImageViewer(url) {
  $imgViewerImg.src = url;
  $imgViewer.classList.remove('hidden');
}

// ── Helpers ───────────────────────────────────
function scrollToBottom(smooth) {
  $list.scrollTo({ top: $list.scrollHeight, behavior: smooth ? 'smooth' : 'instant' });
}

function formatTime(iso) {
  return new Date(iso).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
}

function formatDuration(sec) {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function formatSize(bytes) {
  if (!bytes) return '';
  if (bytes < 1024) return bytes + ' Б';
  if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' КБ';
  return (bytes / 1048576).toFixed(1) + ' МБ';
}

function truncate(str, n) {
  return str.length > n ? str.slice(0, n) + '…' : str;
}

function escHtml(str) {
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function downloadFile(url, name) {
  const a = document.createElement('a');
  a.href = url;
  a.download = name || 'file';
  a.target = '_blank';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

let toastTimer;
function showToast(msg) {
  $toast.textContent = msg;
  $toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $toast.classList.remove('show'), 2500);
}

function autoResize() {
  $input.style.height = 'auto';
  $input.style.height = Math.min($input.scrollHeight, 100) + 'px';
}

// ── Event listeners ───────────────────────────
$backBtn.addEventListener('click', () => leaveChat());

$input.addEventListener('input', () => {
  autoResize();
  $sendBtn.disabled = !$input.value.trim() && !editingMessageId && !pendingMedia;
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'typing' }));
  }
});

$input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});

$sendBtn.addEventListener('click', sendMessage);

$editBannerClose.addEventListener('click', () => {
  if (editingMessageId) cancelEdit();
  else clearReply();
});

$attachBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  $attachMenu.classList.toggle('hidden');
});

document.addEventListener('click', () => $attachMenu.classList.add('hidden'));

document.getElementById('attachImage').addEventListener('click', () => {
  document.getElementById('fileInputImage').click();
  $attachMenu.classList.add('hidden');
});
document.getElementById('attachAudio').addEventListener('click', () => {
  document.getElementById('fileInputAudio').click();
  $attachMenu.classList.add('hidden');
});
document.getElementById('attachFile').addEventListener('click', () => {
  document.getElementById('fileInputFile').click();
  $attachMenu.classList.add('hidden');
});

document.getElementById('fileInputImage').addEventListener('change', (e) => {
  if (e.target.files[0]) stagePendingFile(e.target.files[0]);
  e.target.value = '';
});
document.getElementById('fileInputAudio').addEventListener('change', (e) => {
  if (e.target.files[0]) stagePendingFile(e.target.files[0]);
  e.target.value = '';
});
document.getElementById('fileInputFile').addEventListener('change', (e) => {
  if (e.target.files[0]) stagePendingFile(e.target.files[0]);
  e.target.value = '';
});

$mediaPreviewClose.addEventListener('click', cancelPendingMedia);

// Voice recording — touch
$voiceBtn.addEventListener('touchstart', (e) => {
  e.preventDefault();
  startRecording();
}, { passive: false });

$voiceBtn.addEventListener('touchend', (e) => {
  e.preventDefault();
  stopRecording(false);
}, { passive: false });

$voiceBtn.addEventListener('touchcancel', (e) => {
  e.preventDefault();
  stopRecording(true); // cancel on touchcancel
}, { passive: false });

// Voice recording — mouse (desktop)
$voiceBtn.addEventListener('mousedown', (e) => {
  e.preventDefault();
  startRecording();
});

document.addEventListener('mouseup', () => {
  if (isRecording) stopRecording(false);
});

// Context menu actions
$ctxOverlay.addEventListener('click', hideContextMenu);

document.getElementById('ctxPin').addEventListener('click', () => {
  if (selectedMessageId) togglePin(selectedMessageId);
  hideContextMenu();
});

document.getElementById('ctxReply').addEventListener('click', () => {
  const msg = getSelectedMessage();
  if (msg) startReply(msg);
  hideContextMenu();
});

document.getElementById('ctxEdit').addEventListener('click', () => {
  const msg = getSelectedMessage();
  if (msg) startEdit(msg);
  hideContextMenu();
});

document.getElementById('ctxCopy').addEventListener('click', () => {
  const msg = getSelectedMessage();
  if (msg?.content) {
    navigator.clipboard.writeText(msg.content).then(() => showToast('Скопировано'));
  }
  hideContextMenu();
});

document.getElementById('ctxDownload').addEventListener('click', () => {
  const msg = getSelectedMessage();
  if (msg?.file_url) downloadFile(msg.file_url, msg.file_name);
  hideContextMenu();
});

document.getElementById('ctxForward').addEventListener('click', () => {
  const id = selectedMessageId;
  hideContextMenu();
  if (id) showForwardModal(id);
});

document.getElementById('ctxDelete').addEventListener('click', () => {
  const id = selectedMessageId;
  hideContextMenu();
  if (id) deleteMessage(id);
});

$fwdCancel.addEventListener('click', () => $fwdModal.classList.add('hidden'));
$fwdModal.addEventListener('click', (e) => { if (e.target === $fwdModal) $fwdModal.classList.add('hidden'); });

$imgViewerClose.addEventListener('click', () => $imgViewer.classList.add('hidden'));
$imgViewer.addEventListener('click', (e) => { if (e.target === $imgViewer) $imgViewer.classList.add('hidden'); });

$pinnedBar.addEventListener('click', () => {
  if (pinnedMessages.length > 0) {
    const wrap = $list.querySelector(`[data-id="${pinnedMessages[0].id}"]`);
    wrap?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
});

// ── Start ─────────────────────────────────────
init();
