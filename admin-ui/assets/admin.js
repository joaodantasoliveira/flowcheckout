/* ==========================================================
   Painel administrativo
   O prefixo secreto sai da URL — nada fica hardcoded no arquivo.
   ========================================================== */

const BASE = location.pathname.replace(/\/(painel)?\/?$/, '');
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const state = { csrf: null, view: 'overview', ordersPage: 1, products: [], days: 14, campDays: 14 };

/* ---------------- utilidades ---------------- */

const brl = (cents) =>
  (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

const dateTime = (value) =>
  new Date(value).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });

/** Toda inserção de dado vindo do servidor passa por aqui (defesa contra XSS). */
const esc = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
  );

function toast(message, isError = false) {
  const box = $('#toast');
  box.textContent = message;
  box.classList.toggle('toast--err', isError);
  box.hidden = false;
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => (box.hidden = true), 3800);
}

/** Centavos a partir de "R$ 1.234,56" ou "1234,56" ou "1234.56". */
function parseCents(input) {
  const raw = String(input).replace(/[^\d,.-]/g, '').trim();
  if (!raw) return NaN;

  const normalized = raw.includes(',')
    ? raw.replace(/\./g, '').replace(',', '.')
    : raw;

  const value = Number(normalized);
  return Number.isFinite(value) ? Math.round(value * 100) : NaN;
}

/* ---------------- camada de rede ---------------- */

async function api(pathname, { method = 'GET', body } = {}) {
  const res = await fetch(`${BASE}/api${pathname}`, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(state.csrf ? { 'X-CSRF-Token': state.csrf } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  // Sessão caiu (expirou, IP mudou, servidor reiniciou): volta pro login.
  if (res.status === 401) {
    location.href = `${BASE}/`;
    throw new Error('Sessão expirada.');
  }

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || 'Falha na operação.');
    err.fields = data.fields;
    throw err;
  }
  return data;
}


/* ---------------- sidebar ---------------- */

function openSide() {
  $('#side').classList.add('is-open');
  $('#side-scrim').hidden = false;
}

function closeSide() {
  $('#side').classList.remove('is-open');
  $('#side-scrim').hidden = true;
}

$('#side-toggle').addEventListener('click', openSide);
$('#side-scrim').addEventListener('click', closeSide);

/* ---------------- navegação ---------------- */

$('#tabs').addEventListener('click', (event) => {
  const tab = event.target.closest('.tab');
  if (!tab) return;
  showView(tab.dataset.view);
});

const VIEW_TITLES = {
  'overview': 'Visão geral',
  'products': 'Produtos',
  'orders': 'Vendas',
  'campaigns': 'Campanhas',
  'settings': 'Configurações',
  'pixels': 'Rastreamento',
  'audit': 'Auditoria'
};

function showView(view) {
  state.view = view;
  $('#view-title').textContent = VIEW_TITLES[view] || 'Painel';
  closeSide();
  $$('.tab').forEach((t) => t.classList.toggle('is-active', t.dataset.view === view));
  $$('.view').forEach((v) => v.classList.toggle('is-active', v.dataset.view === view));

  if (view === 'overview') loadOverview();
  if (view === 'products') loadProducts();
  if (view === 'orders') loadOrders();
  if (view === 'campaigns') loadCampaigns();
  if (view === 'settings') loadGateways();
  if (view === 'pixels') loadPixels();
  if (view === 'audit') loadAudit();
}

$('#logout-btn').addEventListener('click', async () => {
  try {
    await api('/logout', { method: 'POST' });
  } finally {
    location.href = `${BASE}/`;
  }
});

/* ---------------- visão geral ---------------- */

/** Seta de variação: verde para cima, vermelho para baixo, cinza em zero. */
function deltaTag(value, suffix = '') {
  if (value === 0) return '<span class="delta delta--flat">estável</span>';
  const up = value > 0;
  return `<span class="delta delta--${up ? 'up' : 'down'}">
            ${up ? '▲' : '▼'} ${Math.abs(value)}%${suffix}
          </span>`;
}

function humanMinutes(min) {
  if (min === null || min === undefined) return '—';
  if (min < 1) return 'menos de 1 min';
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h}h ${m}min` : `${h}h`;
}

async function loadOverview() {
  const data = await api(`/overview?days=${state.days}`);
  const { totals, window: win, daily, topProducts, recent, funnel, hourly, gateways } = data;

  $('#chart-total').textContent = `${win.formatted} · ${win.count} ${win.count === 1 ? 'venda' : 'vendas'}`;

  $('#stats').innerHTML = `
    <div class="stat">
      <p class="stat__label">Receita no período</p>
      <p class="stat__value stat__value--green">${esc(win.formatted)}</p>
      <p class="stat__hint">${deltaTag(win.deltaCents)} vs. período anterior</p>
    </div>
    <div class="stat">
      <p class="stat__label">Vendas</p>
      <p class="stat__value">${win.count}</p>
      <p class="stat__hint">${deltaTag(win.deltaCount)} · ${totals.salesCount} no total</p>
    </div>
    <div class="stat">
      <p class="stat__label">Ticket médio</p>
      <p class="stat__value">${esc(totals.averageTicketFormatted)}</p>
      <p class="stat__hint">por venda concluída</p>
    </div>
    <div class="stat">
      <p class="stat__label">Conversão</p>
      <p class="stat__value">${totals.conversionRate}%</p>
      <p class="stat__hint">de ${totals.ordersCount} checkouts iniciados</p>
    </div>
    <div class="stat">
      <p class="stat__label">Tempo até pagar</p>
      <p class="stat__value">${esc(humanMinutes(totals.medianMinutesToPay))}</p>
      <p class="stat__hint">mediana entre gerar o PIX e pagar</p>
    </div>
    <div class="stat">
      <p class="stat__label">Aguardando pagamento</p>
      <p class="stat__value" style="color:var(--warn)">${esc(totals.pendingFormatted)}</p>
      <p class="stat__hint">${totals.pendingCount} PIX em aberto</p>
    </div>
    ${
      totals.infractionCount
        ? `<div class="stat">
             <p class="stat__label">Contestações (MED)</p>
             <p class="stat__value" style="color:var(--danger)">${totals.infractionCount}</p>
             <p class="stat__hint">exigem defesa</p>
           </div>`
        : ''
    }
  `;

  renderWaveChart(daily);
  renderFunnel(funnel, gateways);
  renderHours(hourly);

  $('#top-products').innerHTML = topProducts.length
    ? topProducts
        .map((p, i, arr) => {
          const share = Math.max(6, Math.round((p.cents / arr[0].cents) * 100));
          return `<div class="ranked__row">
                    <div style="flex:1;min-width:0">
                      <div class="ranked__name">${esc(p.name)}</div>
                      <div class="ranked__meta">${p.count} ${p.count === 1 ? 'venda' : 'vendas'}</div>
                      <div class="ranked__bar" style="width:${share}%"></div>
                    </div>
                    <div class="ranked__value">${esc(brl(p.cents))}</div>
                  </div>`;
        })
        .join('')
    : '<div class="empty">Nenhuma venda registrada ainda.</div>';

  renderOrderTable($('#recent-table'), recent, { compact: true });
}

/**
 * Funil de checkout. Mostra onde o comprador desiste — a maior perda
 * costuma ser entre gerar o PIX e efetivamente pagar.
 */
function renderFunnel(steps, gateways) {
  const topo = Math.max(1, steps[0].value);

  /* ---- geometria: triângulo invertido completo ----
     A largura é fixa e afunila do topo até a ponta, independente dos
     valores. Largura proporcional ao dado deixaria a última faixa
     invisível quando a conversão é baixa — justamente o caso em que
     você mais precisa olhar. O número dentro carrega o dado. */
  const W = 300;
  const H = 58;
  const GAP = 4;
  const TOPO = 100;
  const PONTA = 16;

  const larguraEm = (i) => TOPO - ((TOPO - PONTA) / steps.length) * i;

  /* Do mais claro no topo ao mais escuro na base: a venda é o fundo do
     funil, e o tom mais fechado dá peso a ela. */
  const TONS = [
    { fundo: '#E5E1EE', texto: '#2B303A' },
    { fundo: '#D2D68D', texto: '#2B303A' },
    { fundo: '#4FBF83', texto: '#12301F' },
    { fundo: '#157145', texto: '#E5E1EE' },
  ];

  const tomDe = (i) => TONS[Math.min(i, TONS.length - 1)];

  const trapezios = steps
    .map((s, i) => {
      const topoL = (larguraEm(i) / 100) * W;
      const baseL = (larguraEm(i + 1) / 100) * W;
      const y = i * (H + GAP);
      const tom = tomDe(i);

      const x1 = (W - topoL) / 2;
      const x2 = (W + topoL) / 2;
      const x3 = (W + baseL) / 2;
      const x4 = (W - baseL) / 2;

      return `
        <polygon points="${x1},${y} ${x2},${y} ${x3},${y + H} ${x4},${y + H}"
                 fill="${tom.fundo}" class="funil__seg" style="--d:${i * 0.08}s" />
        <text x="${W / 2}" y="${y + H / 2 - 2}" class="funil__num"
              fill="${tom.texto}">${s.value}</text>
        <text x="${W / 2}" y="${y + H / 2 + 15}" class="funil__cap"
              fill="${tom.texto}" opacity=".8">${esc(s.label)}</text>`;
    })
    .join('');

  const gradientes = '';
  const alturaTotal = steps.length * (H + GAP);

  const perdas = steps
    .map((s, i) => {
      if (i === 0) return '';
      const anterior = steps[i - 1].value;
      const queda = anterior && anterior > s.value
        ? Math.round(((anterior - s.value) / anterior) * 100)
        : 0;
      if (!queda) return '';
      return `<div class="funil__perda">
                <span>${esc(steps[i - 1].label)} → ${esc(s.label)}</span>
                <span class="funil__drop">−${queda}%</span>
              </div>`;
    })
    .join('');

  const linhas = `
    <svg class="funil" viewBox="0 0 ${W} ${alturaTotal}" role="img"
         aria-label="Funil do checkout">
      <defs>${gradientes}</defs>
      ${trapezios}
    </svg>
    ${perdas ? `<div class="funil__perdas">${perdas}</div>` : ''}`;

  const porGateway = gateways.length
    ? `<div class="funnel__gw">
         ${gateways
           .map((g) => {
             const taxa = g.total ? Math.round((g.pagos / g.total) * 100) : 0;
             return `<div class="funnel__gw-row">
                       <span>${esc(g.gateway)}</span>
                       <span class="funnel__gw-num">${g.pagos}/${g.total} · ${taxa}%</span>
                     </div>`;
           })
           .join('')}
       </div>`
    : '';

  $('#funnel').innerHTML = linhas + porGateway;
}

/** Vendas por hora do dia — mostra quando vale concentrar anúncio. */
function renderHours(hourly) {
  const peak = Math.max(1, ...hourly.map((h) => h.cents));
  const total = hourly.reduce((t, h) => t + h.count, 0);

  if (!total) {
    $('#hours').innerHTML = '<div class="empty">Sem vendas no período.</div>';
    return;
  }

  $('#hours').innerHTML = `
    <div class="hours__grid">
      ${hourly
        .map((h) => {
          const intensidade = h.cents / peak;
          const label = String(h.hour).padStart(2, '0');
          return `<div class="hours__cell" style="--i:${intensidade.toFixed(3)}"
                       title="${label}h — ${esc(brl(h.cents))} (${h.count})">
                    <span>${label}</span>
                  </div>`;
        })
        .join('')}
    </div>
    <p class="hours__legend">
      <span>00h</span>
      <span class="hours__scale"></span>
      <span>23h</span>
    </p>`;
}

/* ---------------- seletor de período ---------------- */

$('#range').addEventListener('click', (event) => {
  const button = event.target.closest('[data-days]');
  if (!button) return;

  state.days = Number(button.dataset.days);
  $$('#range .range__btn').forEach((b) => b.classList.toggle('is-on', b === button));
  loadOverview();
});


/* ---------------- gráfico de onda ---------------- */

/**
 * Curva suave passando pelos pontos (Catmull-Rom convertido para Bézier
 * cúbica). Um polyline reto ficaria anguloso; a tensão baixa evita que a
 * curva "estoure" acima do topo quando um dia destoa dos vizinhos.
 */
function smoothPath(points, tension = 0.22) {
  if (points.length < 2) return '';

  let d = `M ${points[0].x} ${points[0].y}`;

  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[i - 1] || points[i];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[i + 2] || p2;

    d +=
      ` C ${p1.x + (p2.x - p0.x) * tension} ${p1.y + (p2.y - p0.y) * tension},` +
      ` ${p2.x - (p3.x - p1.x) * tension} ${p2.y - (p3.y - p1.y) * tension},` +
      ` ${p2.x} ${p2.y}`;
  }

  return d;
}

function renderWaveChart(daily) {
  const host = $('#chart');
  const W = 760;
  const H = 210;
  const padY = 26;

  const peak = Math.max(1, ...daily.map((d) => d.cents));
  const step = daily.length > 1 ? W / (daily.length - 1) : W;

  const points = daily.map((d, i) => ({
    x: i * step,
    y: H - padY - (d.cents / peak) * (H - padY * 2),
    ...d,
  }));

  const line = smoothPath(points);
  const area = `${line} L ${W} ${H} L 0 ${H} Z`;

  const grid = [0, 0.25, 0.5, 0.75, 1]
    .map((t) => {
      const y = padY + t * (H - padY * 2);
      return `<line x1="0" y1="${y}" x2="${W}" y2="${y}" />`;
    })
    .join('');

  // Rótulo a cada 2 dias: 14 datas seguidas viram borrão.
  const labels = points
    .map((p, i) => (i % 2 === 0 ? `<text class="chart__label" x="${p.x}" y="${H + 14}">${p.date.slice(8)}</text>` : ''))
    .join('');

  const hits = points
    .map(
      (p, i) => `
      <rect class="chart__hit" x="${p.x - step / 2}" y="0" width="${step}" height="${H}"
            data-i="${i}"></rect>
      <circle class="chart__dot" cx="${p.x}" cy="${p.y}" r="4.5"></circle>`
    )
    .join('');

  host.innerHTML = `
    <svg viewBox="0 -6 ${W} ${H + 26}" preserveAspectRatio="none" role="img"
         aria-label="Receita dos últimos 14 dias">
      <defs>
        <linearGradient id="waveFill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%"   stop-color="#1fa564" stop-opacity=".55"/>
          <stop offset="55%"  stop-color="#D2D68D" stop-opacity=".14"/>
          <stop offset="100%" stop-color="#1fa564" stop-opacity="0"/>
        </linearGradient>
        <linearGradient id="waveStroke" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%"   stop-color="#1fa564"/>
          <stop offset="55%"  stop-color="#D2D68D"/>
          <stop offset="100%" stop-color="#7ff0b6"/>
        </linearGradient>
      </defs>

      <g class="chart__grid">${grid}</g>
      <path class="chart__area" d="${area}" fill="url(#waveFill)"></path>
      <path class="chart__line" d="${line}"></path>
      ${labels}
      ${hits}
    </svg>
    <div class="chart__tip" id="chart-tip"></div>
  `;

  // Tooltip seguindo o ponto mais próximo.
  const tip = $('#chart-tip');
  const svg = host.querySelector('svg');

  host.querySelectorAll('.chart__hit').forEach((hit) => {
    hit.addEventListener('mouseenter', () => {
      const p = points[Number(hit.dataset.i)];
      const box = svg.getBoundingClientRect();
      const hostBox = host.getBoundingClientRect();

      tip.innerHTML = `<b>${esc(brl(p.cents))}</b> · ${p.count} ${p.count === 1 ? 'venda' : 'vendas'}<br>${esc(
        new Date(p.date + 'T12:00:00').toLocaleDateString('pt-BR', { day: '2-digit', month: 'short' })
      )}`;
      tip.style.left = `${box.left - hostBox.left + (p.x / W) * box.width}px`;
      tip.style.top = `${box.top - hostBox.top + (p.y / (H + 20)) * box.height}px`;
      tip.classList.add('is-on');
    });

    hit.addEventListener('mouseleave', () => tip.classList.remove('is-on'));
  });
}

/* ---------------- produtos ---------------- */

async function loadProducts() {
  const products = await api('/products');
  state.products = products;

  const table = $('#products-table');

  if (!products.length) {
    table.innerHTML = '<tbody><tr><td><div class="empty">Nenhum produto cadastrado.</div></td></tr></tbody>';
    return;
  }

  table.innerHTML = `
    <thead>
      <tr>
        <th>Produto</th><th>Preço</th><th>Status</th>
        <th>Vendas</th><th>Receita</th><th>Link do checkout</th><th></th>
      </tr>
    </thead>
    <tbody>
      ${products
        .map(
          (p) => `<tr>
            <td>
              <div>${esc(p.name)}</div>
              <div class="mono">${esc(p.id)}</div>
            </td>
            <td class="num">${esc(p.priceFormatted)}</td>
            <td><span class="pill pill--${p.active ? 'on' : 'off'}">${p.active ? 'Ativo' : 'Inativo'}</span></td>
            <td class="num">${p.salesCount}</td>
            <td class="num">${esc(brl(p.revenueCents))}</td>
            <td><button class="btn btn--ghost btn--mini" data-copy="${esc(p.checkoutUrl)}">Copiar link</button></td>
            <td>
              <div class="actions">
                <button class="btn btn--ghost btn--mini" data-utm="${esc(p.id)}">UTM do anúncio</button>
                <button class="btn btn--ghost btn--mini" data-edit="${esc(p.id)}">Editar</button>
                <button class="btn btn--danger btn--mini" data-del="${esc(p.id)}">Excluir</button>
              </div>
            </td>
          </tr>`
        )
        .join('')}
    </tbody>
  `;
}

$('#products-table').addEventListener('click', async (event) => {
  const copy = event.target.closest('[data-copy]');
  if (copy) {
    const url = new URL(copy.dataset.copy, location.origin).href;
    await navigator.clipboard.writeText(url).catch(() => {});
    toast('Link copiado: ' + url);
    return;
  }

  const utm = event.target.closest('[data-utm]');
  if (utm) return openUtmModal(state.products.find((p) => p.id === utm.dataset.utm));

  const edit = event.target.closest('[data-edit]');
  if (edit) return openProductModal(state.products.find((p) => p.id === edit.dataset.edit));

  const del = event.target.closest('[data-del]');
  if (del) {
    const product = state.products.find((p) => p.id === del.dataset.del);
    if (!confirm(`Excluir "${product.name}"?\n\nSe houver vendas registradas, ele será apenas desativado para preservar o histórico.`)) return;

    try {
      const result = await api(`/products/${encodeURIComponent(product.id)}`, { method: 'DELETE' });
      toast(result.message);
      loadProducts();
    } catch (err) {
      toast(err.message, true);
    }
  }
});


/* ---------------- UTM por produto ---------------- */

/** Parâmetros que o Meta substitui pelo nome real no clique. */
const META_PARAMS =
  'utm_source=facebook' +
  '&utm_medium={{adset.name}}' +
  '&utm_campaign={{campaign.name}}' +
  '&utm_content={{ad.name}}' +
  '&utm_term={{placement}}';

function openUtmModal(product) {
  if (!product) return;

  const base = `${location.origin}/?produto=${encodeURIComponent(product.id)}`;

  $('#utm-title').textContent = `Rastreamento · ${product.name}`;
  $('#utm-params').value = META_PARAMS;
  $('#utm-link').value = base;
  $('#utm-direct').value = `${base}&${META_PARAMS}`;

  $('#utm-modal').hidden = false;
}

$('#utm-modal').addEventListener('click', async (event) => {
  const button = event.target.closest('[data-copy-utm]');
  if (!button) return;

  const campo = $(`#${button.dataset.copyUtm}`);
  try {
    await navigator.clipboard.writeText(campo.value);
  } catch {
    campo.select();
    document.execCommand('copy');
  }

  const texto = button.textContent;
  button.textContent = 'Copiado!';
  setTimeout(() => (button.textContent = texto), 2000);
});

/** Preenche o seletor de pixel do produto. */
async function populatePixelSelect(selectedId) {
  const select = $('#p-pixel');
  if (!select) return;

  select.innerHTML = '<option value="">Sem rastreamento</option>';

  try {
    if (!pixelsState.pixels.length) {
      const data = await api('/pixels');
      pixelsState = data;
    }
    for (const p of pixelsState.pixels.filter((x) => x.active)) {
      const opt = document.createElement('option');
      opt.value = p.id;
      opt.textContent = p.hasToken ? p.name : p.name + ' (sem token da CAPI)';
      select.appendChild(opt);
    }
    select.value = selectedId || '';
  } catch {
    // Migração 006 ainda não rodou: o produto salva sem rastreamento.
  }
}

/* ---------------- modal de produto ---------------- */

function openProductModal(product = null) {
  $('#product-modal-title').textContent = product ? 'Editar produto' : 'Novo produto';
  $('#p-id').value = product?.id || '';
  $('#p-name').value = product?.name || '';
  $('#p-subtitle').value = product?.subtitle || '';
  $('#p-price').value = product ? brl(product.priceCents) : '';
  $('#p-installments').value = product?.maxInstallments || 1;
  $('#p-image').value = product?.image || '';
  $('#p-active').checked = product ? product.active : true;

  // Lista de pixels para o produto escolher. Carrega sob demanda: a aba
  // de rastreamento pode nunca ter sido aberta nesta sessão.
  populatePixelSelect(product?.pixelId);

  const checkout = product?.checkout || {};
  const methods = checkout.methods || {};
  $('#p-method-pix').checked = methods.pix !== false;
  $('#p-method-card').checked = methods.card === true;
  $('#p-headline').value = checkout.headline || '';
  $('#p-seal').checked = checkout.showSecuritySeal !== false;
  $('#p-ask-zip').checked = checkout.askZip === true;
  $('#card-warning').hidden = !$('#p-method-card').checked;

  const success = product?.success || {};
  $('#p-success-title').value = success.title || '';
  $('#p-success-message').value = success.message || '';
  $('#p-success-btn-label').value = success.buttonLabel || '';
  $('#p-success-btn-url').value = success.buttonUrl || '';

  $('#product-error').hidden = true;

  $('#product-modal').hidden = false;
  $('#p-name').focus();
}

$('#new-product-btn').addEventListener('click', () => openProductModal());

$('#p-method-card').addEventListener('change', (e) => {
  $('#card-warning').hidden = !e.target.checked;
});

// Desmarcar as duas deixaria o produto sem como ser pago.
$('#product-form').addEventListener('change', (event) => {
  if (!event.target.matches('#p-method-pix, #p-method-card')) return;

  if (!$('#p-method-pix').checked && !$('#p-method-card').checked) {
    event.target.checked = true;
    toast('Mantenha ao menos uma forma de pagamento ativa.', true);
  }
});

$('#p-price').addEventListener('blur', (e) => {
  const cents = parseCents(e.target.value);
  if (Number.isFinite(cents)) e.target.value = brl(cents);
});

$('#product-form').addEventListener('submit', async (event) => {
  event.preventDefault();

  const errorBox = $('#product-error');
  errorBox.hidden = true;

  const cents = parseCents($('#p-price').value);
  if (!Number.isFinite(cents)) {
    errorBox.textContent = 'Preço inválido.';
    errorBox.hidden = false;
    return;
  }

  const payload = {
    name: $('#p-name').value,
    subtitle: $('#p-subtitle').value,
    priceCents: cents,
    maxInstallments: Number($('#p-installments').value) || 1,
    image: $('#p-image').value,
    active: $('#p-active').checked,
    pixelId: $('#p-pixel').value || null,
    checkout: {
      methods: {
        pix: $('#p-method-pix').checked,
        card: $('#p-method-card').checked,
      },
      headline: $('#p-headline').value,
      showSecuritySeal: $('#p-seal').checked,
      askZip: $('#p-ask-zip').checked,
    },
    success: {
      title: $('#p-success-title').value,
      message: $('#p-success-message').value,
      buttonLabel: $('#p-success-btn-label').value,
      buttonUrl: $('#p-success-btn-url').value,
    },
  };

  const id = $('#p-id').value;
  const save = $('#product-save');
  save.disabled = true;

  try {
    if (id) {
      await api(`/products/${encodeURIComponent(id)}`, { method: 'PATCH', body: payload });
      toast('Produto atualizado.');
    } else {
      await api('/products', { method: 'POST', body: payload });
      toast('Produto criado.');
    }
    closeModals();
    loadProducts();
  } catch (err) {
    errorBox.textContent = err.fields ? Object.values(err.fields).join(' ') : err.message;
    errorBox.hidden = false;
  } finally {
    save.disabled = false;
  }
});

/* ---------------- vendas ---------------- */

let searchTimer = null;

$('#order-search').addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    state.ordersPage = 1;
    loadOrders();
  }, 320);
});

$('#order-status').addEventListener('change', () => {
  state.ordersPage = 1;
  loadOrders();
});

$('#export-btn').addEventListener('click', () => {
  // Download direto: o cookie de sessão acompanha a navegação.
  location.href = `${BASE}/api/orders/export/csv`;
});

async function loadOrders() {
  const params = new URLSearchParams({
    page: state.ordersPage,
    status: $('#order-status').value,
    q: $('#order-search').value.trim(),
  });

  const { data, pagination } = await api(`/orders?${params}`);
  renderOrderTable($('#orders-table'), data);

  $('#orders-pager').innerHTML = `
    <span>${pagination.total} ${pagination.total === 1 ? 'pedido' : 'pedidos'} · página ${pagination.page} de ${pagination.totalPages}</span>
    <div class="pager__nav">
      <button class="btn btn--ghost btn--mini" data-page="prev" ${pagination.page <= 1 ? 'disabled' : ''}>Anterior</button>
      <button class="btn btn--ghost btn--mini" data-page="next" ${pagination.page >= pagination.totalPages ? 'disabled' : ''}>Próxima</button>
    </div>
  `;
}

$('#orders-pager').addEventListener('click', (event) => {
  const button = event.target.closest('[data-page]');
  if (!button) return;
  state.ordersPage += button.dataset.page === 'next' ? 1 : -1;
  loadOrders();
});

function renderOrderTable(table, orders, { compact = false } = {}) {
  if (!orders.length) {
    table.innerHTML = '<tbody><tr><td><div class="empty">Nenhum pedido encontrado.</div></td></tr></tbody>';
    return;
  }

  table.innerHTML = `
    <thead>
      <tr>
        <th>Data</th><th>Cliente</th><th>Produto</th>
        <th>Valor</th><th>Status</th>${compact ? '' : '<th></th>'}
      </tr>
    </thead>
    <tbody>
      ${orders
        .map(
          (o) => `<tr>
            <td class="num">${esc(dateTime(o.createdAt))}</td>
            <td>
              <div>${esc(o.customer.name)}</div>
              <div class="mono">${esc(o.customer.email)}</div>
            </td>
            <td>${esc(o.productName)}</td>
            <td class="num">${esc(o.amountFormatted)}</td>
            <td>
              <span class="pill pill--${esc(o.status)}">${esc(o.status)}</span>
              ${o.infraction ? '<span class="pill pill--med">MED</span>' : ''}
            </td>
            ${compact ? '' : `<td><div class="actions"><button class="btn btn--ghost btn--mini" data-order="${esc(o.id)}">Detalhes</button></div></td>`}
          </tr>`
        )
        .join('')}
    </tbody>
  `;
}

$('#orders-table').addEventListener('click', (event) => {
  const button = event.target.closest('[data-order]');
  if (button) openOrderModal(button.dataset.order);
});

/* ---------------- modal de pedido ---------------- */

async function openOrderModal(orderId) {
  const order = await api(`/orders/${encodeURIComponent(orderId)}`);
  renderOrderDetail(order);
  $('#order-modal').hidden = false;
}

function renderOrderDetail(order) {
  $('#order-detail').innerHTML = `
    <dl class="dl">
      <dt>Pedido</dt><dd class="mono">${esc(order.id)}</dd>
      <dt>Data</dt><dd>${esc(dateTime(order.createdAt))}</dd>
      <dt>Produto</dt><dd>${esc(order.productName)}</dd>
      <dt>Valor</dt><dd>${esc(order.amountFormatted)}</dd>
      <dt>Status</dt><dd><span class="pill pill--${esc(order.status)}">${esc(order.status)}</span></dd>
      ${order.paidAt ? `<dt>Pago em</dt><dd>${esc(dateTime(order.paidAt))}</dd>` : ''}
      <dt>Nome</dt><dd>${esc(order.customer.name)}</dd>
      <dt>E-mail</dt><dd>${esc(order.customer.email)}</dd>
      <dt>CPF/CNPJ</dt><dd>${esc(order.customer.document)}</dd>
      <dt>Telefone</dt><dd>${esc(order.customer.phone)}</dd>
      ${order.endToEndId ? `<dt>E2E</dt><dd class="mono">${esc(order.endToEndId)}</dd>` : ''}
      ${order.gatewayTransactionId ? `<dt>Transação</dt><dd class="mono">${esc(order.gatewayTransactionId)}</dd>` : ''}
      ${
        order.infraction
          ? `<dt>Contestação</dt><dd><span class="pill pill--med">${esc(order.infraction.status)}</span> ${esc(order.infraction.type || '')}</dd>`
          : ''
      }
    </dl>

    ${
      order.masked
        ? `<p class="reveal-note">Dados pessoais mascarados. Exibir os valores completos fica registrado na auditoria.</p>`
        : ''
    }

    <div class="modal__actions">
      ${order.masked ? `<button class="btn btn--ghost" data-reveal="${esc(order.id)}">Exibir dados completos</button>` : ''}
      ${!order.paid ? `<button class="btn btn--ghost" data-recheck="${esc(order.id)}">Reconsultar no gateway</button>` : ''}
    </div>
  `;
}

$('#order-detail').addEventListener('click', async (event) => {
  const reveal = event.target.closest('[data-reveal]');
  if (reveal) {
    try {
      renderOrderDetail(await api(`/orders/${encodeURIComponent(reveal.dataset.reveal)}/reveal`, { method: 'POST' }));
      toast('Exibição registrada na auditoria.');
    } catch (err) {
      toast(err.message, true);
    }
    return;
  }

  const recheck = event.target.closest('[data-recheck]');
  if (recheck) {
    recheck.disabled = true;
    try {
      const order = await api(`/orders/${encodeURIComponent(recheck.dataset.recheck)}/recheck`, { method: 'POST' });
      renderOrderDetail(order);
      toast(order.paid ? 'Pagamento confirmado!' : `Status no gateway: ${order.status}`);
      loadOrders();
    } catch (err) {
      toast(err.message, true);
    }
  }
});
/* ---------------- gateways de pagamento ---------------- */

let gatewaysState = null;

async function loadGateways() {
  const status = await api('/gateways');
  gatewaysState = status;

  /* ---- aviso de ambiente ---- */
  const warning = $('#gw-warning');
  if (!status.schemaReady) {
    warning.textContent =
      'O banco ainda não tem a tabela de configurações. Rode supabase/migrations/002-settings.sql ' +
      'e 003-gateways.sql no SQL Editor do Supabase.';
    warning.hidden = false;
  } else if (!status.encryptionReady) {
    warning.textContent =
      'APP_ENCRYPTION_KEY não está configurada no servidor. Sem ela os segredos seriam gravados ' +
      'em texto claro, então salvar credenciais fica bloqueado. Gere com "npm run gen:key" e ' +
      'cadastre nas variáveis de ambiente.';
    warning.hidden = false;
  } else {
    warning.hidden = true;
  }

  $('#gw-enc').textContent = status.encryptionReady
    ? 'Ativa — segredos gravados cifrados (AES-256-GCM), chave fora do banco'
    : 'INATIVA — configure APP_ENCRYPTION_KEY';

  /* ---- seletor de gateway ativo ---- */
  $('#gw-picker').innerHTML = status.gateways
    .map((g) => {
      const badge = g.active
        ? '<span class="gw-badge gw-badge--live">Em uso</span>'
        : g.configured
          ? '<span class="gw-badge gw-badge--on">Pronto</span>'
          : '<span class="gw-badge gw-badge--off">Sem credenciais</span>';

      return `<button type="button" class="gw-option ${g.active ? 'is-active' : ''}"
                      data-activate="${esc(g.id)}"
                      ${g.active || !g.configured ? 'disabled' : ''}>
                <span class="gw-option__name">${esc(g.label)}</span>
                <span class="gw-option__state">${
                  g.active
                    ? 'Processando as novas cobranças'
                    : g.configured
                      ? 'Clique para ativar'
                      : 'Cadastre as credenciais abaixo'
                }</span>
                ${badge}
              </button>`;
    })
    .join('');

  /* ---- um formulário por gateway ---- */
  $('#gw-cards').innerHTML = status.gateways
    .map(
      (g) => `
      <div class="panel">
        <div class="panel__head">
          <h2 class="panel__title">Credenciais · ${esc(g.label)}</h2>
          <span class="pill pill--${g.configured ? 'on' : 'off'}">${
            g.configured ? 'Configurado' : 'Não configurado'
          }</span>
        </div>
        <div class="form-panel">
          <form data-gateway="${esc(g.id)}" autocomplete="off">
            ${g.fields
              .map(
                (f) => `
              <label class="lbl" for="gwf-${esc(g.id)}-${esc(f.key)}">
                ${esc(f.label)}${f.hint ? ` <code>${esc(f.hint)}</code>` : ''}
              </label>
              <input class="inp" id="gwf-${esc(g.id)}-${esc(f.key)}"
                     data-field="${esc(f.key)}"
                     type="${f.secret ? 'password' : 'text'}"
                     spellcheck="false"
                     autocomplete="${f.secret ? 'new-password' : 'off'}"
                     value="${esc(f.value || '')}"
                     placeholder="${
                       f.secret && f.configured ? '•••••••••••••• (mantém o atual)' : ''
                     }" />
              ${
                f.secret
                  ? `<p class="hint">${
                      f.configured
                        ? 'Já existe um segredo salvo. Deixe em branco para mantê-lo.'
                        : 'Nenhum segredo salvo ainda.'
                    }</p>`
                  : ''
              }`
              )
              .join('')}

            <p class="modal__error" data-error hidden></p>
            <p class="ok-box" data-ok hidden></p>

            <div class="form-actions">
              <button type="button" class="btn btn--ghost" data-test>Testar conexão</button>
              <button type="submit" class="btn" data-save ${
                status.encryptionReady ? '' : 'disabled'
              }>Salvar credenciais</button>
            </div>
          </form>

          <hr class="rule" />
          <dl class="dl">
            <dt>Webhook</dt>
            <dd class="mono">/api/webhooks/${esc(g.id)}/&lt;token&gt;</dd>
            <dt>Última alteração</dt>
            <dd>${g.updatedAt ? esc(dateTime(g.updatedAt)) : '—'}</dd>
          </dl>
        </div>
      </div>`
    )
    .join('');
}

/* ---- trocar o gateway ativo ---- */

$('#gw-picker').addEventListener('click', async (event) => {
  const button = event.target.closest('[data-activate]');
  if (!button) return;

  const gateway = gatewaysState.gateways.find((g) => g.id === button.dataset.activate);
  if (!confirm(`Passar a processar as novas cobranças pela ${gateway.label}?`)) return;

  button.disabled = true;
  try {
    await api('/gateways/active', { method: 'PUT', body: { gateway: gateway.id } });
    toast(`${gateway.label} agora é o gateway ativo.`);
    await loadGateways();
  } catch (err) {
    toast(err.message, true);
    button.disabled = false;
  }
});

/* ---- testar e salvar credenciais ---- */

function readFields(form) {
  const values = {};
  form.querySelectorAll('[data-field]').forEach((input) => {
    values[input.dataset.field] = input.value.trim();
  });
  return values;
}

function showResult(form, account) {
  const box = form.querySelector('[data-ok]');
  const saldo =
    account.availableBalance !== null && account.availableBalance !== undefined
      ? ` · saldo ${esc(brl(Math.round(account.availableBalance * 100)))}`
      : '';

  box.innerHTML =
    `Conectado como <strong>${esc(account.name || '—')}</strong>` +
    (account.email ? ` (${esc(account.email)})` : '') +
    saldo +
    (account.withdrawBlocked ? ' · <strong>saque bloqueado</strong>' : '');
  box.hidden = false;
  form.querySelector('[data-error]').hidden = true;
}

function showFormError(form, message) {
  const box = form.querySelector('[data-error]');
  box.textContent = message;
  box.hidden = false;
  form.querySelector('[data-ok]').hidden = true;
}

$('#gw-cards').addEventListener('click', async (event) => {
  const button = event.target.closest('[data-test]');
  if (!button) return;

  const form = button.closest('form');
  const id = form.dataset.gateway;

  button.disabled = true;
  button.textContent = 'Testando…';

  try {
    const result = await api(`/gateways/${encodeURIComponent(id)}/test`, {
      method: 'POST',
      body: readFields(form),
    });
    showResult(form, result.account);
  } catch (err) {
    showFormError(form, err.message);
  } finally {
    button.disabled = false;
    button.textContent = 'Testar conexão';
  }
});

$('#gw-cards').addEventListener('submit', async (event) => {
  event.preventDefault();

  const form = event.target;
  const id = form.dataset.gateway;
  const button = form.querySelector('[data-save]');

  button.disabled = true;
  button.textContent = 'Validando…';

  try {
    await api(`/gateways/${encodeURIComponent(id)}/credentials`, {
      method: 'PUT',
      body: readFields(form),
    });
    toast('Credenciais validadas e salvas.');
    await loadGateways();
  } catch (err) {
    showFormError(form, err.message);
    button.disabled = false;
    button.textContent = 'Salvar credenciais';
  }
});

/* ---------------- campanhas ---------------- */

async function loadCampaigns() {
  const data = await api(`/campaigns?days=${state.campDays}`);
  const { resumo } = data;

  $('#camp-params').value = `${data.checkoutUrl}/?produto=SEU_PRODUTO&${data.metaUrlParams}`;

  /* Aviso quando a atribuição está furada — é o erro mais comum e o mais
     caro: você otimiza campanha no escuro sem perceber. */
  const aviso = $('#camp-warning');
  if (resumo.total.iniciados === 0) {
    aviso.hidden = true;
  } else if (resumo.comOrigem.iniciados === 0) {
    aviso.textContent =
      'Nenhum pedido no período trouxe origem. Se você já está rodando anúncio, os ' +
      'parâmetros de URL não estão configurados — veja o bloco no fim desta página.';
    aviso.hidden = false;
  } else if (resumo.comFbc === 0 && resumo.meta.iniciados > 0) {
    aviso.textContent =
      'Chegou tráfego do Meta, mas nenhum pedido trouxe o identificador do clique (_fbc). ' +
      'O código da landing provavelmente não está instalado — sem ele a atribuição da venda ao ' +
      'anúncio fica quebrada.';
    aviso.hidden = false;
  } else {
    aviso.hidden = true;
  }

  const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0);

  $('#camp-stats').innerHTML = `
    <div class="stat">
      <p class="stat__label">Receita de anúncio</p>
      <p class="stat__value stat__value--green">${esc(resumo.anuncio.receitaFormatada)}</p>
      <p class="stat__hint">
        ${resumo.anuncio.pagos} de ${resumo.anuncio.iniciados} checkouts · ${resumo.anuncio.conversao}% de conversão
      </p>
    </div>
    <div class="stat">
      <p class="stat__label">Tráfego Meta (com orgânico)</p>
      <p class="stat__value">${esc(resumo.meta.receitaFormatada)}</p>
      <p class="stat__hint">${pct(resumo.meta.receitaCents, resumo.total.receitaCents)}% da receita total</p>
    </div>
    <div class="stat">
      <p class="stat__label">Com origem identificada</p>
      <p class="stat__value">${pct(resumo.comOrigem.iniciados, resumo.total.iniciados)}%</p>
      <p class="stat__hint">${resumo.comOrigem.iniciados} de ${resumo.total.iniciados} pedidos</p>
    </div>
    <div class="stat">
      <p class="stat__label">Clique do anúncio (_fbc)</p>
      <p class="stat__value" style="color:${resumo.comFbc ? 'inherit' : 'var(--warn)'}">${resumo.comFbc}</p>
      <p class="stat__hint">pedidos rastreáveis até o anúncio</p>
    </div>
  `;

  renderCampTable($('#camp-campaigns'), data.porCampanha, 'Campanha');
  renderCampTable($('#camp-ads'), data.porAnuncio, 'Anúncio', { compacto: true });
  renderCampTable($('#camp-adsets'), data.porConjunto, 'Conjunto', { compacto: true });
  renderCampTable($('#camp-sources'), data.porOrigem, 'Origem');
}

/**
 * Tabela de funil por origem.
 * A coluna que importa é conversão: campanha com muita gente e conversão
 * baixa é público errado, não criativo ruim.
 */
function renderCampTable(table, linhas, rotulo, { compacto = false } = {}) {
  if (!linhas.length) {
    table.innerHTML =
      '<tbody><tr><td><div class="empty">Nenhum dado no período.</div></td></tr></tbody>';
    return;
  }

  const melhorConversao = Math.max(...linhas.map((l) => l.conversao));

  table.innerHTML = `
    <thead>
      <tr>
        <th>${esc(rotulo)}</th>
        <th>Checkouts</th>
        <th>Vendas</th>
        <th>Conversão</th>
        <th>Receita</th>
        ${compacto ? '' : '<th>Ticket</th><th>Perdido</th>'}
      </tr>
    </thead>
    <tbody>
      ${linhas
        .map((l) => {
          const destaque =
            l.conversao === melhorConversao && l.pagos > 0 ? ' style="color:var(--neon-lime);font-weight:700"' : '';
          return `<tr>
            <td>${esc(l.nome)}</td>
            <td class="num">${l.iniciados}</td>
            <td class="num">${l.pagos}</td>
            <td class="num"${destaque}>${l.conversao}%</td>
            <td class="num">${esc(l.receitaFormatada)}</td>
            ${
              compacto
                ? ''
                : `<td class="num">${esc(l.ticketFormatado)}</td>
                   <td class="num" style="color:var(--ink-dim)">${esc(l.perdidoFormatado)}</td>`
            }
          </tr>`;
        })
        .join('')}
    </tbody>
  `;
}

$('#camp-range').addEventListener('click', (event) => {
  const button = event.target.closest('[data-days]');
  if (!button) return;

  state.campDays = Number(button.dataset.days);
  $('#camp-range .range__btn').forEach((b) => b.classList.toggle('is-on', b === button));
  loadCampaigns();
});

$('#copy-params').addEventListener('click', async () => {
  const button = $('#copy-params');
  const texto = $('#camp-params').value;

  // O Meta pede só os parâmetros, sem a URL na frente.
  const soParams = texto.includes('?') ? texto.split('?')[1] : texto;

  try {
    await navigator.clipboard.writeText(soParams);
  } catch {
    $('#camp-params').select();
    document.execCommand('copy');
  }

  button.textContent = 'Copiado!';
  setTimeout(() => (button.textContent = 'Copiar parâmetros'), 2200);
});

/* ---------------- pixels do Meta ---------------- */

let pixelsState = { pixels: [], checkoutUrl: '' };

async function loadPixels() {
  const data = await api('/pixels');
  pixelsState = data;

  const warning = $('#px-warning');
  if (!data.schemaReady) {
    warning.textContent =
      'A tabela de pixels ainda não existe. Rode supabase/migrations/006-pixels.sql no ' +
      'SQL Editor do Supabase para habilitar o rastreamento.';
    warning.hidden = false;
  } else if (!data.encryptionReady) {
    warning.textContent =
      'APP_ENCRYPTION_KEY não configurada. Sem ela o token da Conversions API seria ' +
      'gravado em texto claro, então salvar fica bloqueado.';
    warning.hidden = false;
  } else {
    warning.hidden = true;
  }

  $('#new-pixel-btn').disabled = !data.schemaReady || !data.encryptionReady;

  if (!data.pixels.length) {
    $('#pixels-list').innerHTML =
      '<div class="empty">Nenhum pixel cadastrado. Crie um para começar a rastrear as vendas.</div>';
    return;
  }

  $('#pixels-list').innerHTML = data.pixels
    .map((p) => {
      // Sem token, a nota do evento fica presa em 6-7. Vale destacar.
      const saude = p.hasToken
        ? '<span class="pill pill--on">Conversions API ativa</span>'
        : '<span class="pill pill--PENDENTE">Sem token — nota limitada a ~6</span>';

      return `
        <div class="px-card">
          <div class="px-card__top">
            <div>
              <div class="px-card__name">${esc(p.name)}</div>
              <div class="px-card__id mono">${esc(p.pixelId)}</div>
            </div>
            <div class="px-card__tags">
              ${saude}
              ${p.testEventCode ? '<span class="pill pill--PENDENTE">Modo teste</span>' : ''}
              ${p.active ? '' : '<span class="pill pill--off">Inativo</span>'}
            </div>
          </div>

          <div class="px-card__meta">
            ${
              p.products.length
                ? `Usado em: <strong>${esc(p.products.join(', '))}</strong>`
                : 'Nenhum produto usa este pixel ainda.'
            }
            ${
              p.lastEventStatus
                ? `<br>Último evento: ${esc(p.lastEventStatus)}${
                    p.lastEventAt ? ` · ${esc(dateTime(p.lastEventAt))}` : ''
                  }`
                : ''
            }
          </div>

          <div class="px-card__actions">
            <button class="btn btn--mini" data-snippet="${esc(p.id)}">Código da landing</button>
            <button class="btn btn--ghost btn--mini" data-edit-pixel="${esc(p.id)}">Editar</button>
            <button class="btn btn--danger btn--mini" data-del-pixel="${esc(p.id)}">Excluir</button>
          </div>
        </div>`;
    })
    .join('');
}

function openPixelModal(pixel = null) {
  $('#pixel-modal-title').textContent = pixel ? 'Editar pixel' : 'Novo pixel';
  $('#px-id').value = pixel?.id || '';
  $('#px-name').value = pixel?.name || '';
  $('#px-pixel-id').value = pixel?.pixelId || '';
  $('#px-token').value = '';
  $('#px-test').value = pixel?.testEventCode || '';
  $('#px-token').placeholder = pixel?.hasToken ? '•••••••••• (mantém o atual)' : '';
  $('#pixel-error').hidden = true;
  $('#pixel-ok').hidden = true;

  $('#pixel-modal').hidden = false;
  $('#px-name').focus();
}

$('#new-pixel-btn').addEventListener('click', () => openPixelModal());

$('#px-pixel-id').addEventListener('input', (e) => {
  e.target.value = e.target.value.replace(/\D/g, '').slice(0, 20);
});

$('#pixels-list').addEventListener('click', async (event) => {
  const edit = event.target.closest('[data-edit-pixel]');
  if (edit) {
    openPixelModal(pixelsState.pixels.find((p) => p.id === edit.dataset.editPixel));
    return;
  }

  const snip = event.target.closest('[data-snippet]');
  if (snip) {
    const { snippet } = await api(`/pixels/${encodeURIComponent(snip.dataset.snippet)}/snippet`);
    $('#snippet-box').value = snippet;
    $('#snippet-modal').hidden = false;
    return;
  }

  const del = event.target.closest('[data-del-pixel]');
  if (del) {
    const pixel = pixelsState.pixels.find((p) => p.id === del.dataset.delPixel);
    if (!confirm(`Excluir o pixel "${pixel.name}"?`)) return;

    try {
      await api(`/pixels/${encodeURIComponent(pixel.id)}`, { method: 'DELETE' });
      toast('Pixel excluído.');
      loadPixels();
    } catch (err) {
      // Em uso por produtos: confirma de novo, agora sabendo a consequência.
      if (err.message.includes('produto')) {
        if (!confirm(`${err.message}\n\nExcluir mesmo assim?`)) return;
        await api(`/pixels/${encodeURIComponent(pixel.id)}?force=sim`, { method: 'DELETE' });
        toast('Pixel excluído.');
        loadPixels();
      } else {
        toast(err.message, true);
      }
    }
  }
});

function pixelFormBody() {
  return {
    name: $('#px-name').value,
    pixelId: $('#px-pixel-id').value,
    accessToken: $('#px-token').value,
    testEventCode: $('#px-test').value,
  };
}

$('#px-test-btn').addEventListener('click', async () => {
  const id = $('#px-id').value;
  const button = $('#px-test-btn');

  if (!id) {
    $('#pixel-error').textContent = 'Salve o pixel primeiro; depois o teste dispara um evento real.';
    $('#pixel-error').hidden = false;
    return;
  }

  button.disabled = true;
  button.textContent = 'Testando…';

  try {
    const r = await api(`/pixels/${encodeURIComponent(id)}/test`, {
      method: 'POST',
      body: { accessToken: $('#px-token').value, testEventCode: $('#px-test').value },
    });

    $('#pixel-ok').innerHTML =
      `Meta recebeu o evento. <strong>${r.signals.total} sinais</strong> de identificação: ` +
      esc(r.signals.presentes.join(', ')) + '.';
    $('#pixel-ok').hidden = false;
    $('#pixel-error').hidden = true;
  } catch (err) {
    $('#pixel-error').textContent = err.message;
    $('#pixel-error').hidden = false;
    $('#pixel-ok').hidden = true;
  } finally {
    button.disabled = false;
    button.textContent = 'Testar';
  }
});

$('#pixel-form').addEventListener('submit', async (event) => {
  event.preventDefault();

  const id = $('#px-id').value;
  const button = $('#px-save');
  button.disabled = true;

  try {
    if (id) {
      await api(`/pixels/${encodeURIComponent(id)}`, { method: 'PATCH', body: pixelFormBody() });
      toast('Pixel atualizado.');
    } else {
      await api('/pixels', { method: 'POST', body: pixelFormBody() });
      toast('Pixel criado. Agora escolha-o no produto.');
    }
    closeModals();
    loadPixels();
  } catch (err) {
    $('#pixel-error').textContent = err.message;
    $('#pixel-error').hidden = false;
  } finally {
    button.disabled = false;
  }
});

$('#copy-snippet').addEventListener('click', async () => {
  const button = $('#copy-snippet');
  try {
    await navigator.clipboard.writeText($('#snippet-box').value);
  } catch {
    $('#snippet-box').select();
    document.execCommand('copy');
  }
  button.textContent = 'Copiado!';
  setTimeout(() => (button.textContent = 'Copiar código'), 2200);
});

/* ---------------- auditoria ---------------- */

async function loadAudit() {
  const entries = await api('/audit');
  const table = $('#audit-table');

  if (!entries.length) {
    table.innerHTML = '<tbody><tr><td><div class="empty">Sem registros.</div></td></tr></tbody>';
    return;
  }

  table.innerHTML = `
    <thead><tr><th>Quando</th><th>Ação</th><th>IP</th><th>Detalhe</th></tr></thead>
    <tbody>
      ${entries
        .map(
          (entry) => `<tr>
            <td class="num">${esc(dateTime(entry.at))}</td>
            <td>${esc(entry.action)}</td>
            <td class="mono">${esc(entry.ip || '—')}</td>
            <td class="mono">${esc(entry.detail ? JSON.stringify(entry.detail) : '—')}</td>
          </tr>`
        )
        .join('')}
    </tbody>
  `;
}

$('#revoke-btn').addEventListener('click', async () => {
  if (!confirm('Encerrar todas as outras sessões ativas?')) return;
  await api('/sessions/revoke', { method: 'POST' });
  toast('Outras sessões encerradas.');
  loadAudit();
});

/* ---------------- modais ---------------- */

function closeModals() {
  $$('.modal').forEach((modal) => (modal.hidden = true));
}

document.addEventListener('click', (event) => {
  if (event.target.closest('[data-close]')) closeModals();
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') closeModals();
});

/* ---------------- inicialização ---------------- */

(async function boot() {
  try {
    const session = await api('/session');
    state.csrf = session.csrf;

    $('#who').textContent = session.lastLoginAt
      ? `${session.name} · último acesso ${dateTime(session.lastLoginAt)}`
      : session.name;

    showView('overview');
  } catch {
    location.href = `${BASE}/`;
  }
})();
