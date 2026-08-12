import { dbRpc } from './supabase.js';

const normalizeIp = (ip) => String(ip || 'desconhecido').replace(/^::ffff:/, '');

/**
 * Rate limit por IP, contado no BANCO.
 *
 * Em serverless nao existe memoria compartilhada entre invocacoes: um Map
 * local daria ao atacante tantas tentativas quantas instancias a plataforma
 * resolvesse criar. A contagem vive numa funcao SQL atomica (bump_rate_limit),
 * entao duas requisicoes simultaneas nao conseguem furar o mesmo limite.
 */
export function rateLimit({ windowMs, max, scope, message = 'Muitas requisições. Aguarde um instante.' }) {
  return async (req, res, next) => {
    const key = `${scope}:${normalizeIp(req.ip)}`;

    try {
      const result = await dbRpc('bump_rate_limit', {
        p_key: key,
        p_window_ms: windowMs,
        p_max: max,
      });

      const row = Array.isArray(result) ? result[0] : result;

      if (row && row.allowed === false) {
        res.set('Retry-After', String(row.retry_after || Math.ceil(windowMs / 1000)));
        return res.status(429).json({ error: message });
      }
    } catch (err) {
      // Banco fora do ar: deixa passar em vez de derrubar o checkout inteiro.
      // As demais defesas (validacao, preco no servidor, auth) seguem de pe.
      console.error('[rate-limit] indisponível, liberando requisição:', err.message);
    }

    next();
  };
}
