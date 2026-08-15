import path from 'node:path';
import { fileURLToPath } from 'node:url';

import express from 'express';

import { adminRouter } from './admin/routes.js';
import { config } from './config.js';
import { checkoutRouter } from './routes/checkout.js';
import { cronRouter } from './routes/cron.js';
import { webhookRouter } from './routes/webhook.js';
import { checkDatabase } from './supabase.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const app = express();

// Necessario para req.ip correto atras de proxy/CDN (Vercel, Nginx, Cloudflare).
// Com isso errado, o rate limit e a allowlist de IP contam o IP do proxy —
// ou seja, param de funcionar.
app.set('trust proxy', 1);
app.disable('x-powered-by');

app.use(express.json({ limit: '32kb' }));

// navigator.sendBeacon manda text/plain para não disparar preflight de CORS.
// É como a página de vendas, em outro domínio, reporta a visita.
app.use(express.text({ limit: '8kb', type: 'text/plain' }));

app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'SAMEORIGIN',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Permissions-Policy': 'geolocation=(), microphone=(), camera=()',
  });
  if (config.isProduction) {
    res.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  next();
});

/**
 * Configuracao incompleta: responde 503 legivel em vez de deixar a funcao
 * morrer com "FUNCTION_INVOCATION_FAILED", que nao diz o que faltou.
 * Os NOMES das variaveis nao sao segredo (estao no repositorio publico);
 * os valores nunca aparecem.
 */
app.use((req, res, next) => {
  if (!config.problems.length) return next();

  const faltando = config.problems.map((p) => p.name);
  console.error('[config] requisição recusada, variáveis pendentes:', faltando.join(', '));

  res.status(503).json({
    error: 'Aplicação sem configuração completa.',
    variaveisPendentes: faltando,
    comoResolver: 'Vercel → Settings → Environment Variables, depois faça um novo deploy.',
  });
});

// O painel fica sob um prefixo secreto e responde antes de tudo.
app.use(config.admin.path, adminRouter);

app.use('/api/checkout', checkoutRouter);
app.use('/api/webhooks', webhookRouter);
app.use('/api/cron', cronRouter);

app.get('/api/health', async (req, res) => {
  const database = await checkDatabase();
  res.status(database.ok ? 200 : 503).json({
    ok: database.ok,
    database: database.ok ? 'conectado' : database.error,
  });
});

app.use(express.static(path.join(__dirname, '..', 'public'), { extensions: ['html'] }));

app.use((req, res) => res.status(404).json({ error: 'Rota não encontrada.' }));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err?.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'JSON inválido.' });
  }
  console.error('[erro nao tratado]', err);
  res.status(500).json({ error: 'Erro interno.' });
});
