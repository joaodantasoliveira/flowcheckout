import path from 'node:path';
import { fileURLToPath } from 'node:url';

import express, { Router } from 'express';

import { audit, listAudit } from '../audit.js';
import { getGateway } from '../gateways/index.js';
import {
  getActiveGateway,
  getCredentials,
  getGatewaysStatus,
  saveCredentials,
  setActiveGateway,
} from '../settings.js';
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
  listOrdersForStats,
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
    const days = Math.min(90, Math.max(7, Number(req.query.days) || 14));

    const [paid, allOrders, recent, infractions] = await Promise.all([
      listPaidOrders(),
      listOrdersForStats(),
      listRecentOrders(8),
      listInfractionOrders(),
    ]);

    const sum = (list) => list.reduce((total, o) => total + o.amountCents, 0);
    const when = (o) => o.paidAt || o.createdAt;

    const now = Date.now();
    const DAY = 24 * 60 * 60 * 1000;
    const since = (ts) => paid.filter((o) => when(o) >= ts);

    /* ---------- janela atual e a anterior, para comparar ---------- */
    const windowStart = now - days * DAY;
    const prevStart = now - days * 2 * DAY;

    const inWindow = paid.filter((o) => when(o) >= windowStart);
    const inPrev = paid.filter((o) => when(o) >= prevStart && when(o) < windowStart);

    /** Variação percentual protegida contra divisão por zero. */
    const delta = (atual, anterior) => {
      if (!anterior) return atual ? 100 : 0;
      return Number((((atual - anterior) / anterior) * 100).toFixed(1));
    };

    /* ---------- série diária ---------- */
    const daily = [];
    for (let i = days - 1; i >= 0; i--) {
      const start = new Date();
      start.setHours(0, 0, 0, 0);
      start.setDate(start.getDate() - i);
      const end = new Date(start).setDate(start.getDate() + 1);

      const dayOrders = paid.filter((o) => when(o) >= start.getTime() && when(o) < end);

      daily.push({
        date: start.toISOString().slice(0, 10),
        cents: sum(dayOrders),
        count: dayOrders.length,
      });
    }

    /* ---------- funil: quem chegou até onde ---------- */
    const iniciados = allOrders.length;
    const comPix = allOrders.filter((o) => o.gatewayTransactionId).length;
    const pagos = allOrders.filter((o) => o.paid).length;

    /* ---------- tempo até pagar ----------
       Mediana, não média: um pedido pago 3 dias depois distorceria a média
       e esconderia o comportamento típico. */
    const temposMin = allOrders
      .filter((o) => o.paid && o.paidAt && o.paidAt > o.createdAt)
      .map((o) => (o.paidAt - o.createdAt) / 60000)
      .sort((a, b) => a - b);

    const medianaMin = temposMin.length
      ? Math.round(temposMin[Math.floor(temposMin.length / 2)])
      : null;

    /* ---------- dinheiro parado ---------- */
    const pendentes = allOrders.filter((o) => o.status === 'PENDENTE');

    /* ---------- por hora do dia ---------- */
    const porHora = Array.from({ length: 24 }, (_, h) => ({ hour: h, cents: 0, count: 0 }));
    for (const order of inWindow) {
      const h = new Date(when(order)).getHours();
      porHora[h].cents += order.amountCents;
      porHora[h].count += 1;
    }

    /* ---------- por gateway ---------- */
    const porGateway = new Map();
    for (const order of allOrders) {
      const key = order.gateway || 'misticpay';
      const entry = porGateway.get(key) || { gateway: key, total: 0, pagos: 0, cents: 0 };
      entry.total += 1;
      if (order.paid) {
        entry.pagos += 1;
        entry.cents += order.amountCents;
      }
      porGateway.set(key, entry);
    }

    /* ---------- ranking de produtos ---------- */
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
      days,
      totals: {
        revenueCents: sum(paid),
        revenueFormatted: formatBRL(sum(paid)),
        salesCount: paid.length,
        ordersCount: iniciados,
        conversionRate: iniciados ? Number(((pagos / iniciados) * 100).toFixed(1)) : 0,
        averageTicketCents: averageTicket,
        averageTicketFormatted: formatBRL(averageTicket),
        pendingCount: pendentes.length,
        pendingCents: sum(pendentes),
        pendingFormatted: formatBRL(sum(pendentes)),
        infractionCount: infractions.length,
        medianMinutesToPay: medianaMin,
      },
      window: {
        cents: sum(inWindow),
        formatted: formatBRL(sum(inWindow)),
        count: inWindow.length,
        deltaCents: delta(sum(inWindow), sum(inPrev)),
        deltaCount: delta(inWindow.length, inPrev.length),
      },
      periods: {
        dayCents: sum(since(now - DAY)),
        dayCount: since(now - DAY).length,
        weekCents: sum(since(now - 7 * DAY)),
        weekCount: since(now - 7 * DAY).length,
        monthCents: sum(since(now - 30 * DAY)),
        monthCount: since(now - 30 * DAY).length,
      },
      funnel: [
        { label: 'Checkouts iniciados', value: iniciados },
        { label: 'PIX gerado', value: comPix },
        { label: 'Pagamento concluído', value: pagos },
      ],
      hourly: porHora,
      gateways: [...porGateway.values()].sort((a, b) => b.cents - a.cents),
      daily,
      topProducts: [...byProduct.values()].sort((a, b) => b.cents - a.cents).slice(0, 5),
      recent: recent.map((o) => orderView(o)),
    });
  })
);

/** Saldo do gateway ativo. Rota separada: depende de rede e pode falhar. */
adminRouter.get(
  '/api/gateways/balance',
  wrap(async (req, res) => {
    try {
      const { gateway, credentials } = await getActiveGateway();
      res.json({ gateway: gateway.id, balance: await gateway.getBalance(credentials) });
    } catch {
      res.status(502).json({ error: 'Não foi possível consultar o saldo agora.' });
    }
  })
);

/* ---------------- auditoria ---------------- */

adminRouter.get(
  '/api/audit',
  wrap(async (req, res) => res.json(await listAudit(200)))
);

/* Qualquer outro caminho sob o prefixo secreto responde 404 seco. */
adminRouter.use((req, res) => res.status(404).end());
