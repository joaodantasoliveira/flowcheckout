/* Tela de login. O prefixo secreto sai da própria URL — nada fica hardcoded. */

const BASE = location.pathname.replace(/\/(painel)?\/?$/, '');

const form = document.getElementById('login-form');
const button = document.getElementById('login-btn');
const errorBox = document.getElementById('login-error');

document.getElementById('totp').addEventListener('input', (e) => {
  e.target.value = e.target.value.replace(/\D/g, '').slice(0, 6);
});

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  errorBox.hidden = true;

  button.disabled = true;
  button.classList.add('is-loading');

  try {
    const res = await fetch(`${BASE}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: document.getElementById('username').value,
        password: document.getElementById('password').value,
        totp: document.getElementById('totp').value,
      }),
    });

    const body = await res.json().catch(() => ({}));

    if (!res.ok) throw new Error(body.error || 'Não foi possível entrar.');

    location.href = `${BASE}/painel`;
  } catch (err) {
    errorBox.textContent = err.message;
    errorBox.hidden = false;
    document.getElementById('totp').value = '';
    document.getElementById('password').focus();
  } finally {
    button.disabled = false;
    button.classList.remove('is-loading');
  }
});

document.getElementById('username').focus();
