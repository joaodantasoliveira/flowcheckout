import { config } from './config.js';
import { decryptSecret, encryptSecret, hasEncryptionKey } from './crypto-utils.js';
import { dbSelect, dbUpsert } from './supabase.js';

/**
 * Configuracoes editaveis pelo painel — hoje, as credenciais da MisticPay.
 *
 * Precedencia: o que esta no BANCO vence o que esta no .env. As variaveis de
 * ambiente viram apenas o valor inicial, para a aplicacao funcionar antes de
 * alguem abrir o painel pela primeira vez.
 */

const KEYS = {
  ci: 'misticpay.ci',
  cs: 'misticpay.cs',
};

/**
 * Cache por instancia, curto.
 *
 * Sem ele, toda chamada ao gateway faria uma ida extra ao banco. Com TTL de
 * 30s, trocar a credencial no painel leva ate 30s para valer em instancias
 * ja aquecidas da Vercel — aceitavel para uma operacao rara, e o teste de
 * conexao no painel usa os valores enviados, nao o cache.
 */
const CACHE_TTL_MS = 30_000;
let cache = { at: 0, ci: null, cs: null, source: null };

export function invalidateSettingsCache() {
  cache = { at: 0, ci: null, cs: null, source: null };
}

async function loadFromDatabase() {
  const rows = await dbSelect('settings', {
    filters: { key: `in.(${KEYS.ci},${KEYS.cs})` },
  });

  const byKey = Object.fromEntries(rows.map((row) => [row.key, row]));
  const ciRow = byKey[KEYS.ci];
  const csRow = byKey[KEYS.cs];

  if (!ciRow?.value || !csRow?.secret) return null;

  return {
    ci: ciRow.value,
    cs: decryptSecret(csRow.secret),
    updatedAt: csRow.updated_at || ciRow.updated_at,
  };
}

/** Credenciais em vigor. Usado por todas as chamadas ao gateway. */
export async function getGatewayCredentials() {
  if (cache.at && Date.now() - cache.at < CACHE_TTL_MS) {
    return { ci: cache.ci, cs: cache.cs, source: cache.source };
  }

  let resolved = null;

  if (hasEncryptionKey()) {
    try {
      resolved = await loadFromDatabase();
    } catch (err) {
      console.error('[config] falha ao ler credenciais do banco:', err.message);
    }
  }

  const source = resolved ? 'painel' : 'ambiente';
  const ci = resolved?.ci || config.misticpay.ci;
  const cs = resolved?.cs || config.misticpay.cs;

  cache = { at: Date.now(), ci, cs, source };
  return { ci, cs, source };
}

/** Detecta a tabela ainda nao criada, para dar uma mensagem util no painel. */
const isMissingTable = (err) => /schema cache|does not exist|PGRST205/i.test(err?.message || '');

/** Estado das credenciais para exibir no painel — nunca devolve o secret. */
export async function getGatewayStatus() {
  let byKey = {};
  let tableReady = true;

  try {
    const rows = await dbSelect('settings', { filters: { key: `in.(${KEYS.ci},${KEYS.cs})` } });
    byKey = Object.fromEntries(rows.map((row) => [row.key, row]));
  } catch (err) {
    if (!isMissingTable(err)) throw err;
    tableReady = false;
  }

  const { ci, source } = await getGatewayCredentials();

  return {
    ci: ci || null,
    // O client secret nunca sai do servidor. O painel so sabe se existe.
    csConfigured: Boolean(byKey[KEYS.cs]?.secret || config.misticpay.cs),
    source,
    updatedAt: byKey[KEYS.cs]?.updated_at || null,
    encryptionReady: hasEncryptionKey(),
    tableReady,
    baseUrl: config.misticpay.baseUrl,
  };
}

export async function saveGatewayCredentials({ ci, cs }, adminId) {
  if (!hasEncryptionKey()) {
    throw new Error(
      'APP_ENCRYPTION_KEY não configurada no servidor. Sem ela o client secret ' +
        'seria gravado em texto claro no banco, então a gravação foi recusada.'
    );
  }

  const now = new Date().toISOString();

  await dbUpsert(
    'settings',
    [
      { key: KEYS.ci, value: String(ci).trim(), secret: null, updated_at: now, updated_by: adminId },
      {
        key: KEYS.cs,
        value: null,
        secret: encryptSecret(String(cs).trim()),
        updated_at: now,
        updated_by: adminId,
      },
    ],
    { onConflict: 'key' }
  );

  invalidateSettingsCache();
}
