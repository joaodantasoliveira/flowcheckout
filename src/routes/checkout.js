import { Router } from 'express';

import { config } from '../config.js';
import { GatewayError } from '../gateways/index.js';
import { publicOrder, syncOrderWithGateway } from '../orders.js';
import { defaultProductId, formatBRL, getActiveProduct } from '../products.js';
import { rateLimit } from '../rate-limit.js';
import { getActiveGateway } from '../settings.js';
import { createOrder, getOrder, linkGatewayId, updateOrder } from '../store.js';
import { validateCheckoutPayload } from '../validators.js';

export const checkoutRouter = Router();

const createLimiter = rateLimit({
  scope: 'pix',
  windowMs: 60_000,
  max: 8,
  message: 'Você gerou muitos PIX seguidos. Aguarde um minuto e tente novamente.',
});

const statusLimiter = rateLimit({ scope: 'status', windowMs: 60_000, max: 90 });

/** Dados do produto para montar o resumo do pedido na tela. */
checkoutRouter.get('/product', async (req, res, next) => {
  try {
    const product = await getActiveProduct(req.query.id || (await defaultProductId()));
    if (!product) return res.status(404).json({ error: 'Produto não encontrado.' });

    res.json({
      id: product.id,
      name: product.name,
      subtitle: product.subtitle,
      image: product.image,
      amountCents: product.priceCents,
      amountFormatted: formatBRL(product.priceCents),
      maxInstallments: product.maxInstallments,
      // Ambos os gateways integrados processam apenas PIX.
      methods: { pix: true, card: false },
    });
  } catch (err) {
    next(err);
  }
});

/** Gera a cobranca PIX no gateway ativo. */
checkoutRouter.post('/pix', createLimiter, async (req, res, next) => {
  let order = null;

  try {
    // getActiveProduct: produto desativado no painel para de vender na hora.
    const product = await getActiveProduct(req.body?.productId || (await defaultProductId()));
    if (!product) return res.status(404).json({ error: 'Produto não encontrado.' });

    const { errors, data } = validateCheckoutPayload(req.body);
    if (Object.keys(errors).length) {
      return res.status(422).json({ error: 'Revise os dados informados.', fields: errors });
    }

    // Resolve o gateway ANTES de criar o pedido: sem credencial não adianta
    // gravar uma linha que nunca vai virar cobrança.
    const { gateway, credentials } = await getActiveGateway();

    // O preco vem do catalogo no banco, nunca do corpo da requisicao.
    const amountCents = product.priceCents;

    order = await createOrder({
      product,
      customer: data,
      amountCents,
      gateway: gateway.id,
      ip: req.ip,
      userAgent: req.get('user-agent') || null,
    });

    const charge = await gateway.createPixCharge(credentials, {
      amountCents,
      customer: data,
      reference: order.reference,
      description: `${product.name} - pedido ${order.id}`,
      webhookUrl: `${config.publicUrl}/api/webhooks/${gateway.id}/${config.webhookToken}`,
    });

    await linkGatewayId(order, charge.gatewayTransactionId);
    order = await updateOrder(order, {
      pix: {
        qrCodeBase64: charge.qrCodeBase64,
        qrcodeUrl: charge.qrcodeUrl,
        copyPaste: charge.copyPaste,
        expiresAt: Date.now() + config.pixTtlSeconds * 1000,
      },
    });

    console.log(
      `[pedido] criado id=${order.id} gateway=${gateway.id}:${charge.gatewayTransactionId} ` +
        `valor=${(amountCents / 100).toFixed(2)}`
    );

    res.status(201).json(publicOrder(order));
  } catch (err) {
    if (order) await updateOrder(order, { status: 'FALHA' }).catch(() => {});

    // Gateway sem credencial configurada: erro de operação, não do cliente.
    if (err.status === 503) {
      console.error('[pedido] gateway não configurado:', err.message);
      return res.status(503).json({
        error: 'Pagamento indisponível no momento. Tente novamente em instantes.',
      });
    }

    if (!(err instanceof GatewayError)) return next(err);

    console.error('[pedido] falha ao gerar PIX:', err.message, err.body || '');

    res.status(err.status === 401 ? 500 : 502).json({
      error:
        err.status >= 400 && err.status < 500 && err.status !== 401
          ? err.message
          : 'Não foi possível gerar o PIX agora. Tente novamente em instantes.',
    });
  }
});

/** Consulta de status usada pelo polling do front. */
checkoutRouter.get('/:orderId/status', statusLimiter, async (req, res, next) => {
  try {
    const order = await getOrder(req.params.orderId);
    if (!order) return res.status(404).json({ error: 'Pedido não encontrado.' });

    const synced = await syncOrderWithGateway(order);
    res.json(publicOrder(synced));
  } catch (err) {
    next(err);
  }
});
