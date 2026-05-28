// Initialize Telegram WebApp
const tg = window.Telegram?.WebApp;
if (tg) {
  tg.ready();
  tg.expand();
  tg.setHeaderColor('#000000');
  tg.setBackgroundColor('#000000');
}

// Register user on app start
async function registerUser() {
  const user = tg?.initDataUnsafe?.user;
  if (!user) return;
  try {
    await fetch('/api/users/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        telegram_id: user.id,
        username: user.username,
        first_name: user.first_name,
        last_name: user.last_name,
      }),
    });
  } catch (e) {
    console.error('Failed to register user:', e);
  }
}

registerUser();

// Card press 3D effect
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
