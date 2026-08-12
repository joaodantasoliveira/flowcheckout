import crypto from 'node:crypto';
import { Router } from 'express';

import { config } from '../config.js';
import { getGateway } from '../gateways/index.js';
import { syncOrderWithGateway } from '../orders.js';
import { getOrder, getOrderByGatewayId, updateOrder } from '../store.js';

export const webhookRouter = Router();

/** Comparacao em tempo constante para o token da URL. */
function tokenIsValid(received) {
  const a = Buffer.from(String(received || ''));
  const b = Buffer.from(config.webhookToken);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * POST /api/webhooks/:gateway/:token
 *
 * Nenhum gateway integrado documenta assinatura HMAC nos webhooks, entao
 * usamos duas defesas: (1) um token secreto no caminho da URL e (2) — o que
 * realmente importa — o corpo do webhook NUNCA aprova um pedido sozinho. Ele
 * apenas dispara uma consulta ao gateway, que e a fonte da verdade. Assim,
 * mesmo que alguem descubra a URL, nao consegue liberar um pedido que nao
 * foi pago de fato.
 *
 * A SyncPay corta o webhook em 5 segundos, entao respondemos primeiro e
 * processamos depois — ao contrario da MisticPay, que espera.
 */
webhookRouter.post('/:gateway/:token', async (req, res) => {
  const gateway = getGateway(req.params.gateway);

  if (!gateway || !tokenIsValid(req.params.token)) {
    console.warn(`[webhook] rejeitado (${req.params.gateway}), origem: ${req.ip}`);
    return res.status(404).json({ error: 'Não encontrado.' });
  }

  const payload = req.body || {};
  const rapido = gateway.id === 'syncpay';

  // Timeout curto do gateway: confirma o recebimento antes de processar.
  if (rapido) res.status(200).json({ received: true });

  try {
    const event = gateway.parseWebhook(payload);
    if (event) await handleEvent(gateway, event);
  } catch (err) {
    console.error(`[webhook] erro ao processar (${gateway.id}):`, err);
  }

  if (!rapido) res.status(200).json({ received: true });
});

async function handleEvent(gateway, event) {
  if (event.kind === 'infraction') return handleInfraction(event);

  const order = await getOrderByGatewayId(event.gatewayTransactionId);
  if (!order) {
    console.warn(
      `[webhook] transação ${gateway.id}:${event.gatewayTransactionId} sem pedido correspondente.`
    );
    return;
  }

  console.log(`[webhook] pedido ${order.id} -> ${event.status}`);

  if (event.status === 'COMPLETO') {
    // Confirmacao independente antes de liberar qualquer coisa.
    await syncOrderWithGateway(order, { force: true });

    const fresh = await getOrder(order.id);
    if (!fresh?.paid) {
      console.warn(
        `[webhook] ${event.gatewayTransactionId} anunciou COMPLETO mas a consulta não ` +
          'confirmou. Pedido segue pendente.'
      );
    } else if (event.endToEndId && !fresh.endToEndId) {
      await updateOrder(fresh, { endToEndId: event.endToEndId });
    }
    return;
  }

  if (['FALHA', 'CANCELADO'].includes(event.status) && !order.paid) {
    await updateOrder(order, { status: event.status });
  }
}

/**
 * MED (Mecanismo Especial de Devolucao): contestacao de um PIX ja recebido.
 * Registre e trate manualmente — o prazo de defesa e curto.
 */
async function handleInfraction(event) {
  const { infraction } = event;

  console.warn(
    `[MED] infração ${infraction.id} status=${infraction.status} tipo=${infraction.type} ` +
      `valor=${infraction.amount} transação=${event.gatewayTransactionId}`
  );

  if (infraction.status === 'WAITING_PSP') {
    console.warn(
      `[MED] AÇÃO NECESSÁRIA: envie defesa em POST /api/meds/infractions/${infraction.id}/defense ` +
        '(uma única tentativa por infração).'
    );
  }

  const order = await getOrderByGatewayId(event.gatewayTransactionId);
  if (order) await updateOrder(order, { infraction });
}
