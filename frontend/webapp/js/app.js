/* ───────────────────────────────────────────
   Юрист Бот – Main App
─────────────────────────────────────────── */

// Block text selection everywhere except inputs
document.addEventListener('selectstart', e => {
  if (!e.target.closest('input, textarea, [contenteditable]')) {
    e.preventDefault();
  }
});
document.addEventListener('contextmenu', e => {
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
  tg.BackButton.hide();
}

// Стабильный id для случая, когда приложение открыто ВНЕ Telegram (например, в
// браузере при отладке). Внутри Telegram всегда берётся настоящий
// initDataUnsafe.user.id. Раньше тут стояла общая константа 100000001 — из-за
// неё ВСЕ, кто вне Telegram, становились одним пользователем: первый
// регистрировал аккаунт и занимал этот telegram_id, а у остальных на ЛЮБОЙ
// новый логин выскакивало «Аккаунт уже существует» (проверка идёт по
// telegram_id, а не по логину). Теперь каждый браузер получает свой id,
// сохранённый в localStorage; app.js и chat.js читают один и тот же ключ.
const FALLBACK_TGID_KEY = 'yurist_fallback_tgid';
function fallbackTgId() {
  let id = localStorage.getItem(FALLBACK_TGID_KEY);
  if (!id) {
    // Диапазон 10^11..10^12 — выше пространства реальных Telegram ID, чтобы
    // тестовый пользователь не пересёкся с настоящим.
    id = String(Math.floor(1e11 + Math.random() * 9e11));
    localStorage.setItem(FALLBACK_TGID_KEY, id);
  }
  return parseInt(id, 10);
}

const TG_USER = tg?.initDataUnsafe?.user || null;
const TG_ID   = TG_USER?.id || fallbackTgId();

const AUTH_TOKEN_KEY = 'yurist_auth_token';
const AUTH_LOGIN_KEY = 'yurist_auth_login';
const AUTH_UID_KEY   = 'yurist_auth_uid';    // users.id вошедшей учётки — по нему создаются чаты
const AUTH_TS_KEY    = 'yurist_auth_ts';     // когда пользователь последний раз заходил

// id вошедшей учётки в приложении (users.id). Именно он, а не telegram_id,
// определяет, чьи это чаты: один Telegram-аккаунт может держать несколько учёток.
let ACCOUNT_ID = parseInt(localStorage.getItem(AUTH_UID_KEY) || '0', 10) || null;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;     // авто-выход при неактивности > недели

// ── DOM refs ──────────────────────────────
const $authScreen    = document.getElementById('authScreen');
const $formLogin     = document.getElementById('formLogin');
const $formRegister  = document.getElementById('formRegister');
const $tabLogin      = document.getElementById('tabLogin');
const $tabRegister   = document.getElementById('tabRegister');
const $loginBtn      = document.getElementById('loginBtn');
const $registerBtn   = document.getElementById('registerBtn');
const $loginError    = document.getElementById('loginError');
const $registerError = document.getElementById('registerError');

// ── Bottom Nav ────────────────────────────
document.querySelectorAll('.bottom-nav-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const tab = btn.dataset.tab;
    document.querySelectorAll('.bottom-nav-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
    document.getElementById('tab-' + tab)?.classList.add('active');
    // Scroll to top on tab switch
    document.getElementById('tab-' + tab)?.scrollTo(0, 0);
  });
});

// ── FAQ accordion ─────────────────────────
function toggleFaq(el) {
  const isOpen = el.classList.contains('open');
  // Close all
  document.querySelectorAll('.faq-item.open').forEach(item => item.classList.remove('open'));
  // Toggle clicked
  if (!isOpen) el.classList.add('open');
}

// ── Auth tab switching ────────────────────
function switchToLogin() {
  $tabLogin.classList.add('active');
  $tabRegister.classList.remove('active');
  $formLogin.classList.remove('hidden');
  $formRegister.classList.add('hidden');
  $loginError.classList.remove('show');
}

function switchToRegister() {
  $tabRegister.classList.add('active');
  $tabLogin.classList.remove('active');
  $formRegister.classList.remove('hidden');
  $formLogin.classList.add('hidden');
  $registerError.classList.remove('show');
}

$tabLogin.addEventListener('click', switchToLogin);
$tabRegister.addEventListener('click', switchToRegister);

// ── Password visibility toggle ────────────
function setupToggle(btnId, inputId) {
  document.getElementById(btnId).addEventListener('click', () => {
    const input = document.getElementById(inputId);
    input.type = input.type === 'password' ? 'text' : 'password';
  });
}
setupToggle('toggleLoginPwd', 'loginPassword');
setupToggle('toggleRegPwd', 'regPassword');

// ── Auth API ──────────────────────────────
async function apiAuth(path, body) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  let data;
  try { data = await res.json(); } catch { data = {}; }

  if (!res.ok) {
    let msg = 'Ошибка сервера. Попробуйте позже.';
    if (data.detail) {
      if (typeof data.detail === 'string') {
        msg = data.detail;
      } else if (Array.isArray(data.detail)) {
        const first = data.detail[0] || {};
        const type = first.type || '';
        const RU = {
          'string_pattern_mismatch': 'Логин содержит недопустимые символы. Используйте буквы, цифры и _',
          'string_too_short': 'Слишком короткое значение',
          'string_too_long':  'Слишком длинное значение',
          'missing':          'Заполните все обязательные поля',
          'value_error':      'Неверное значение',
          'int_parsing':      'Ожидается числовое значение',
        };
        msg = RU[type] || 'Проверьте правильность введённых данных';
      }
    }
    throw new Error(msg);
  }
  return data;
}

function setLoading(btn, loading, label) {
  btn.disabled = loading;
  btn.innerHTML = loading
    ? `<div class="auth-btn-loading"><div class="auth-spinner"></div> Загрузка...</div>`
    : label;
}

// ── Login ─────────────────────────────────
$loginBtn.addEventListener('click', async () => {
  const login    = document.getElementById('loginUsername').value.trim();
  const password = document.getElementById('loginPassword').value;
  $loginError.classList.remove('show');

  if (!login || !password) {
    $loginError.textContent = 'Заполните все поля';
    $loginError.classList.add('show');
    return;
  }

  setLoading($loginBtn, true, 'Войти');
  try {
    const data = await apiAuth('/api/auth/login', { telegram_id: TG_ID, login, password });
    onAuthSuccess(data.token, data.login, data.photo_url, data.user_id);
  } catch(e) {
    $loginError.textContent = e.message;
    $loginError.classList.add('show');
  } finally {
    setLoading($loginBtn, false, 'Войти');
  }
});

document.getElementById('loginPassword').addEventListener('keydown', e => {
  if (e.key === 'Enter') $loginBtn.click();
});

// ── Register ──────────────────────────────
$registerBtn.addEventListener('click', async () => {
  const login    = document.getElementById('regUsername').value.trim();
  const password = document.getElementById('regPassword').value;
  const confirm  = document.getElementById('regPasswordConfirm').value;
  $registerError.classList.remove('show');

  if (!login || !password || !confirm) {
    $registerError.textContent = 'Заполните все поля';
    $registerError.classList.add('show');
    return;
  }
  if (password !== confirm) {
    $registerError.textContent = 'Пароли не совпадают';
    $registerError.classList.add('show');
    return;
  }
  if (password.length < 6) {
    $registerError.textContent = 'Пароль минимум 6 символов';
    $registerError.classList.add('show');
    return;
  }

  setLoading($registerBtn, true, 'Создать аккаунт');
  try {
    const data = await apiAuth('/api/auth/register', {
      telegram_id: TG_ID,
      login,
      password,
      first_name: TG_USER?.first_name || null,
      last_name:  TG_USER?.last_name  || null,
      username:   TG_USER?.username   || null,
    });
    onAuthSuccess(data.token, data.login, data.photo_url, data.user_id);
  } catch(e) {
    $registerError.textContent = e.message;
    $registerError.classList.add('show');
  } finally {
    setLoading($registerBtn, false, 'Создать аккаунт');
  }
});

document.getElementById('regPasswordConfirm').addEventListener('keydown', e => {
  if (e.key === 'Enter') $registerBtn.click();
});

// ── Auth success ──────────────────────────
function onAuthSuccess(token, login, photoUrl, userId) {
  localStorage.setItem(AUTH_TOKEN_KEY, token);
  localStorage.setItem(AUTH_LOGIN_KEY, login);
  if (userId) { localStorage.setItem(AUTH_UID_KEY, String(userId)); ACCOUNT_ID = userId; }
  localStorage.setItem(AUTH_TS_KEY, String(Date.now()));
  document.documentElement.classList.add('pre-authed');
  $authScreen.classList.add('hidden');
  loadProfile(login, photoUrl);
  loadGroups();
}

// ── Logout ────────────────────────────────
function logout() {
  localStorage.removeItem(AUTH_TOKEN_KEY);
  localStorage.removeItem(AUTH_LOGIN_KEY);
  localStorage.removeItem(AUTH_UID_KEY);
  localStorage.removeItem(AUTH_TS_KEY);
  ACCOUNT_ID = null;
  document.documentElement.classList.remove('pre-authed');
  location.reload();
}

// ── Toast ─────────────────────────────────
let _toastTimer;
function showToast(msg) {
  const t = document.getElementById('toast');
  if (!t) return;
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => t.classList.remove('show'), 2500);
}

function escapeHtmlSafe(s) { return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

// ── Group chats (shown under the 3 main cards) ──
async function loadGroups() {
  if (!ACCOUNT_ID) return;   // группы принадлежат учётке, не telegram_id
  try {
    const res = await fetch(`/api/chats/groups?user_id=${ACCOUNT_ID}`);
    if (!res.ok) return;
    renderGroupCards(await res.json());
  } catch {}
}

function renderGroupCards(groups) {
  const wrap = document.getElementById('groupCards');
  if (!wrap) return;
  if (!Array.isArray(groups) || !groups.length) { wrap.innerHTML = ''; return; }
  const icon = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>`;
  const chevron = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18l6-6-6-6"/></svg>`;
  let html = `<div class="group-cards-title">Общие чаты</div>`;
  for (const g of groups) {
    const parts = [];
    if (g.lawyer_name) parts.push(`⚖️ ${escapeHtmlSafe(g.lawyer_name)}`);
    if (g.manager_name) parts.push(`🧭 ${escapeHtmlSafe(g.manager_name)}`);
    const sub = parts.join(' · ') || 'Юрист и менеджер';
    html += `
      <a class="card group-card" href="/chat.html?type=group&chat_id=${g.chat_id}">
        <div class="card-icon">${icon}</div>
        <div class="card-content">
          <div class="card-title">Общий чат</div>
          <div class="card-desc">${sub}</div>
        </div>
        <div class="card-arrow">${chevron}</div>
        <div class="badge group-badge">Группа</div>
      </a>`;
  }
  wrap.innerHTML = html;
}

// ── Clear chat history (only on the user's side) ──
async function clearHistory(chatType, label) {
  if (!ACCOUNT_ID) { showToast('Сначала войдите'); return; }
  if (!confirm(`Очистить историю «${label}»?\n\nУ вас она исчезнет, но у собеседника сохранится.`)) return;
  try {
    const res = await fetch('/api/chats/clear', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user_id: ACCOUNT_ID, chat_type: chatType }),
    });
    if (!res.ok) throw new Error();
    showToast(`История «${label}» очищена`);
  } catch {
    showToast('Не удалось очистить историю');
  }
}

// ── Profile ───────────────────────────────
function loadProfile(login, photoUrl) {
  const name = TG_USER
    ? [TG_USER.first_name, TG_USER.last_name].filter(Boolean).join(' ')
    : 'Пользователь';

  // Avatar: priority → SDK photo_url → backend photo_url → initials
  const avatarEl = document.getElementById('profileAvatar');
  const photo = TG_USER?.photo_url || photoUrl || null;

  if (photo) {
    avatarEl.innerHTML = `
      <img
        src="${photo}"
        alt="Avatar"
        style="width:100%;height:100%;object-fit:cover;border-radius:50%;"
        onerror="this.parentElement.innerHTML=fallbackAvatar('${login || name}')"
      />`;
  } else {
    avatarEl.innerHTML = fallbackAvatar(login || name);
  }

  document.getElementById('profileName').textContent    = name || login;
  document.getElementById('profileLogin').textContent   = '@' + (login || '—');
  document.getElementById('profileRowLogin').textContent = login || '—';
  document.getElementById('profileTgName').textContent  = TG_USER
    ? (TG_USER.username ? '@' + TG_USER.username : name)
    : 'Не подключён';
}

function fallbackAvatar(label) {
  const initial = (label || '?')[0].toUpperCase();
  return `<span style="font-size:28px;font-weight:700;color:rgba(255,255,255,0.8)">${initial}</span>`;
}

// ── Check auth on load ────────────────────
function clearAuthLocal() {
  localStorage.removeItem(AUTH_TOKEN_KEY);
  localStorage.removeItem(AUTH_LOGIN_KEY);
  localStorage.removeItem(AUTH_UID_KEY);
  localStorage.removeItem(AUTH_TS_KEY);
  ACCOUNT_ID = null;
  document.documentElement.classList.remove('pre-authed');
}

function showAuthScreen() {
  document.documentElement.classList.remove('pre-authed');
  $authScreen.classList.remove('hidden');
}

async function checkAuth() {
  const token = localStorage.getItem(AUTH_TOKEN_KEY);
  const login = localStorage.getItem(AUTH_LOGIN_KEY);
  const ts = parseInt(localStorage.getItem(AUTH_TS_KEY) || '0', 10);
  const stale = !!token && ts > 0 && (Date.now() - ts > WEEK_MS);

  if (token && !stale) {
    // Пользователь уже входил → экран регистрации не показываем даже на миг.
    // (pre-authed уже выставлен inline-скриптом в <head>, но подстрахуемся.)
    document.documentElement.classList.add('pre-authed');
    $authScreen.classList.add('hidden');
    loadProfile(login, null);
    loadGroups();
    localStorage.setItem(AUTH_TS_KEY, String(Date.now()));

    // Тихая фоновая проверка сессии — не мигаем экраном входа.
    try {
      const res = await fetch('/api/auth/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
      });
      if (res.ok) {
        let v = {};
        try { v = await res.json(); } catch {}
        // Обновляем id учётки из сессии (важно для старых сессий, где uid не
        // сохранялся) и перезагружаем группы уже с правильным ACCOUNT_ID.
        if (v.user_id) {
          ACCOUNT_ID = v.user_id;
          localStorage.setItem(AUTH_UID_KEY, String(v.user_id));
          loadGroups();
        }
        loadProfile(login, v.photo_url);
      } else {
        // Сессия действительно недействительна — только теперь показываем вход.
        clearAuthLocal();
        showAuthScreen();
      }
    } catch {
      // Нет сети — оставляем пользователя внутри, ничего не мигает.
    }
    return;
  }

  // Не вошёл (или не заходил больше недели) → показываем вход.
  if (stale) clearAuthLocal();
  showAuthScreen();
  try {
    const res = await fetch('/api/auth/check', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ telegram_id: TG_ID }),
    });
    const data = await res.json();
    if (!data.has_account) switchToRegister();
  } catch {}
}

checkAuth();

// ── Card 3D press effect ──────────────────
document.querySelectorAll('.card').forEach(card => {
  card.addEventListener('touchstart', () => {
    card.style.transform = 'perspective(1000px) translateZ(-6px) scale(0.97)';
  }, { passive: true });
  card.addEventListener('touchend', () => {
    card.style.transform = '';
  }, { passive: true });
  card.addEventListener('mouseleave', () => {
    card.style.transform = '';
  });
});
