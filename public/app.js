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
  tracking: null,
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
/* ---------------- rastreamento ---------------- */

/**
 * Identificadores de atribuição do Meta.
 *
 * Cookie não atravessa domínio: o snippet da landing carimba `_fbp`, `_fbc`
 * e `_eid` na URL do checkout. Lemos de lá primeiro e guardamos em cookie
 * próprio, para sobreviver ao recarregar a página.
 */
const tracking = (() => {
  const params = new URLSearchParams(location.search);

  const ler = (nome) => {
    const m = document.cookie.match('(^|; )' + nome + '=([^;]*)');
    return m ? decodeURIComponent(m[2]) : null;
  };

  const gravar = (nome, valor) => {
    if (!valor) return;
    document.cookie =
      `${nome}=${encodeURIComponent(valor)};path=/;max-age=${60 * 60 * 24 * 90};SameSite=Lax` +
      (location.protocol === 'https:' ? ';Secure' : '');
  };

  // URL vence cookie: é o dado mais recente, vindo do clique atual.
  const fbp = params.get('_fbp') || ler('_fbp');
  let fbc = params.get('_fbc') || ler('_fbc');

  // Anúncio que aponta direto para o checkout, sem passar pela landing.
  const fbclid = params.get('fbclid');
  if (!fbc && fbclid) fbc = `fb.1.${Date.now()}.${fbclid}`;

  const externalId = params.get('_eid') || ler('_fc_ext');

  gravar('_fbp', fbp);
  gravar('_fbc', fbc);
  gravar('_fc_ext', externalId);

  return {
    fbp,
    fbc,
    fbclid,
    externalId,
    pageUrl: location.href,
    utmSource: params.get('utm_source'),
    utmMedium: params.get('utm_medium'),
    utmCampaign: params.get('utm_campaign'),
    utmContent: params.get('utm_content'),
    utmTerm: params.get('utm_term'),
    // Anuncio que abre WhatsApp e Lead Ads trazem o proprio id de clique.
    ctwaClid: params.get('ctwa_clid'),
    leadId: params.get('lead_id'),
  };
})();

/** Carrega o pixel do navegador só quando o produto tem um configurado. */
let pixelPronto = false;

function initPixel(pixelId) {
  if (pixelPronto || !pixelId || window.fbq) {
    if (window.fbq && !pixelPronto && pixelId) {
      window.fbq('init', pixelId, trackingInitParams());
      pixelPronto = true;
    }
    return;
  }

  /* eslint-disable */
  !(function (f, b, e, v, n, t, s) {
    if (f.fbq) return; n = f.fbq = function () { n.callMethod ? n.callMethod.apply(n, arguments) : n.queue.push(arguments); };
    if (!f._fbq) f._fbq = n; n.push = n; n.loaded = !0; n.version = '2.0'; n.queue = [];
    t = b.createElement(e); t.async = !0; t.src = v;
    s = b.getElementsByTagName(e)[0]; s.parentNode.insertBefore(t, s);
  })(window, document, 'script', 'https://connect.facebook.net/en_US/fbevents.js');
  /* eslint-enable */

  window.fbq('init', pixelId, trackingInitParams());
  window.fbq('track', 'PageView');
  pixelPronto = true;
}

/** Dados de identificação que o navegador já consegue mandar no init. */
function trackingInitParams() {
  const params = {};
  if (tracking.externalId) params.external_id = tracking.externalId;

  const email = $('#email')?.value.trim();
  const phone = onlyDigits($('#phone')?.value || '');
  // O pixel aplica o hash sozinho nestes campos.
  if (email) params.em = email.toLowerCase();
  if (phone) params.ph = phone.startsWith('55') ? phone : `55${phone}`;

  return params;
}

/**
 * Dispara no navegador o mesmo evento que o servidor manda pela Conversions
 * API, com o MESMO eventID. É assim que o Meta entende que é uma conversão
 * só e não conta a venda duas vezes.
 */
function fbTrack(eventName, eventId, custom = {}) {
  if (!window.fbq || !eventId) return;

  window.fbq('track', eventName, {
    currency: 'BRL',
    value: state.product ? state.product.amountCents / 100 : undefined,
    content_ids: state.product ? [state.product.id] : undefined,
    content_name: state.product?.name,
    content_type: 'product',
    ...custom,
  }, { eventID: eventId });
}

/* ---------------- produto e métodos ---------------- */

const METHOD_INFO = {
  pix: {
    name: 'PIX',
    desc: 'Aprovação imediata',
    icon: '<path d="m12 3.6 8.4 8.4-8.4 8.4L3.6 12z"/><path d="M8.2 8.2 12 12l3.8-3.8M8.2 15.8 12 12l3.8 3.8"/>',
  },
  card: {
    name: 'Cartão de Crédito',
    desc: null, // preenchido com o parcelamento do produto
    icon: '<rect x="2.5" y="5" width="19" height="14" rx="2.5"/><path d="M2.5 10h19"/>',
  },
};

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
  $('#brand').textContent = product.name;
  document.title = `${product.name} — Finalizar Compra`;

  if (product.headline) $('#page-title').textContent = product.headline;
  if (product.showSecuritySeal === false) $('#security-seal').hidden = true;

  // Campo de CEP so aparece quando o produto pede.
  $('#zip-field').hidden = !product.askZip;

  $$('[data-price]').forEach((el) => (el.textContent = product.amountFormatted));
  $$('[data-price-inline]').forEach((el) => (el.textContent = product.amountFormatted));

  if (product.pixelId) initPixel(product.pixelId);

  registrarVisita(product.id);
  renderMethods(product);
}

/**
 * Conta a visita — topo do funil.
 * Uma por aba: sessionStorage evita que recarregar a página vire 5 visitas
 * e faça a conversão parecer pior do que é.
 */
function registrarVisita(productId) {
  const chave = `_gc_visit_${productId}`;
  if (sessionStorage.getItem(chave)) return;

  let sessionId = localStorage.getItem('_gc_sid');
  if (!sessionId) {
    sessionId = `s.${Date.now().toString(36)}.${Math.random().toString(36).slice(2, 12)}`;
    localStorage.setItem('_gc_sid', sessionId);
  }

  sessionStorage.setItem(chave, '1');

  fetch('/api/checkout/view', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ productId, sessionId, tracking }),
    keepalive: true,
  }).catch(() => {});
}

/**
 * Monta os métodos habilitados para ESTE produto.
 * Se o produto oferece só PIX, o cartão nem aparece — melhor do que exibir
 * uma opção morta que o comprador tenta clicar.
 */
function renderMethods(product) {
  const enabled = Object.entries(product.methods)
    .filter(([key, on]) => on && METHOD_INFO[key])
    .map(([key]) => key);

  // O cartão só é clicável se algum gateway souber processá-lo.
  const usable = (key) => (key === 'card' ? product.methods.cardSupported === true : true);

  const first = enabled.find(usable) || enabled[0];
  state.method = first;

  const container = $('#methods');
  container.classList.toggle('methods--duo', enabled.length > 1);

  container.innerHTML = enabled
    .map((key) => {
      const info = METHOD_INFO[key];
      const desc = key === 'card' ? `Em até ${product.maxInstallments}x` : info.desc;
      const blocked = !usable(key);

      return `
        <button type="button" role="radio"
                class="method ${key === first ? 'is-selected' : ''} ${blocked ? 'is-disabled' : ''}"
                data-method="${key}"
                aria-checked="${key === first}"
                ${blocked ? 'aria-disabled="true"' : ''}>
          <span class="method__icon">
            <svg viewBox="0 0 24 24" aria-hidden="true">${info.icon}</svg>
          </span>
          <span class="method__body">
            <span class="method__name">${info.name}</span>
            <span class="method__desc">${desc}</span>
          </span>
          <span class="method__price">${product.amountFormatted}</span>
          <span class="method__radio"></span>
          ${blocked ? '<span class="method__tag">Indisponível</span>' : ''}
        </button>`;
    })
    .join('');

  // Mesmo com um método só o bloco fica visível: confirma ao comprador
  // como ele vai pagar, e é o que checkouts de referência fazem.
  updateSubmitLabel();
}

function updateSubmitLabel() {
  $('.submit__label').textContent = state.method === 'pix' ? 'Gerar PIX' : 'Pagar com Cartão';
}

/* ---------------- seleção de método ---------------- */

$('#methods').addEventListener('click', (event) => {
  const button = event.target.closest('.method');
  if (!button) return;

  if (button.classList.contains('is-disabled')) {
    showAlert('Cartão de crédito indisponível no momento. Conclua com PIX — a aprovação é imediata.');
    return;
  }

  $$('.method').forEach((el) => {
    el.classList.toggle('is-selected', el === button);
    el.setAttribute('aria-checked', String(el === button));
  });

  state.method = button.dataset.method;
  updateSubmitLabel();
});

/* ---------------- indicador de etapas ---------------- */

function setStep(current) {
  $$('.steps__item').forEach((item) => {
    const step = Number(item.dataset.step);
    item.classList.toggle('is-current', step === current);
    item.classList.toggle('is-done', step < current);
  });
}

/* ---------------- máscaras ---------------- */

$('#document').addEventListener('input', (e) => {
  e.target.value = maskDocument(e.target.value);
});

/**
 * CEP: máscara e consulta.
 * Mostrar a cidade confirma ao comprador que o campo fez sentido — sem isso
 * um campo a mais no checkout é só atrito.
 */
$('#zip').addEventListener('input', async (e) => {
  const d = onlyDigits(e.target.value).slice(0, 8);
  e.target.value = d.length > 5 ? `${d.slice(0, 5)}-${d.slice(5)}` : d;

  const hint = $('#zip-hint');
  if (d.length !== 8) {
    hint.textContent = '';
    return;
  }

  hint.textContent = 'Buscando…';

  try {
    const res = await fetch(`https://viacep.com.br/ws/${d}/json/`);
    const json = await res.json();
    hint.textContent = json?.erro ? 'CEP não encontrado.' : `${json.localidade} — ${json.uf}`;
    hint.classList.toggle('is-ok', !json?.erro);
  } catch {
    // Sem consulta o pedido segue: o CEP em si já é o sinal principal.
    hint.textContent = '';
  }
});
$('#phone').addEventListener('input', (e) => {
  e.target.value = maskPhone(e.target.value);
});

Object.keys(RULES).forEach((name) => {
  const input = $(`#${name}`);
  input.addEventListener('blur', () => setFieldError(name, RULES[name](input.value)));
  input.addEventListener('input', () => {
    const field = input.closest('.field');
    if (field.classList.contains('has-error')) setFieldError(name, RULES[name](input.value));
    field.classList.toggle('is-valid', input.value.trim() !== '' && !RULES[name](input.value));
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
        zip: onlyDigits($('#zip').value),
        tracking,
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

    // O servidor devolve o pixel do produto e os ids de evento; o mesmo id
    // sai daqui e da Conversions API, e o Meta deduplica.
    if (body.tracking) {
      state.tracking = body.tracking;
      if (body.tracking.pixelId) initPixel(body.tracking.pixelId);
      fbTrack('InitiateCheckout', body.tracking.initiateEventId);
    }

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

  setStep(2);
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
  setStep(1);
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
  const custom = state.product?.success || {};
  const email = $('#email').value.trim();

  // Mesmo eventID que o servidor usou na Conversions API: o Meta junta os
  // dois e conta uma venda só. O servidor dispara de qualquer forma — este
  // aqui é o reforço para quem ficou com a aba aberta.
  if (state.tracking?.purchaseEventId) {
    fbTrack('Purchase', state.tracking.purchaseEventId, { order_id: order.id });
  }

  if (custom.title) $('#done-title').textContent = custom.title;

  if (custom.message) {
    // textContent, nunca innerHTML: o texto vem do painel e um admin
    // comprometido não pode injetar script na tela do comprador.
    // {email}, {pedido} e {valor} são substituídos aqui.
    $('#done-text').textContent = custom.message
      .replaceAll('{email}', email)
      .replaceAll('{pedido}', order.id)
      .replaceAll('{valor}', state.product.amountFormatted);
    $('#done-text').classList.add('done__text--custom');
  } else {
    $('#done-email').textContent = email;
  }

  // O href só é preenchido se o servidor validou como https.
  if (custom.buttonLabel && /^https:\/\//i.test(custom.buttonUrl || '')) {
    const cta = $('#done-cta');
    cta.textContent = custom.buttonLabel;
    cta.href = custom.buttonUrl;
    cta.hidden = false;
  }

  $('#done-order').textContent = order.id;
  setStep(3);
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
