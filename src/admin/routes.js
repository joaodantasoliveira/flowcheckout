import path from 'node:path';
import { fileURLToPath } from 'node:url';

import express, { Router } from 'express';

import { audit, listAudit } from '../audit.js';
import { getBalance } from '../misticpay.js';
import { syncOrderWithGateway } from '../orders.js';
import {
  createProduct,
  deleteProduct,
  formatBRL,
  getProduct,
  listProducts,
  updateProduct,
  validateProductInput,
} from '../products.js';
import { rateLimit } from '../rate-limit.js';
import {
  countOrders,
  countOrdersByStatus,
  getOrder,
  listInfractionOrders,
  listOrders,
  listPaidOrders,
  listRecentOrders,
} from '../store.js';
import {
  currentCsrf,
  hostGuard,
  ipGuard,
  login,
  logout,
  noStore,
  requireAuth,
  requireCsrf,
  revokeOtherSessions,
} from './auth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UI_DIR = path.join(__dirname, '..', '..', 'admin-ui');

export const adminRouter = Router();

/* Ordem importa: host -> IP -> cabecalhos. Tudo antes de qualquer logica. */
adminRouter.use(hostGuard, ipGuard, noStore);

/* ============================================================
   Mascaramento de dados pessoais (LGPD)
   ============================================================ */

function maskDocument(doc = '') {
  const d = String(doc);
  if (d.length < 5) return '***';
  return `${d.slice(0, 3)}${'*'.repeat(d.length - 5)}${d.slice(-2)}`;
}

function maskEmail(email = '') {
  const [user = '', domain = ''] = String(email).split('@');
  return `${user.slice(0, 2)}${'*'.repeat(Math.max(1, user.length - 2))}@${domain}`;
}

function maskPhone(phone = '') {
  const d = String(phone);
  return d.length < 6 ? '***' : `${'*'.repeat(d.length - 4)}${d.slice(-4)}`;
}

/** Por padrao a lista mostra dados mascarados. Ver o dado cru exige acao explicita. */
function orderView(order, { unmasked = false } = {}) {
  const customer = unmasked
    ? order.customer
    : {
        name: order.customer.name,
        email: maskEmail(order.customer.email),
        document: maskDocument(order.customer.document),
        phone: maskPhone(order.customer.phone),
      };

  return {
    id: order.id,
    productId: order.productId,
    productName: order.productName,
    amountCents: order.amountCents,
    amountFormatted: formatBRL(order.amountCents),
    status: order.status,
    paid: order.paid,
    paidAt: order.paidAt,
    createdAt: order.createdAt,
    endToEndId: order.endToEndId,
    gatewayTransactionId: order.gatewayTransactionId,
    infraction: order.infraction || null,
    customer,
    masked: !unmasked,
  };
}

/** Envolve handlers async para que erro vire 500 tratado, nao promise solta. */
const wrap = (handler) => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);

/* ============================================================
   Rotas publicas do painel (sem sessao)
   ============================================================ */

const loginLimiter = rateLimit({
  scope: 'login',
  windowMs: 15 * 60_000,
  max: 20,
  message: 'Muitas tentativas de acesso. Aguarde.',
});

adminRouter.get('/', (req, res) => {
  // As paginas referenciam os assets por caminho relativo. Sem a barra final,
  // "assets/admin.css" resolveria para a raiz do site em vez do prefixo secreto.
  const [pathOnly, query] = req.originalUrl.split('?');
  if (!pathOnly.endsWith('/')) {
    return res.redirect(302, `${pathOnly}/${query ? `?${query}` : ''}`);
  }
  res.sendFile(path.join(UI_DIR, 'login.html'));
});

adminRouter.get('/painel', (req, res) => res.sendFile(path.join(UI_DIR, 'app.html')));

adminRouter.use('/assets', express.static(path.join(UI_DIR, 'assets'), { index: false }));

adminRouter.post('/api/login', loginLimiter, wrap(login));

/* ============================================================
   A partir daqui tudo exige sessao valida + CSRF
   ============================================================ */

adminRouter.use('/api', wrap(requireAuth), wrap(requireCsrf));

adminRouter.post('/api/logout', wrap(logout));

adminRouter.get('/api/session', (req, res) => {
  res.json({
    name: req.admin.name || req.admin.username,
    username: req.admin.username,
    csrf: currentCsrf(req),
    lastLoginAt: req.admin.last_login_at || null,
    lastLoginIp: req.admin.last_login_ip || null,
  });
});

adminRouter.post(
  '/api/sessions/revoke',
  wrap(async (req, res) => {
    await revokeOtherSessions(req.admin.id, req.sessionToken);
    await audit('sessoes.revogadas', { adminId: req.admin.id, ip: req.ip });
    res.json({ ok: true });
  })
);

/* ---------------- visão geral ---------------- */

adminRouter.get(
  '/api/overview',
  wrap(async (req, res) => {
    const [paid, ordersCount, pendingCount, recent, infractions] = await Promise.all([
      listPaidOrders(),
      countOrders(),
      countOrdersByStatus('PENDENTE'),
      listRecentOrders(8),
      listInfractionOrders(),
    ]);

    const sum = (list) => list.reduce((total, o) => total + o.amountCents, 0);
    const since = (ts) => paid.filter((o) => (o.paidAt || o.createdAt) >= ts);

    const now = Date.now();
    const dayAgo = now - 24 * 60 * 60 * 1000;
    const weekAgo = now - 7 * 24 * 60 * 60 * 1000;
    const monthAgo = now - 30 * 24 * 60 * 60 * 1000;

    // Receita por dia nos ultimos 14 dias, para o grafico de barras.
    const daily = [];
    for (let i = 13; i >= 0; i--) {
      const start = new Date();
      start.setHours(0, 0, 0, 0);
      start.setDate(start.getDate() - i);
      const end = new Date(start).setDate(start.getDate() + 1);

      const dayOrders = paid.filter((o) => {
        const at = o.paidAt || o.createdAt;
        return at >= start.getTime() && at < end;
      });

      daily.push({
        date: start.toISOString().slice(0, 10),
        cents: sum(dayOrders),
        count: dayOrders.length,
      });
    }

    // Ranking de produtos por receita.
    const byProduct = new Map();
    for (const order of paid) {
      const entry = byProduct.get(order.productId) || {
        productId: order.productId,
        name: order.productName,
        count: 0,
        cents: 0,
      };
      entry.count += 1;
      entry.cents += order.amountCents;
      byProduct.set(order.productId, entry);
    }

    const averageTicket = paid.length ? Math.round(sum(paid) / paid.length) : 0;

    res.json({
      totals: {
        revenueCents: sum(paid),
        revenueFormatted: formatBRL(sum(paid)),
        salesCount: paid.length,
        ordersCount,
        // Percentual de checkouts iniciados que viraram pagamento.
        conversionRate: ordersCount ? Number(((paid.length / ordersCount) * 100).toFixed(1)) : 0,
        averageTicketCents: averageTicket,
        averageTicketFormatted: formatBRL(averageTicket),
        pendingCount,
        infractionCount: infractions.length,
      },
      periods: {
        dayCents: sum(since(dayAgo)),
        dayCount: since(dayAgo).length,
        weekCents: sum(since(weekAgo)),
        weekCount: since(weekAgo).length,
        monthCents: sum(since(monthAgo)),
        monthCount: since(monthAgo).length,
      },
      daily,
      topProducts: [...byProduct.values()].sort((a, b) => b.cents - a.cents).slice(0, 5),
      recent: recent.map((o) => orderView(o)),
    });
  })
);

/** Saldo disponivel na MisticPay. Rota separada: depende de rede e pode falhar. */
adminRouter.get(
  '/api/balance',
  wrap(async (req, res) => {
    try {
      const response = await getBalance();
      res.json({ balance: response?.data?.balance ?? null });
    } catch {
      res.status(502).json({ error: 'Não foi possível consultar o saldo agora.' });
    }
  })
);

/* ---------------- produtos ---------------- */

adminRouter.get(
  '/api/products',
  wrap(async (req, res) => {
    const [products, paid] = await Promise.all([listProducts(), listPaidOrders()]);

    res.json(
      products.map((product) => {
        const sales = paid.filter((o) => o.productId === product.id);
        return {
          ...product,
          priceFormatted: formatBRL(product.priceCents),
          salesCount: sales.length,
          revenueCents: sales.reduce((total, o) => total + o.amountCents, 0),
          checkoutUrl: `/?produto=${encodeURIComponent(product.id)}`,
        };
      })
    );
  })
);

adminRouter.post(
  '/api/products',
  wrap(async (req, res) => {
    const errors = validateProductInput(req.body);
    if (Object.keys(errors).length) {
      return res.status(422).json({ error: 'Revise os campos.', fields: errors });
    }

    const product = await createProduct(req.body);
    await audit('produto.criado', {
      adminId: req.admin.id,
      ip: req.ip,
      detail: { id: product.id, priceCents: product.priceCents },
    });

    res.status(201).json(product);
  })
);

adminRouter.patch(
  '/api/products/:id',
  wrap(async (req, res) => {
    const product = await getProduct(req.params.id);
    if (!product) return res.status(404).json({ error: 'Produto não encontrado.' });

    const errors = validateProductInput(req.body, { partial: true });
    if (Object.keys(errors).length) {
      return res.status(422).json({ error: 'Revise os campos.', fields: errors });
    }

    const updated = await updateProduct(product.id, req.body);
    await audit('produto.editado', {
      adminId: req.admin.id,
      ip: req.ip,
      detail: { id: product.id, previousPrice: product.priceCents, priceCents: updated.priceCents },
    });

    res.json(updated);
  })
);

adminRouter.delete(
  '/api/products/:id',
  wrap(async (req, res) => {
    const product = await getProduct(req.params.id);
    if (!product) return res.status(404).json({ error: 'Produto não encontrado.' });

    const result = await deleteProduct(product.id);
    await audit(result.deleted ? 'produto.excluido' : 'produto.desativado', {
      adminId: req.admin.id,
      ip: req.ip,
      detail: { id: product.id },
    });

    res.json({
      ...result,
      message: result.deleted
        ? 'Produto excluído.'
        : 'Produto tem vendas registradas e foi desativado em vez de excluído, para preservar o histórico.',
    });
  })
);

/* ---------------- vendas ---------------- */

adminRouter.get(
  '/api/orders',
  wrap(async (req, res) => {
    const { orders, pagination } = await listOrders({
      status: String(req.query.status || '').toUpperCase(),
      query: String(req.query.q || '').trim(),
      page: Math.max(1, Number(req.query.page) || 1),
    });

    res.json({ data: orders.map((o) => orderView(o)), pagination });
  })
);

adminRouter.get(
  '/api/orders/:id',
  wrap(async (req, res) => {
    const order = await getOrder(req.params.id);
    if (!order) return res.status(404).json({ error: 'Pedido não encontrado.' });
    res.json(orderView(order));
  })
);

/** Exibe os dados pessoais sem mascara. Toda exibicao fica registrada. */
adminRouter.post(
  '/api/orders/:id/reveal',
  wrap(async (req, res) => {
    const order = await getOrder(req.params.id);
    if (!order) return res.status(404).json({ error: 'Pedido não encontrado.' });

    await audit('dados_pessoais.exibidos', {
      adminId: req.admin.id,
      ip: req.ip,
      detail: { orderId: order.id },
    });

    res.json(orderView(order, { unmasked: true }));
  })
);

/** Forca uma reconsulta ao gateway — util quando o webhook nao chegou. */
adminRouter.post(
  '/api/orders/:id/recheck',
  wrap(async (req, res) => {
    const order = await getOrder(req.params.id);
    if (!order) return res.status(404).json({ error: 'Pedido não encontrado.' });

    const synced = await syncOrderWithGateway(order, { force: true });
    await audit('pedido.reconsultado', {
      adminId: req.admin.id,
      ip: req.ip,
      detail: { orderId: order.id },
    });

    res.json(orderView(synced));
  })
);

/** Exportacao CSV — leva dados pessoais completos, por isso e auditada. */
adminRouter.get(
  '/api/orders/export/csv',
  wrap(async (req, res) => {
    const orders = await listPaidOrders();

    await audit('vendas.exportadas', {
      adminId: req.admin.id,
      ip: req.ip,
      detail: { count: orders.length },
    });

    const escape = (value) => {
      const text = String(value ?? '');
      // Neutraliza formula injection: =, +, -, @ no inicio viram texto no Excel.
      const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
      return `"${safe.replace(/"/g, '""')}"`;
    };

    const header = [
      'pedido', 'data', 'produto', 'valor', 'status',
      'nome', 'email', 'documento', 'telefone', 'e2e', 'transacao_gateway',
    ];

    const rows = orders.map((o) =>
      [
        o.id,
        new Date(o.paidAt || o.createdAt).toISOString(),
        o.productName,
        (o.amountCents / 100).toFixed(2).replace('.', ','),
        o.status,
        o.customer.name,
        o.customer.email,
        o.customer.document,
        o.customer.phone,
        o.endToEndId || '',
        o.gatewayTransactionId || '',
      ].map(escape).join(';')
    );

    // BOM para o Excel abrir os acentos corretamente.
    const csv = `﻿${header.map(escape).join(';')}\n${rows.join('\n')}`;

    res.set({
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="vendas-${new Date().toISOString().slice(0, 10)}.csv"`,
    });
    res.send(csv);
  })
);

/* ---------------- auditoria ---------------- */

adminRouter.get(
  '/api/audit',
  wrap(async (req, res) => res.json(await listAudit(200)))
);

/* Qualquer outro caminho sob o prefixo secreto responde 404 seco. */
adminRouter.use((req, res) => res.status(404).end());
