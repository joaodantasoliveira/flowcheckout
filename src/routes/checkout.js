import { Router } from 'express';

import { config } from '../config.js';
import { createPixTransaction, MisticPayError } from '../misticpay.js';
import { publicOrder, syncOrderWithGateway } from '../orders.js';
import { defaultProductId, formatBRL, getActiveProduct } from '../products.js';
import { rateLimit } from '../rate-limit.js';
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
      // O gateway MisticPay processa apenas PIX.
      methods: { pix: true, card: false },
    });
  } catch (err) {
    next(err);
  }
});

/** Gera a cobranca PIX. */
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

    // O preco vem do catalogo no banco, nunca do corpo da requisicao.
    const amountCents = product.priceCents;

    order = await createOrder({
      product,
      customer: data,
      amountCents,
      ip: req.ip,
      userAgent: req.get('user-agent') || null,
    });

    const response = await createPixTransaction({
      amount: Number((amountCents / 100).toFixed(2)),
      payerName: data.name,
      payerDocument: data.document,
      transactionId: order.reference,
      description: `${product.name} - pedido ${order.id}`,
      projectWebhook: `${config.publicUrl}/api/webhooks/misticpay/${config.webhookToken}`,
    });

    const tx = response?.data;
    if (!tx?.transactionId || !(tx.copyPaste || tx.qrCodeBase64)) {
      throw new MisticPayError('Resposta inesperada do gateway ao gerar o PIX.', {
        status: 502,
        body: response,
      });
    }

    await linkGatewayId(order, tx.transactionId);
    order = await updateOrder(order, {
      pix: {
        qrCodeBase64: tx.qrCodeBase64 || null,
        qrcodeUrl: tx.qrcodeUrl || null,
        copyPaste: tx.copyPaste || null,
        expiresAt: Date.now() + config.pixTtlSeconds * 1000,
      },
    });

    console.log(
      `[pedido] criado id=${order.id} gateway=${tx.transactionId} valor=${(amountCents / 100).toFixed(2)}`
    );

    res.status(201).json(publicOrder(order));
  } catch (err) {
    if (order) await updateOrder(order, { status: 'FALHA' }).catch(() => {});

    const isGateway = err instanceof MisticPayError;
    console.error('[pedido] falha ao gerar PIX:', err.message, err.body || '');

    if (!isGateway) return next(err);

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
