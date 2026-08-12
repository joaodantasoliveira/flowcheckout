import 'dotenv/config';

/**
 * Em serverless nao dava para chamar process.exit aqui: a funcao morria na
 * inicializacao e a Vercel devolvia apenas "FUNCTION_INVOCATION_FAILED",
 * sem dizer qual variavel faltava. Agora acumulamos os problemas e deixamos
 * o app responder 503 com um diagnostico legivel.
 */
const problems = [];

function required(name, hint = '') {
  const value = process.env[name];
  if (!value || /^(seu_|troque|sua_)/i.test(value)) {
    problems.push({ name, hint });
    return null;
  }
  return value;
}

/** Valor que pode faltar: placeholders do .env.example contam como ausentes. */
function optional(name) {
  const value = process.env[name];
  if (!value || /^(seu_|troque|sua_|demo_)/i.test(value)) return null;
  return value;
}

function normalizeAdminPath(value) {
  // Ausente ja foi registrado por required(); nao duplica o erro.
  if (!value) return '/__configuracao_ausente__';

  const clean = `/${String(value).trim().replace(/^\/+|\/+$/g, '')}`;
  if (!/^\/[A-Za-z0-9_-]{6,}$/.test(clean)) {
    problems.push({
      name: 'ADMIN_PATH',
      hint: 'Precisa de ao menos 6 caracteres (letras, números, - ou _). Gere: npm run gen:path',
    });
    return '/__configuracao_ausente__';
  }
  return clean;
}

/**
 * A chave publishable (sb_publishable_ / anon) e feita para o browser e
 * respeita RLS. Como o schema tranca tudo com RLS sem policy, usar ela aqui
 * faria a aplicacao inteira falhar em silencio. Pior: se alguem "resolvesse"
 * o problema desligando o RLS, os dados dos compradores e os hashes de senha
 * ficariam legiveis por qualquer um com a chave — que esta publica.
 */
function validateSecretKey(key) {
  if (!key) return null;

  const looksPublishable = /^sb_publishable_/.test(key) || /"role"\s*:\s*"anon"/.test(atobSafe(key));

  if (looksPublishable) {
    problems.push({
      name: 'SUPABASE_SECRET_KEY',
      hint:
        'Recebeu a chave PÚBLICA (publishable/anon). Ela respeita RLS e não lê nada. ' +
        'Use a chave secreta: Supabase → Project Settings → API Keys → secret (service_role).',
    });
    return null;
  }
  return key;
}

/** Le o payload de um JWT sem validar assinatura — so para detectar o papel. */
function atobSafe(token) {
  try {
    return Buffer.from(String(token).split('.')[1] || '', 'base64').toString('utf8');
  } catch {
    return '';
  }
}

const publicUrl = (process.env.PUBLIC_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/$/, '');

export const config = {
  port: Number(process.env.PORT || 3000),
  publicUrl,
  isProduction: process.env.NODE_ENV === 'production' || Boolean(process.env.VERCEL),

  supabase: {
    url: (required('SUPABASE_URL') || '').replace(/\/$/, ''),
    secretKey: validateSecretKey(
      required(
        'SUPABASE_SECRET_KEY',
        'Use a chave SECRETA (service_role), nunca a publishable.'
      )
    ),
  },

  // As credenciais da MisticPay agora sao editaveis pelo painel e ficam
  // cifradas no banco. O .env vira apenas o valor inicial — util no primeiro
  // deploy, antes de alguem abrir o painel. O banco sempre tem precedencia.
  misticpay: {
    baseUrl: (process.env.MISTICPAY_BASE_URL || 'https://api.misticpay.com/api').replace(/\/$/, ''),
    ci: optional('MISTICPAY_CI'),
    cs: optional('MISTICPAY_CS'),
  },

  webhookToken: required('WEBHOOK_TOKEN', 'Gere um: npm run gen:secret'),

  admin: {
    path: normalizeAdminPath(required('ADMIN_PATH', 'Gere um: npm run gen:path')),
    host: process.env.ADMIN_HOST ? process.env.ADMIN_HOST.trim().toLowerCase() : null,
    ipAllowlist: (process.env.ADMIN_IP_ALLOWLIST || '')
      .split(',')
      .map((ip) => ip.trim().replace(/^::ffff:/, ''))
      .filter(Boolean),
    cookieSecure: !/^http:\/\/(localhost|127\.)/.test(publicUrl),
  },

  // Segredo do cron da Vercel (limpeza periodica). Opcional em dev.
  cronSecret: process.env.CRON_SECRET || null,

  split: {
    user: process.env.SPLIT_USER || null,
    tax: process.env.SPLIT_TAX ? Number(process.env.SPLIT_TAX) : null,
  },

  pixTtlSeconds: 30 * 60,
  minGatewayPollMs: 4000,

  // Preenchido logo abaixo.
  problems: [],
};

config.problems = problems;

if (problems.length) {
  const lista = problems.map((p) => `  - ${p.name}${p.hint ? `\n      ${p.hint}` : ''}`).join('\n');

  console.error(
    `\n[config] ${problems.length} variável(is) de ambiente pendente(s):\n${lista}\n\n` +
      '         Local: preencha o .env (copie de .env.example).\n' +
      '         Vercel: Settings -> Environment Variables, depois REDEPLOY.\n'
  );

  // Local: falha rápido, o desenvolvedor está olhando o terminal.
  // Serverless: seguir em frente para o app conseguir responder 503 com o
  // diagnóstico. Morrer aqui só produziria FUNCTION_INVOCATION_FAILED.
  if (!config.isProduction) process.exit(1);
}
