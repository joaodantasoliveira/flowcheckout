import crypto from 'node:crypto';
import { Router } from 'express';

import { config } from '../config.js';
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
 * POST /api/webhooks/misticpay/:token
 *
 * A MisticPay nao documenta assinatura HMAC nos webhooks, entao usamos duas
 * defesas: (1) um token secreto no caminho da URL e (2) — o que realmente
 * importa — o corpo do webhook NUNCA aprova um pedido sozinho. Ele apenas
 * dispara uma consulta a /transactions/check, que e a fonte da verdade.
 * Assim, mesmo que alguem descubra a URL, nao consegue liberar um pedido
 * que nao foi pago de fato.
 */
webhookRouter.post('/misticpay/:token', async (req, res) => {
  if (!tokenIsValid(req.params.token)) {
    console.warn('[webhook] token inválido, origem:', req.ip);
    return res.status(404).json({ error: 'Não encontrado.' });
  }

  const payload = req.body || {};

  // Em serverless o processo pode ser congelado assim que a resposta sai,
  // entao processamos ANTES de responder. O gateway espera alguns segundos
  // a mais, mas nada se perde.
  try {
    if (payload.event === 'INFRACTION') {
      await handleInfraction(payload);
    } else {
      await handleTransaction(payload);
    }
  } catch (err) {
    console.error('[webhook] erro ao processar:', err);
  }

  res.status(200).json({ received: true });
});

async function handleTransaction(payload) {
  const gatewayId = payload.transactionId;
  if (!gatewayId) return;

  const type = String(payload.transactionType || '').toUpperCase();
  if (type && type !== 'DEPOSITO') {
    console.log(`[webhook] ${type} ${gatewayId} status=${payload.status} (ignorado no checkout)`);
    return;
  }

  const order = await getOrderByGatewayId(gatewayId);
  if (!order) {
    console.warn(`[webhook] transação ${gatewayId} sem pedido correspondente.`);
    return;
  }

  const status = String(payload.status || '').toUpperCase();
  console.log(`[webhook] pedido ${order.id} -> ${status}`);

  if (status === 'COMPLETO') {
    // Confirmacao independente antes de liberar qualquer coisa.
    await syncOrderWithGateway(order, { force: true });

    const fresh = await getOrder(order.id);
    if (!fresh?.paid) {
      console.warn(
        `[webhook] ${gatewayId} anunciou COMPLETO mas a consulta não confirmou. Pedido segue pendente.`
      );
    } else if (payload.e2e && !fresh.endToEndId) {
      await updateOrder(fresh, { endToEndId: payload.e2e });
    }
    return;
  }

  if (['FALHA', 'CANCELADO'].includes(status) && !order.paid) {
    await updateOrder(order, { status });
  }
}

/**
 * MED (Mecanismo Especial de Devolucao): contestacao de um PIX ja recebido.
 * Registre e trate manualmente — o prazo de defesa e curto.
 */
async function handleInfraction(payload) {
  const { infraction = {}, transaction = {} } = payload;

  console.warn(
    `[MED] infração ${infraction.id} status=${infraction.status} tipo=${infraction.type} ` +
      `valor=${infraction.amount} transação=${transaction.transactionId} e2e=${transaction.endToEndId}`
  );

  if (infraction.status === 'WAITING_PSP') {
    console.warn(
      `[MED] AÇÃO NECESSÁRIA: envie defesa em POST /api/meds/infractions/${infraction.id}/defense ` +
        `(uma única tentativa por infração).`
    );
  }

  const order = await getOrderByGatewayId(transaction.transactionId);
  if (!order) return;

  await updateOrder(order, {
    infraction: {
      id: infraction.id,
      status: infraction.status,
      type: infraction.type,
      amount: infraction.amount,
      analysisResult: infraction.analysisResult || null,
    },
  });
}
