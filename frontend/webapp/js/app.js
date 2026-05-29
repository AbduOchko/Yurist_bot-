/* ───────────────────────────────────────────
   Юрист Бот – Main Page + Auth
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
const $authScreen   = document.getElementById('authScreen');
const $formLogin    = document.getElementById('formLogin');
const $formRegister = document.getElementById('formRegister');
const $tabLogin     = document.getElementById('tabLogin');
const $tabRegister  = document.getElementById('tabRegister');
const $loginBtn     = document.getElementById('loginBtn');
const $registerBtn  = document.getElementById('registerBtn');
const $loginError   = document.getElementById('loginError');
const $registerError= document.getElementById('registerError');

// ── Tab switching ────────────────────────
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
        // Pydantic v2 validation error list — translate to Russian
        const first = data.detail[0] || {};
        const type = first.type || '';
        const RU = {
          'string_pattern_mismatch': 'Логин содержит недопустимые символы. Используйте только буквы, цифры и _',
          'string_too_short':  'Слишком короткое значение',
          'string_too_long':   'Слишком длинное значение',
          'missing':           'Заполните все обязательные поля',
          'value_error':       'Неверное значение',
          'int_parsing':       'Ожидается числовое значение',
        };
        msg = RU[type] || 'Проверьте правильность введённых данных';
      }
    }
    throw new Error(msg);
  }
  return data;
}

function setLoading(btn, loading) {
  if (loading) {
    btn.disabled = true;
    btn.innerHTML = `<div class="auth-btn-loading"><div class="auth-spinner"></div> Загрузка...</div>`;
  } else {
    btn.disabled = false;
    btn.innerHTML = btn.dataset.label || btn.textContent;
  }
}

// ── Login ────────────────────────────────
$loginBtn.dataset.label = 'Войти';
$loginBtn.addEventListener('click', async () => {
  const login    = document.getElementById('loginUsername').value.trim();
  const password = document.getElementById('loginPassword').value;
  $loginError.classList.remove('show');

  if (!login || !password) {
    $loginError.textContent = 'Заполните все поля';
    $loginError.classList.add('show');
    return;
  }

  setLoading($loginBtn, true);
  try {
    const data = await apiAuth('/api/auth/login', {
      telegram_id: TG_ID,
      login,
      password,
    });
    onAuthSuccess(data.token, data.login);
  } catch(e) {
    $loginError.textContent = e.message;
    $loginError.classList.add('show');
  } finally {
    setLoading($loginBtn, false);
    $loginBtn.textContent = 'Войти';
  }
});

document.getElementById('loginPassword').addEventListener('keydown', e => {
  if (e.key === 'Enter') $loginBtn.click();
});

// ── Register ──────────────────────────────
$registerBtn.dataset.label = 'Создать аккаунт';
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

  setLoading($registerBtn, true);
  try {
    const data = await apiAuth('/api/auth/register', {
      telegram_id: TG_ID,
      login,
      password,
      first_name: TG_USER?.first_name || null,
      last_name:  TG_USER?.last_name  || null,
      username:   TG_USER?.username   || null,
    });
    onAuthSuccess(data.token, data.login);
  } catch(e) {
    $registerError.textContent = e.message;
    $registerError.classList.add('show');
  } finally {
    setLoading($registerBtn, false);
    $registerBtn.textContent = 'Создать аккаунт';
  }
});

document.getElementById('regPasswordConfirm').addEventListener('keydown', e => {
  if (e.key === 'Enter') $registerBtn.click();
});

// ── Auth success ──────────────────────────
function onAuthSuccess(token, login) {
  localStorage.setItem(AUTH_TOKEN_KEY, token);
  localStorage.setItem(AUTH_LOGIN_KEY, login);
  $authScreen.classList.add('hidden');
}

// ── Verify existing session ───────────────
async function checkAuth() {
  const token = localStorage.getItem(AUTH_TOKEN_KEY);
  if (!token) {
    // No token — check if this TG user has an account to decide tab
    try {
      const res = await fetch('/api/auth/check', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ telegram_id: TG_ID }),
      });
      const data = await res.json();
      if (!data.has_account) switchToRegister();
    } catch {}
    return; // Show auth screen
  }

  try {
    const res = await fetch('/api/auth/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    });
    if (res.ok) {
      // Valid session — hide auth screen
      $authScreen.classList.add('hidden');
    } else {
      localStorage.removeItem(AUTH_TOKEN_KEY);
    }
  } catch {}
}

// ── Start ────────────────────────────────
checkAuth();

// ── Card press 3D effect ──────────────────
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
