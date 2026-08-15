import path from 'node:path';
import { fileURLToPath } from 'node:url';

import express, { Router } from 'express';

import { audit, listAudit } from '../audit.js';
import { buildCampaignReport, META_URL_PARAMS } from '../campaigns.js';
import { config } from '../config.js';
import { hasEncryptionKey } from '../crypto-utils.js';
import { testCredentials as testPixelCredentials } from '../meta-capi.js';
import {
  createPixel,
  deletePixel,
  getPixel,
  getPixelWithToken,
  listPixels,
  updatePixel,
  validatePixelInput,
} from '../pixels.js';
import { buildLandingSnippet } from '../tracking.js';
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
  getOrder,
  listInfractionOrders,
  listOrders,
  listOrdersForStats,
  listPageViews,
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

    const [paid, allOrders, recent, infractions, views] = await Promise.all([
      listPaidOrders(),
      listOrdersForStats(),
      listRecentOrders(8),
      listInfractionOrders(),
      listPageViews({ since: Date.now() - days * 24 * 60 * 60 * 1000 }),
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
    const visitasLanding = (views || []).filter((v) => v.source === 'landing').length;
    const visitasCheckout = (views || []).filter((v) => v.source !== 'landing').length;

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
      // views === null significa migracao 008 pendente: some a etapa em vez
      // de mostrar zero, que pareceria queda de 100% no topo.
      // Etapa some quando nao ha dado, em vez de mostrar zero — zero no
      // topo pareceria queda de 100% e assustaria sem motivo.
      funnel: [
        ...(visitasLanding ? [{ label: 'Visita na página de vendas', value: visitasLanding }] : []),
        ...(visitasCheckout ? [{ label: 'Visita no checkout', value: visitasCheckout }] : []),
        { label: 'Checkout iniciado', value: iniciados },
        { label: 'PIX gerado', value: comPix },
        { label: 'Venda', value: pagos },
      ],
      viewsTracked: views !== null,
      hourly: porHora,
      gateways: [...porGateway.values()].sort((a, b) => b.cents - a.cents),
      daily,
      topProducts: [...byProduct.values()].sort((a, b) => b.cents - a.cents).slice(0, 5),
      recent: recent.map((o) => orderView(o)),
    });
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


/** Código da landing já amarrado a este produto — conta a visita de lá. */
adminRouter.get(
  '/api/products/:id/snippet',
  wrap(async (req, res) => {
    const product = await getProduct(req.params.id);
    if (!product) return res.status(404).json({ error: 'Produto não encontrado.' });

    if (!product.pixelId) {
      return res.status(422).json({
        error: 'Escolha um pixel para este produto antes de gerar o código.',
      });
    }

    const pixel = await getPixel(product.pixelId);
    if (!pixel) return res.status(422).json({ error: 'O pixel deste produto não existe mais.' });

    res.json({
      snippet: buildLandingSnippet({ pixel, checkoutUrl: config.publicUrl, product }),
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

/* ---------------- gateways de pagamento ---------------- */

adminRouter.get(
  '/api/gateways',
  wrap(async (req, res) => res.json(await getGatewaysStatus()))
);

/** Troca o gateway ativo. Só permite se ele responder com as credenciais salvas. */
adminRouter.put(
  '/api/gateways/active',
  wrap(async (req, res) => {
    const gatewayId = String(req.body?.gateway || '').trim();
    const gateway = getGateway(gatewayId);
    if (!gateway) return res.status(422).json({ error: 'Gateway desconhecido.' });

    const resolved = await getCredentials(gatewayId);
    if (!resolved) {
      return res.status(422).json({
        error: `Cadastre as credenciais da ${gateway.label} antes de ativá-la.`,
      });
    }

    // Ativar um gateway que não responde derrubaria todas as vendas de uma vez.
    try {
      await gateway.testCredentials(resolved.credentials);
    } catch (err) {
      return res.status(400).json({
        error: `A ${gateway.label} recusou as credenciais salvas: ${err.message}. Gateway não trocado.`,
      });
    }

    await setActiveGateway(gatewayId, req.admin.id);
    await audit('gateway.ativo_alterado', {
      adminId: req.admin.id,
      ip: req.ip,
      detail: { gateway: gatewayId },
    });

    res.json({ ok: true, ...(await getGatewaysStatus()) });
  })
);

/**
 * Campo secreto em branco significa "mantenha o atual" — assim dá para
 * corrigir só o Client ID sem redigitar o segredo.
 */
async function resolveFields(gateway, body) {
  const current = (await getCredentials(gateway.id))?.credentials || {};
  const values = {};
  let reusedSecret = false;

  for (const field of gateway.credentialFields) {
    const typed = String(body?.[field.key] ?? '').trim();

    if (typed) {
      values[field.key] = typed;
    } else if (field.secret && current[field.key]) {
      values[field.key] = current[field.key];
      reusedSecret = true;
    } else {
      values[field.key] = '';
    }
  }

  const missing = gateway.credentialFields.filter((f) => !values[f.key]).map((f) => f.label);

  return { values, missing, reusedSecret };
}

/** Testa credenciais sem gravar: chave errada não chega ao banco. */
adminRouter.post(
  '/api/gateways/:id/test',
  wrap(async (req, res) => {
    const gateway = getGateway(req.params.id);
    if (!gateway) return res.status(404).json({ error: 'Gateway desconhecido.' });

    const { values, missing } = await resolveFields(gateway, req.body);
    if (missing.length) {
      return res.status(422).json({ error: `Informe: ${missing.join(', ')}.` });
    }

    try {
      const account = await gateway.testCredentials(values);
      await audit('gateway.credenciais_testadas', {
        adminId: req.admin.id,
        ip: req.ip,
        detail: { gateway: gateway.id, ok: true },
      });
      res.json({ ok: true, account });
    } catch (err) {
      await audit('gateway.credenciais_testadas', {
        adminId: req.admin.id,
        ip: req.ip,
        detail: { gateway: gateway.id, ok: false },
      });
      res.status(400).json({
        error:
          err.status === 401
            ? `A ${gateway.label} recusou essas credenciais.`
            : `Não foi possível validar: ${err.message}`,
      });
    }
  })
);

adminRouter.put(
  '/api/gateways/:id/credentials',
  wrap(async (req, res) => {
    const gateway = getGateway(req.params.id);
    if (!gateway) return res.status(404).json({ error: 'Gateway desconhecido.' });

    const { values, missing, reusedSecret } = await resolveFields(gateway, req.body);
    if (missing.length) {
      return res.status(422).json({ error: `Informe: ${missing.join(', ')}.` });
    }

    // Só grava o que o gateway aceitou. Salvar chave inválida deixaria a loja
    // sem conseguir gerar PIX até alguém perceber.
    try {
      await gateway.testCredentials(values);
    } catch (err) {
      return res.status(400).json({
        error:
          err.status === 401
            ? `A ${gateway.label} recusou essas credenciais. Nada foi salvo.`
            : `Não foi possível validar: ${err.message}. Nada foi salvo.`,
      });
    }

    try {
      await saveCredentials(gateway.id, values, req.admin.id);
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }

    await audit('gateway.credenciais_alteradas', {
      adminId: req.admin.id,
      ip: req.ip,
      // Nunca registramos a credencial em si — só que ela mudou e por quem.
      detail: { gateway: gateway.id, secretTrocado: !reusedSecret },
    });

    res.json({ ok: true, ...(await getGatewaysStatus()) });
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

/* ---------------- campanhas ---------------- */

adminRouter.get(
  '/api/campaigns',
  wrap(async (req, res) => {
    const days = Math.min(90, Math.max(7, Number(req.query.days) || 14));
    const orders = await listOrdersForStats();

    res.json({
      ...buildCampaignReport(orders, { days }),
      metaUrlParams: META_URL_PARAMS,
      checkoutUrl: config.publicUrl,
    });
  })
);

/* ---------------- pixels do Meta ---------------- */

adminRouter.get(
  '/api/pixels',
  wrap(async (req, res) => {
    const { pixels, schemaReady } = await listPixels();
    const products = schemaReady ? await listProducts() : [];

    res.json({
      schemaReady,
      encryptionReady: hasEncryptionKey(),
      checkoutUrl: config.publicUrl,
      pixels: pixels.map((p) => ({
        ...p,
        // Quais produtos usam este pixel — evita apagar um que está em uso.
        products: products.filter((prod) => prod.pixelId === p.id).map((prod) => prod.name),
      })),
    });
  })
);

adminRouter.post(
  '/api/pixels',
  wrap(async (req, res) => {
    const errors = validatePixelInput(req.body);
    if (Object.keys(errors).length) {
      return res.status(422).json({ error: Object.values(errors)[0], fields: errors });
    }

    const pixel = await createPixel(req.body);
    await audit('pixel.criado', {
      adminId: req.admin.id,
      ip: req.ip,
      detail: { id: pixel.id, pixelId: pixel.pixelId },
    });

    res.status(201).json(pixel);
  })
);

adminRouter.patch(
  '/api/pixels/:id',
  wrap(async (req, res) => {
    const existing = await getPixel(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Pixel não encontrado.' });

    const errors = validatePixelInput(req.body, { partial: true });
    if (Object.keys(errors).length) {
      return res.status(422).json({ error: Object.values(errors)[0], fields: errors });
    }

    const pixel = await updatePixel(existing.id, req.body);
    await audit('pixel.editado', {
      adminId: req.admin.id,
      ip: req.ip,
      detail: { id: pixel.id, tokenTrocado: Boolean(req.body.accessToken) },
    });

    res.json(pixel);
  })
);

adminRouter.delete(
  '/api/pixels/:id',
  wrap(async (req, res) => {
    const existing = await getPixel(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Pixel não encontrado.' });

    // Produto aponta para o pixel; apagar com ON DELETE SET NULL só zera a
    // referência, mas o dono precisa saber que vai parar de rastrear.
    const emUso = (await listProducts()).filter((p) => p.pixelId === existing.id);
    if (emUso.length && req.query.force !== 'sim') {
      return res.status(409).json({
        error:
          `Este pixel está em ${emUso.length} produto(s): ${emUso.map((p) => p.name).join(', ')}. ` +
          'Eles ficarão sem rastreamento.',
        needsConfirm: true,
      });
    }

    await deletePixel(existing.id);
    await audit('pixel.excluido', { adminId: req.admin.id, ip: req.ip, detail: { id: existing.id } });

    res.json({ ok: true });
  })
);

/** Dispara um PageView de teste — valida pixel + token de verdade. */
adminRouter.post(
  '/api/pixels/:id/test',
  wrap(async (req, res) => {
    const pixel = await getPixelWithToken(req.params.id);
    if (!pixel) return res.status(404).json({ error: 'Pixel não encontrado ou inativo.' });

    const token = String(req.body?.accessToken || '').trim() || pixel.accessToken;
    if (!token) {
      return res.status(422).json({
        error:
          'Sem token da Conversions API não dá para testar — e sem ele a nota do evento ' +
          'não passa de 6 a 7, porque e-mail e telefone só existem no servidor.',
      });
    }

    try {
      const result = await testPixelCredentials({
        pixelId: pixel.pixelId,
        accessToken: token,
        testEventCode: req.body?.testEventCode || pixel.testEventCode,
      });

      await audit('pixel.testado', { adminId: req.admin.id, ip: req.ip, detail: { id: pixel.id, ok: true } });
      res.json({ ok: true, ...result });
    } catch (err) {
      await audit('pixel.testado', { adminId: req.admin.id, ip: req.ip, detail: { id: pixel.id, ok: false } });
      res.status(400).json({ error: err.message });
    }
  })
);

/** Código que substitui o pixel do Meta na landing page. */
adminRouter.get(
  '/api/pixels/:id/snippet',
  wrap(async (req, res) => {
    const pixel = await getPixel(req.params.id);
    if (!pixel) return res.status(404).json({ error: 'Pixel não encontrado.' });

    res.json({
      snippet: buildLandingSnippet({ pixel, checkoutUrl: config.publicUrl }),
      checkoutUrl: config.publicUrl,
    });
  })
);

/* ---------------- auditoria ---------------- */

adminRouter.get(
  '/api/audit',
  wrap(async (req, res) => res.json(await listAudit(200)))
);

/* Qualquer outro caminho sob o prefixo secreto responde 404 seco. */
adminRouter.use((req, res) => res.status(404).end());
