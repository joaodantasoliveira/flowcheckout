/* ==========================================================
   Checkout — lógica de tela
   Nenhuma credencial do gateway passa por aqui: o browser
   só conversa com /api/checkout do nosso próprio servidor.
   ========================================================== */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const state = {
  product: null,
  method: 'pix',
  order: null,
  pollTimer: null,
  tickTimer: null,
};

/* ---------------- utilidades ---------------- */

const onlyDigits = (v) => String(v || '').replace(/\D+/g, '');

const formatBRL = (cents) =>
  (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

function maskDocument(value) {
  const d = onlyDigits(value).slice(0, 14);
  if (d.length <= 11) {
    return d
      .replace(/^(\d{3})(\d)/, '$1.$2')
      .replace(/^(\d{3})\.(\d{3})(\d)/, '$1.$2.$3')
      .replace(/\.(\d{3})(\d{1,2})$/, '.$1-$2');
  }
  return d
    .replace(/^(\d{2})(\d)/, '$1.$2')
    .replace(/^(\d{2})\.(\d{3})(\d)/, '$1.$2.$3')
    .replace(/\.(\d{3})(\d)/, '.$1/$2')
    .replace(/(\d{4})(\d{1,2})$/, '$1-$2');
}

function maskPhone(value) {
  let d = onlyDigits(value);
  if (d.startsWith('55') && d.length > 11) d = d.slice(2);
  d = d.slice(0, 11);

  if (!d) return '';
  if (d.length <= 2) return `+55 (${d}`;
  if (d.length <= 6) return `+55 (${d.slice(0, 2)}) ${d.slice(2)}`;
  if (d.length <= 10) return `+55 (${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`;
  return `+55 (${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
}

function isValidCPF(cpf) {
  const d = onlyDigits(cpf);
  if (d.length !== 11 || /^(\d)\1{10}$/.test(d)) return false;
  const digit = (slice) => {
    let sum = 0;
    for (let i = 0; i < slice; i++) sum += Number(d[i]) * (slice + 1 - i);
    const rest = (sum * 10) % 11;
    return rest === 10 ? 0 : rest;
  };
  return digit(9) === Number(d[9]) && digit(10) === Number(d[10]);
}

function isValidCNPJ(cnpj) {
  const d = onlyDigits(cnpj);
  if (d.length !== 14 || /^(\d)\1{13}$/.test(d)) return false;
  const digit = (len) => {
    let sum = 0;
    let factor = len - 7;
    for (let i = 0; i < len; i++) {
      sum += Number(d[i]) * factor;
      factor = factor === 2 ? 9 : factor - 1;
    }
    const rest = sum % 11;
    return rest < 2 ? 0 : 11 - rest;
  };
  return digit(12) === Number(d[12]) && digit(13) === Number(d[13]);
}

/* ---------------- validação ---------------- */

const RULES = {
  name(v) {
    const value = v.trim().replace(/\s+/g, ' ');
    if (!value) return 'Informe seu nome completo.';
    if (!/^[A-Za-zÀ-ÿ'´`^~]{2,}(\s[A-Za-zÀ-ÿ'´`^~.]{1,}){1,}$/.test(value))
      return 'Informe nome e sobrenome.';
    return '';
  },
  email(v) {
    const value = v.trim();
    if (!value) return 'Informe seu e-mail.';
    if (!/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(value)) return 'E-mail inválido.';
    return '';
  },
  document(v) {
    const d = onlyDigits(v);
    if (!d) return 'Informe seu CPF ou CNPJ.';
    if (d.length === 11) return isValidCPF(d) ? '' : 'CPF inválido.';
    if (d.length === 14) return isValidCNPJ(d) ? '' : 'CNPJ inválido.';
    return 'CPF/CNPJ incompleto.';
  },
  phone(v) {
    let d = onlyDigits(v);
    if (d.startsWith('55') && d.length > 11) d = d.slice(2);
    if (!d) return 'Informe seu telefone.';
    return d.length === 10 || d.length === 11 ? '' : 'Telefone incompleto.';
  },
};

function setFieldError(name, message) {
  const input = $(`#${name}`);
  const holder = input?.closest('.field');
  const slot = $(`[data-error-for="${name}"]`);
  if (!holder || !slot) return;
  holder.classList.toggle('has-error', Boolean(message));
  slot.textContent = message || '';
}

function validateAll() {
  let ok = true;
  for (const [name, rule] of Object.entries(RULES)) {
    const message = rule($(`#${name}`).value);
    setFieldError(name, message);
    if (message) ok = false;
  }
  return ok;
}

/* ---------------- produto ---------------- */

async function loadProduct() {
  const params = new URLSearchParams(location.search);
  const query = params.get('produto') ? `?id=${encodeURIComponent(params.get('produto'))}` : '';

  const res = await fetch(`/api/checkout/product${query}`);
  if (!res.ok) throw new Error('Produto indisponível');

  const product = await res.json();
  state.product = product;

  $('#product-name').textContent = product.name;
  $('#product-sub').textContent = product.subtitle;
  $('#product-img').src = product.image;
  $('#product-img').alt = product.name;
  document.title = `${product.name} — Finalizar Compra`;

  $$('[data-price]').forEach((el) => (el.textContent = product.amountFormatted));
  $$('[data-price-inline]').forEach((el) => (el.textContent = product.amountFormatted));
  $('[data-card-desc]').textContent = `Em até ${product.maxInstallments}x`;

  if (!product.methods.card) {
    const card = $('.method[data-method="card"]');
    card.classList.add('is-disabled');
    card.setAttribute('aria-disabled', 'true');
    card.insertAdjacentHTML('beforeend', '<span class="method__tag">Indisponível</span>');
  }
}

/* ---------------- seleção de método ---------------- */

$$('.method').forEach((btn) => {
  btn.addEventListener('click', () => {
    if (btn.classList.contains('is-disabled')) {
      showAlert('Cartão de crédito indisponível no momento. Conclua com PIX — a aprovação é imediata.');
      return;
    }
    $$('.method').forEach((el) => {
      el.classList.toggle('is-selected', el === btn);
      el.setAttribute('aria-checked', String(el === btn));
    });
    state.method = btn.dataset.method;
    $('.submit__label').textContent = state.method === 'pix' ? 'Gerar PIX' : 'Pagar com Cartão';
  });
});

/* ---------------- máscaras ---------------- */

$('#document').addEventListener('input', (e) => {
  e.target.value = maskDocument(e.target.value);
});
$('#phone').addEventListener('input', (e) => {
  e.target.value = maskPhone(e.target.value);
});

Object.keys(RULES).forEach((name) => {
  const input = $(`#${name}`);
  input.addEventListener('blur', () => setFieldError(name, RULES[name](input.value)));
  input.addEventListener('input', () => {
    if (input.closest('.field').classList.contains('has-error')) {
      setFieldError(name, RULES[name](input.value));
    }
  });
});

/* ---------------- alertas ---------------- */

function showAlert(message) {
  const box = $('#form-alert');
  box.textContent = message;
  box.hidden = false;
}

function clearAlert() {
  $('#form-alert').hidden = true;
}

/* ---------------- envio ---------------- */

$('#checkout-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  clearAlert();

  if (state.method !== 'pix') {
    showAlert('Cartão de crédito indisponível no momento. Conclua com PIX.');
    return;
  }

  if (!validateAll()) {
    $('.field.has-error input')?.focus();
    return;
  }

  const button = $('#submit-btn');
  button.disabled = true;
  button.classList.add('is-loading');
  $('.submit__label').textContent = 'Gerando PIX…';

  try {
    const res = await fetch('/api/checkout/pix', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        productId: state.product.id,
        name: $('#name').value,
        email: $('#email').value,
        document: onlyDigits($('#document').value),
        phone: onlyDigits($('#phone').value),
      }),
    });

    const body = await res.json().catch(() => ({}));

    if (!res.ok) {
      if (body.fields) {
        Object.entries(body.fields).forEach(([field, message]) => setFieldError(field, message));
      }
      throw new Error(body.error || 'Não foi possível gerar o PIX.');
    }

    state.order = body;
    renderPix(body);
  } catch (err) {
    showAlert(err.message);
  } finally {
    button.disabled = false;
    button.classList.remove('is-loading');
    $('.submit__label').textContent = 'Gerar PIX';
  }
});

/* ---------------- tela do PIX ---------------- */

function renderPix(order) {
  const qr = order.pix.qrCodeBase64 || order.pix.qrcodeUrl;
  if (qr) $('#qr-img').src = qr;
  else $('#qr-img').closest('.pix__qr').hidden = true;

  $('#copy-paste').value = order.pix.copyPaste || '';

  $('#step-form').hidden = true;
  $('#step-pix').hidden = false;
  window.scrollTo({ top: 0, behavior: 'smooth' });

  startTimer(order.pix.expiresAt);
  startPolling();
}

$('#copy-btn').addEventListener('click', async () => {
  const field = $('#copy-paste');
  const button = $('#copy-btn');

  try {
    await navigator.clipboard.writeText(field.value);
  } catch {
    field.select();
    document.execCommand('copy');
  }

  button.textContent = 'Código copiado!';
  setTimeout(() => (button.textContent = 'Copiar código PIX'), 2200);
});

$('#back-btn').addEventListener('click', () => {
  stopTimers();
  state.order = null;
  $('#step-pix').hidden = true;
  $('#step-form').hidden = false;
});

/* ---------------- contagem regressiva ---------------- */

function startTimer(expiresAt) {
  clearInterval(state.tickTimer);

  const tick = () => {
    const left = Math.max(0, Math.floor((expiresAt - Date.now()) / 1000));
    const mm = String(Math.floor(left / 60)).padStart(2, '0');
    const ss = String(left % 60).padStart(2, '0');
    $('#timer').textContent = `${mm}:${ss}`;

    if (left === 0) {
      stopTimers();
      const box = $('#pix-status');
      box.classList.add('is-dead');
      $('#pix-status-text').textContent = 'Código expirado. Gere um novo PIX.';
    }
  };

  tick();
  state.tickTimer = setInterval(tick, 1000);
}

/* ---------------- polling de status ---------------- */

function startPolling() {
  clearInterval(state.pollTimer);

  const check = async () => {
    if (!state.order || document.hidden) return;

    try {
      const res = await fetch(`/api/checkout/${state.order.id}/status`);
      if (!res.ok) return;

      const order = await res.json();

      if (order.paid) {
        stopTimers();
        renderSuccess(order);
      } else if (order.status === 'FALHA' || order.status === 'CANCELADO') {
        stopTimers();
        $('#pix-status').classList.add('is-dead');
        $('#pix-status-text').textContent = 'Pagamento não concluído. Gere um novo PIX.';
      }
    } catch {
      /* rede instável — a próxima rodada tenta de novo */
    }
  };

  state.pollTimer = setInterval(check, 4000);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) check();
  });
}

function stopTimers() {
  clearInterval(state.pollTimer);
  clearInterval(state.tickTimer);
  state.pollTimer = null;
  state.tickTimer = null;
}

function renderSuccess(order) {
  $('#done-email').textContent = $('#email').value.trim();
  $('#done-order').textContent = order.id;
  $('#step-pix').hidden = true;
  $('#step-done').hidden = false;
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

$('#copy-order').addEventListener('click', async () => {
  const button = $('#copy-order');

  try {
    await navigator.clipboard.writeText($('#done-order').textContent);
  } catch {
    const range = document.createRange();
    range.selectNode($('#done-order'));
    getSelection().removeAllRanges();
    getSelection().addRange(range);
    document.execCommand('copy');
    getSelection().removeAllRanges();
  }

  button.textContent = 'Copiado!';
  setTimeout(() => (button.textContent = 'Copiar'), 2000);
});

/* ---------------- boot ---------------- */

loadProduct().catch(() => {
  showAlert('Não foi possível carregar os dados do produto. Recarregue a página.');
});
