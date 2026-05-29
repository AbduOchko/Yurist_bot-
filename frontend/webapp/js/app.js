/* ───────────────────────────────────────────
   Юрист Бот – Main App
─────────────────────────────────────────── */

const tg = window.Telegram?.WebApp;
if (tg) {
  tg.ready();
  tg.expand();
  try { tg.setHeaderColor('#000000'); } catch(e) {}
  try { tg.setBackgroundColor('#000000'); } catch(e) {}
  tg.BackButton.hide();
}

const TG_USER = tg?.initDataUnsafe?.user || null;
const TG_ID   = TG_USER?.id || 100000001;

const AUTH_TOKEN_KEY = 'yurist_auth_token';
const AUTH_LOGIN_KEY = 'yurist_auth_login';

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
    onAuthSuccess(data.token, data.login, data.photo_url);
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
    onAuthSuccess(data.token, data.login, data.photo_url);
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
function onAuthSuccess(token, login, photoUrl) {
  localStorage.setItem(AUTH_TOKEN_KEY, token);
  localStorage.setItem(AUTH_LOGIN_KEY, login);
  $authScreen.classList.add('hidden');
  loadProfile(login, photoUrl);
}

// ── Logout ────────────────────────────────
function logout() {
  localStorage.removeItem(AUTH_TOKEN_KEY);
  localStorage.removeItem(AUTH_LOGIN_KEY);
  location.reload();
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
async function checkAuth() {
  const token = localStorage.getItem(AUTH_TOKEN_KEY);
  const login = localStorage.getItem(AUTH_LOGIN_KEY);

  if (!token) {
    try {
      const res = await fetch('/api/auth/check', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ telegram_id: TG_ID }),
      });
      const data = await res.json();
      if (!data.has_account) switchToRegister();
    } catch {}
    return;
  }

  try {
    const res = await fetch('/api/auth/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    });
    if (res.ok) {
      let verifyData = {};
      try { verifyData = await res.json(); } catch {}
      $authScreen.classList.add('hidden');
      loadProfile(login, verifyData.photo_url);
    } else {
      localStorage.removeItem(AUTH_TOKEN_KEY);
      localStorage.removeItem(AUTH_LOGIN_KEY);
    }
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
