import crypto from 'node:crypto';
import { Router } from 'express';

import { config } from '../config.js';
import { dbRpc } from '../supabase.js';

export const cronRouter = Router();

/**
 * Limpeza periodica, chamada pelo Vercel Cron (ver vercel.json).
 *
 * Em serverless nao existe setInterval confiavel: o processo morre entre
 * requisicoes. A rotina de limpeza vira um endpoint agendado.
 *
 * Remove sessoes expiradas, rascunhos de pedido abandonados (nunca pedidos
 * pagos), contadores de rate limit velhos e auditoria antiga.
 */
cronRouter.get('/cleanup', async (req, res) => {
  if (!authorized(req)) {
    console.warn('[cron] chamada não autorizada de', req.ip);
    return res.status(404).end();
  }

  try {
    const result = await dbRpc('cleanup_expired');
    const row = (Array.isArray(result) ? result[0] : result) || {};

    console.log(
      `[cron] limpeza: ${row.sessions_removed || 0} sessões, ` +
        `${row.orders_removed || 0} pedidos abandonados, ${row.rates_removed || 0} contadores.`
    );

    res.json({ ok: true, ...row });
  } catch (err) {
    console.error('[cron] falha na limpeza:', err.message);
    res.status(500).json({ error: 'Falha na limpeza.' });
  }
});

/**
 * A Vercel envia `Authorization: Bearer <CRON_SECRET>` nas chamadas agendadas.
 * Sem CRON_SECRET configurado, o endpoint so responde em desenvolvimento.
 */
function authorized(req) {
  if (!config.cronSecret) return !config.isProduction;

  const sent = String(req.get('authorization') || '').replace(/^Bearer\s+/i, '');
  const a = Buffer.from(sent);
  const b = Buffer.from(config.cronSecret);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
