/* ==========================================================
   Painel administrativo
   O prefixo secreto sai da URL — nada fica hardcoded no arquivo.
   ========================================================== */

const BASE = location.pathname.replace(/\/(painel)?\/?$/, '');
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const state = { csrf: null, view: 'overview', ordersPage: 1, products: [] };

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

/* ---------------- navegação ---------------- */

$('#tabs').addEventListener('click', (event) => {
  const tab = event.target.closest('.tab');
  if (!tab) return;
  showView(tab.dataset.view);
});

function showView(view) {
  state.view = view;
  $$('.tab').forEach((t) => t.classList.toggle('is-active', t.dataset.view === view));
  $$('.view').forEach((v) => v.classList.toggle('is-active', v.dataset.view === view));

  if (view === 'overview') loadOverview();
  if (view === 'products') loadProducts();
  if (view === 'orders') loadOrders();
  if (view === 'settings') loadGateway();
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

async function loadOverview() {
  const data = await api('/overview');
  const { totals, periods, daily, topProducts, recent } = data;

  $('#stats').innerHTML = `
    <div class="stat">
      <p class="stat__label">Receita total</p>
      <p class="stat__value stat__value--green">${esc(totals.revenueFormatted)}</p>
      <p class="stat__hint">${totals.salesCount} ${totals.salesCount === 1 ? 'venda' : 'vendas'}</p>
    </div>
    <div class="stat">
      <p class="stat__label">Últimos 30 dias</p>
      <p class="stat__value">${esc(brl(periods.monthCents))}</p>
      <p class="stat__hint">${periods.monthCount} vendas · hoje ${esc(brl(periods.dayCents))}</p>
    </div>
    <div class="stat">
      <p class="stat__label">Ticket médio</p>
      <p class="stat__value">${esc(totals.averageTicketFormatted)}</p>
      <p class="stat__hint">por venda concluída</p>
    </div>
    <div class="stat">
      <p class="stat__label">Conversão</p>
      <p class="stat__value">${totals.conversionRate}%</p>
      <p class="stat__hint">${totals.pendingCount} pendentes de ${totals.ordersCount}</p>
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

  const peak = Math.max(1, ...daily.map((d) => d.cents));
  $('#chart').innerHTML = daily
    .map((day) => {
      const height = Math.round((day.cents / peak) * 100);
      const label = day.date.slice(8) + '/' + day.date.slice(5, 7);
      return `<div class="bar" title="${esc(label)} — ${esc(brl(day.cents))} (${day.count})">
                <div class="bar__fill" style="height:${height}%"></div>
                <div class="bar__day">${esc(day.date.slice(8))}</div>
              </div>`;
    })
    .join('');

  $('#top-products').innerHTML = topProducts.length
    ? topProducts
        .map(
          (p) => `<div class="ranked__row">
                    <div>
                      <div class="ranked__name">${esc(p.name)}</div>
                      <div class="ranked__meta">${p.count} ${p.count === 1 ? 'venda' : 'vendas'}</div>
                    </div>
                    <div class="ranked__value">${esc(brl(p.cents))}</div>
                  </div>`
        )
        .join('')
    : '<div class="empty">Nenhuma venda registrada ainda.</div>';

  renderOrderTable($('#recent-table'), recent, { compact: true });
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
  $('#product-error').hidden = true;

  $('#product-modal').hidden = false;
  $('#p-name').focus();
}

$('#new-product-btn').addEventListener('click', () => openProductModal());

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

/* ---------------- configurações do gateway ---------------- */

async function loadGateway() {
  const status = await api('/settings/gateway');

  $('#gw-ci').value = status.ci || '';
  $('#gw-cs').value = '';
  $('#gw-base').textContent = status.baseUrl;
  $('#gw-updated').textContent = status.updatedAt ? dateTime(status.updatedAt) : '—';

  const badge = $('#gw-source');
  badge.textContent = status.source === 'painel' ? 'Salvas no painel' : 'Vindas do ambiente';
  badge.className = `pill pill--${status.source === 'painel' ? 'on' : 'off'}`;

  $('#gw-cs-hint').textContent = status.csConfigured
    ? 'Já existe um secret salvo. Deixe em branco para mantê-lo; preencha só para trocar.'
    : 'Nenhum secret salvo ainda.';

  $('#gw-cs').placeholder = status.csConfigured ? '•••••••••••••• (mantém o atual)' : '';

  $('#gw-enc').textContent = status.encryptionReady
    ? 'Ativa — o secret é gravado cifrado (AES-256-GCM)'
    : 'INATIVA — configure APP_ENCRYPTION_KEY';

  const warning = $('#gw-warning');
  if (!status.tableReady) {
    warning.className = 'hint hint--warn';
    warning.textContent =
      'A tabela "settings" ainda não existe no Supabase. Abra o SQL Editor e rode ' +
      'supabase/migrations/002-settings.sql para poder salvar as credenciais por aqui.';
    warning.hidden = false;
    $('#gw-save').disabled = true;
  } else if (!status.encryptionReady) {
    warning.className = 'hint hint--warn';
    warning.textContent =
      'APP_ENCRYPTION_KEY não está configurada no servidor. Sem ela o Client Secret ' +
      'seria gravado em texto claro no banco, então a gravação fica bloqueada. ' +
      'Gere uma com "npm run gen:key" e cadastre nas variáveis de ambiente.';
    warning.hidden = false;
    $('#gw-save').disabled = true;
  } else {
    warning.hidden = true;
    $('#gw-save').disabled = false;
  }
}

function gatewayInputs() {
  return { ci: $('#gw-ci').value.trim(), cs: $('#gw-cs').value.trim() };
}

function showGatewayResult(account) {
  const box = $('#gw-ok');
  box.innerHTML =
    `Conectado como <strong>${esc(account.name || '—')}</strong>` +
    (account.email ? ` (${esc(account.email)})` : '') +
    (account.availableBalance !== null
      ? ` · saldo disponível ${esc(brl(Math.round(account.availableBalance * 100)))}`
      : '') +
    (account.withdrawBlocked ? ' · <strong>saque bloqueado</strong>' : '');
  box.hidden = false;
  $('#gw-error').hidden = true;
}

function showGatewayError(message) {
  const box = $('#gw-error');
  box.textContent = message;
  box.hidden = false;
  $('#gw-ok').hidden = true;
}

$('#gw-test').addEventListener('click', async () => {
  const { ci, cs } = gatewayInputs();
  if (!ci) {
    showGatewayError('Informe o Client ID.');
    return;
  }

  const button = $('#gw-test');
  button.disabled = true;
  button.textContent = 'Testando…';

  try {
    const result = await api('/settings/gateway/test', { method: 'POST', body: { ci, cs } });
    showGatewayResult(result.account);
  } catch (err) {
    showGatewayError(err.message);
  } finally {
    button.disabled = false;
    button.textContent = 'Testar conexão';
  }
});

$('#gateway-form').addEventListener('submit', async (event) => {
  event.preventDefault();

  const { ci, cs } = gatewayInputs();
  if (!ci) {
    showGatewayError('Informe o Client ID.');
    return;
  }

  if (!confirm('Trocar as credenciais do gateway?\n\nElas passam a valer para todas as novas cobranças em até 30 segundos.')) {
    return;
  }

  const button = $('#gw-save');
  button.disabled = true;
  button.textContent = 'Validando…';

  try {
    await api('/settings/gateway', { method: 'PUT', body: { ci, cs } });
    toast('Credenciais validadas e salvas.');
    await loadGateway();
    $('#gw-ok').hidden = true;
  } catch (err) {
    showGatewayError(err.message);
  } finally {
    button.disabled = false;
    button.textContent = 'Salvar credenciais';
  }
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
