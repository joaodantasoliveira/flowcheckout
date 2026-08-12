import { config } from './config.js';
import { GatewayError } from './gateways/index.js';
import { getGatewayForOrder } from './settings.js';
import { getOrder, markFulfilledOnce, markOrderPaidOnce, updateOrder } from './store.js';

/**
 * A documentacao dos gateways e ambigua sobre a unidade do valor: alguns
 * devolvem reais (1.12), outros centavos (455). Aceitamos as duas leituras —
 * o vinculo forte continua sendo o transactionId, que so nos conhecemos.
 * Divergencia real vira log de alerta, nao aprovacao silenciosa.
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
    `[pedido] PAGO  id=${order.id} gateway=${order.gateway}:${order.gatewayTransactionId} ` +
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
 *
 * Usa o gateway que CRIOU o pedido, nao o ativo agora. Depois de trocar de
 * gateway no painel, as cobrancas antigas continuam sendo confirmadas no
 * lugar certo.
 *
 * Respeita `minGatewayPollMs` por pedido para nao estourar o rate limit
 * dos provedores (a MisticPay, por exemplo, permite 60 req/min por IP).
 */
export async function syncOrderWithGateway(order, { force = false } = {}) {
  if (order.paid || !order.gatewayTransactionId) return order;

  if (!force && Date.now() - order.lastGatewayPollAt < config.minGatewayPollMs) return order;

  const resolved = await getGatewayForOrder(order);
  if (!resolved) {
    console.error(
      `[consulta] pedido ${order.id}: credenciais do gateway "${order.gateway}" indisponíveis.`
    );
    return order;
  }

  await updateOrder(order, { lastGatewayPollAt: Date.now() });

  try {
    const result = await resolved.gateway.checkTransaction(
      resolved.credentials,
      order.gatewayTransactionId
    );
    if (!result?.status) return order;

    if (result.status === 'COMPLETO') {
      if (!amountMatches(result.amount, order.amountCents)) {
        console.warn(
          `[alerta] valor divergente no pedido ${order.id}: ` +
            `gateway=${result.amount} esperado=${order.amountCents} centavos. Revisar manualmente.`
        );
      }
      const paid = await markPaid(order.id, {
        endToEndId: result.endToEndId,
        source: `consulta:${order.gateway}`,
      });
      return paid || (await getOrder(order.id));
    }

    if (result.status !== order.status) {
      return await updateOrder(order, { status: result.status });
    }
  } catch (err) {
    if (err instanceof GatewayError && err.status === 429) {
      // Rate limit do gateway: recua 10s alem da janela normal.
      await updateOrder(order, { lastGatewayPollAt: Date.now() + 10000 });
    }
    console.error(`[consulta] pedido ${order.id} (${order.gateway}):`, err.message);
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
