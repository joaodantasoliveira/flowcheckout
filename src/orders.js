import { config } from './config.js';
import { checkTransaction, MisticPayError } from './misticpay.js';
import { getOrder, markFulfilledOnce, markOrderPaidOnce, updateOrder } from './store.js';

const VALID_STATES = new Set(['PENDENTE', 'COMPLETO', 'FALHA', 'CANCELADO']);

/**
 * A documentacao da MisticPay e ambigua sobre a unidade de `value`:
 * /transactions/check e a listagem devolvem reais (1.12), enquanto o exemplo
 * de create e o webhook mostram centavos (455). Por isso aceitamos as duas
 * leituras — o vinculo forte continua sendo o transactionId, que so nos
 * conhecemos. Divergencia real vira log de alerta, nao aprovacao silenciosa.
 */
export function amountMatches(reported, expectedCents) {
  if (reported === null || reported === undefined) return true;
  const n = Number(reported);
  if (!Number.isFinite(n)) return true;

  return Math.round(n) === expectedCents || Math.round(n * 100) === expectedCents;
}

/**
 * Marca o pedido como pago e dispara a entrega.
 *
 * Idempotente no BANCO, nao em memoria: o UPDATE so acerta linhas com
 * paid=false. Se o webhook e o polling chegarem ao mesmo tempo — coisa
 * comum, e em serverless podem estar em instancias diferentes — apenas um
 * recebe a linha de volta e apenas um entrega.
 */
export async function markPaid(orderId, { endToEndId = null, source = 'desconhecido' } = {}) {
  const order = await markOrderPaidOnce(orderId, { endToEndId });
  if (!order) return null; // ja estava pago: outra requisicao ganhou a corrida

  console.log(
    `[pedido] PAGO  id=${order.id} gateway=${order.gatewayTransactionId} ` +
      `valor=${(order.amountCents / 100).toFixed(2)} origem=${source}`
  );

  try {
    await fulfillOrder(order);
  } catch (err) {
    console.error(`[entrega] falhou para o pedido ${order.id}:`, err);
  }

  return order;
}

/**
 * ===========================================================
 *  PONTO DE EXTENSAO — o que acontece quando o PIX e pago.
 * ===========================================================
 * Libere o acesso, envie o e-mail, chame a area de membros, etc.
 * Protegido por markFulfilledOnce: roda uma unica vez por pedido, mesmo
 * com varias instancias concorrentes.
 */
async function fulfillOrder(order) {
  const first = await markFulfilledOnce(order.id);
  if (!first) return;

  console.log(
    `[entrega] liberar "${order.productName}" para ${order.customer.email} (pedido ${order.id})`
  );

  // TODO: sua regra de negocio aqui.
  // await enviarEmailDeAcesso(order);
  // await criarUsuarioNaAreaDeMembros(order);
}

/**
 * Consulta o gateway e atualiza o pedido.
 * Respeita `minGatewayPollMs` por pedido para nao estourar o rate limit
 * de 60 req/min da rota /transactions/check.
 */
export async function syncOrderWithGateway(order, { force = false } = {}) {
  if (order.paid || !order.gatewayTransactionId) return order;

  if (!force && Date.now() - order.lastGatewayPollAt < config.minGatewayPollMs) return order;

  await updateOrder(order, { lastGatewayPollAt: Date.now() });

  try {
    const response = await checkTransaction(order.gatewayTransactionId);
    const tx = response?.transaction;
    if (!tx) return order;

    const state = String(tx.transactionState || '').toUpperCase();
    if (!VALID_STATES.has(state)) return order;

    if (state === 'COMPLETO') {
      if (!amountMatches(tx.value, order.amountCents)) {
        console.warn(
          `[alerta] valor divergente no pedido ${order.id}: ` +
            `gateway=${tx.value} esperado=${order.amountCents} centavos. Revisar manualmente.`
        );
      }
      const paid = await markPaid(order.id, {
        endToEndId: tx.endToEndId || null,
        source: 'consulta',
      });
      return paid || (await getOrder(order.id));
    }

    if (state !== order.status) {
      return await updateOrder(order, { status: state });
    }
  } catch (err) {
    if (err instanceof MisticPayError && err.status === 429) {
      // Rate limit do gateway: recua 10s alem da janela normal.
      await updateOrder(order, { lastGatewayPollAt: Date.now() + 10000 });
    }
    console.error(`[consulta] pedido ${order.id}:`, err.message);
  }

  return (await getOrder(order.id)) || order;
}

/** Formato do pedido exposto ao browser — sem dados internos. */
export function publicOrder(order) {
  return {
    id: order.id,
    status: order.status,
    paid: order.paid,
    amountCents: order.amountCents,
    productName: order.productName,
    pix: order.pix
      ? {
          qrCodeBase64: order.pix.qrCodeBase64,
          qrcodeUrl: order.pix.qrcodeUrl,
          copyPaste: order.pix.copyPaste,
          expiresAt: order.pix.expiresAt,
        }
      : null,
  };
}
