import { Router } from 'express';

import { isValidCep } from '../cep.js';
import { config } from '../config.js';
import { GatewayError } from '../gateways/index.js';
import { publicOrder, syncOrderWithGateway } from '../orders.js';
import { defaultProductId, formatBRL, getActiveProduct } from '../products.js';
import { rateLimit } from '../rate-limit.js';
import { getActiveGateway } from '../settings.js';
import { getPixel } from '../pixels.js';
import { createOrder, getOrder, linkGatewayId, recordPageView, updateOrder } from '../store.js';
import { eventIdFor, extractTracking, trackEvent } from '../tracking.js';
import { validateCheckoutPayload } from '../validators.js';

/** ID numérico do pixel — não é segredo, o navegador precisa dele. */
async function getPixelPublicId(id) {
  try {
    const pixel = await getPixel(id);
    return pixel?.active ? pixel.pixelId : null;
  } catch {
    return null;
  }
}

export const checkoutRouter = Router();

const createLimiter = rateLimit({
  scope: 'pix',
  windowMs: 60_000,
  max: 8,
  message: 'Você gerou muitos PIX seguidos. Aguarde um minuto e tente novamente.',
});

const statusLimiter = rateLimit({ scope: 'status', windowMs: 60_000, max: 90 });

// Limite alto: uma pessoa pode abrir várias ofertas. Serve só para conter
// bot que tentaria inflar o topo do funil.
const viewLimiter = rateLimit({ scope: 'view', windowMs: 60_000, max: 30 });

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
      // ID numérico do pixel: o navegador precisa dele para o PageView.
      // Não é segredo — já aparece no HTML da landing.
      pixelId: product.pixelId ? await getPixelPublicId(product.pixelId) : null,
      headline: product.checkout.headline,
      showSecuritySeal: product.checkout.showSecuritySeal,
      askZip: product.checkout.askZip,
      // Textos da tela de confirmação. Vazio faz o front usar o padrão.
      success: product.success,
      methods: {
        pix: product.checkout.methods.pix,
        // Nenhum gateway integrado processa cartão. Se o produto habilita,
        // o método aparece marcado como indisponível — a flag abaixo evita
        // que o front prometa algo que o backend não consegue cumprir.
        card: product.checkout.methods.card,
        cardSupported: false,
      },
    });
  } catch (err) {
    next(err);
  }
});

/**
 * Registra a visita na página. Topo do funil.
 * Responde 204 sempre: se o contador falhar, o comprador nem fica sabendo.
 */
checkoutRouter.post('/view', viewLimiter, async (req, res) => {
  res.status(204).end();

  try {
    const productId = String(req.body?.productId || '').slice(0, 80);
    const sessionId = String(req.body?.sessionId || '').slice(0, 60);
    if (!productId || !sessionId) return;

    await recordPageView({
      productId,
      sessionId,
      tracking: extractTracking(req.body, req),
    });
  } catch {
    // Silêncio proposital: já respondemos, e visita não vale um log de erro.
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

    // CEP so e exigido quando o produto pede. Campo a mais custa conversao,
    // entao a troca e escolha do dono da oferta.
    const zip = String(req.body?.zip || '').replace(/[^0-9]/g, '');
    if (product.checkout.askZip && !isValidCep(zip)) {
      errors.zip = 'Informe um CEP válido (8 dígitos).';
    }

    if (Object.keys(errors).length) {
      return res.status(422).json({ error: 'Revise os dados informados.', fields: errors });
    }

    // Resolve o gateway ANTES de criar o pedido: sem credencial não adianta
    // gravar uma linha que nunca vai virar cobrança.
    const { gateway, credentials } = await getActiveGateway();

    // O preco vem do catalogo no banco, nunca do corpo da requisicao.
    const amountCents = product.priceCents;

    // Identificadores de atribuição vindos da landing pela URL: cookie não
    // atravessa domínio, então eles chegam no corpo da requisição.
    const tracking = extractTracking(req.body, req);

    order = await createOrder({
      product,
      customer: data,
      amountCents,
      gateway: gateway.id,
      tracking,
      zip: zip || null,
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

    // InitiateCheckout pelo servidor, com e-mail e telefone já preenchidos —
    // sinais que o pixel do navegador sozinho não teria neste momento.
    trackEvent({ order, product, eventName: 'InitiateCheckout' }).catch(() => {});

    res.status(201).json({
      ...publicOrder(order),
      // O navegador dispara o mesmo evento com este id; o Meta deduplica.
      tracking: {
        pixelId: product.pixelId ? (await getPixelPublicId(product.pixelId)) : null,
        initiateEventId: eventIdFor(order.id, 'InitiateCheckout'),
        purchaseEventId: eventIdFor(order.id, 'Purchase'),
      },
    });
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
