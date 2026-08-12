import { decryptSecret, encryptSecret, hasEncryptionKey } from './crypto-utils.js';
import { DEFAULT_GATEWAY, getGateway, isValidGateway, listGateways } from './gateways/index.js';
import { dbDelete, dbSelect, dbUpsert } from './supabase.js';

/**
 * Configuracoes editaveis pelo painel: gateway ativo e credenciais de cada um.
 *
 * As credenciais ficam em `settings`, uma linha por campo:
 *   gateway.active              -> value: 'misticpay' | 'syncpay'
 *   gateway.misticpay.ci        -> value  (nao sensivel)
 *   gateway.misticpay.cs        -> secret (AES-256-GCM)
 *   gateway.syncpay.client_id   -> value
 *   gateway.syncpay.client_secret -> secret
 *
 * Precedencia: banco vence .env. As variaveis de ambiente sao apenas o valor
 * inicial, para o primeiro deploy funcionar antes de alguem abrir o painel.
 */

const ACTIVE_KEY = 'gateway.active';
const credKey = (gatewayId, field) => `gateway.${gatewayId}.${field}`;

/**
 * Chave usada pela versao de um gateway so ("misticpay.ci"), antes do prefixo
 * "gateway.". A migracao 003 renomeia no banco; este fallback cobre a janela
 * entre o deploy do codigo novo e a execucao da migracao, para as vendas nao
 * pararem nesse intervalo.
 */
const legacyKey = (gatewayId, field) =>
  gatewayId === 'misticpay' ? `misticpay.${field}` : null;

const rowFor = (byKey, gatewayId, field) =>
  byKey[credKey(gatewayId, field)] || byKey[legacyKey(gatewayId, field)] || null;

/** Detecta a tabela/coluna ainda nao criada, para dar mensagem util. */
const isMissingSchema = (err) =>
  /schema cache|does not exist|PGRST205|PGRST204/i.test(err?.message || '');

/* ============================================================
   Cache por instancia, curto
   ============================================================ */

const CACHE_TTL_MS = 30_000;
let cache = { at: 0, value: null };

export function invalidateSettingsCache() {
  cache = { at: 0, value: null };
}

async function loadAll() {
  if (cache.at && Date.now() - cache.at < CACHE_TTL_MS) return cache.value;

  let rows = [];
  let schemaReady = true;

  try {
    rows = await dbSelect('settings', {});
  } catch (err) {
    if (!isMissingSchema(err)) throw err;
    schemaReady = false;
  }

  const byKey = Object.fromEntries(rows.map((row) => [row.key, row]));
  const value = { byKey, schemaReady };

  cache = { at: Date.now(), value };
  return value;
}

/* ============================================================
   Gateway ativo
   ============================================================ */

export async function getActiveGatewayId() {
  const { byKey } = await loadAll();
  const stored = byKey[ACTIVE_KEY]?.value;
  return isValidGateway(stored) ? stored : DEFAULT_GATEWAY;
}

export async function setActiveGateway(gatewayId, adminId) {
  if (!isValidGateway(gatewayId)) throw new Error('Gateway desconhecido.');

  await dbUpsert(
    'settings',
    {
      key: ACTIVE_KEY,
      value: gatewayId,
      secret: null,
      updated_at: new Date().toISOString(),
      updated_by: adminId,
    },
    { onConflict: 'key' }
  );

  invalidateSettingsCache();
}

/* ============================================================
   Credenciais por gateway
   ============================================================ */

/**
 * Credenciais em vigor para um gateway.
 * Devolve null se nenhum campo obrigatorio estiver preenchido.
 */
export async function getCredentials(gatewayId) {
  const gateway = getGateway(gatewayId);
  if (!gateway) return null;

  const { byKey } = await loadAll();
  const credentials = {};
  let complete = true;

  for (const field of gateway.credentialFields) {
    const row = rowFor(byKey, gatewayId, field.key);

    let value = null;
    if (field.secret) {
      if (row?.secret && hasEncryptionKey()) {
        try {
          value = decryptSecret(row.secret);
        } catch (err) {
          console.error(`[config] falha ao decifrar ${gatewayId}.${field.key}:`, err.message);
        }
      }
    } else {
      value = row?.value || null;
    }

    if (!value) complete = false;
    credentials[field.key] = value;
  }

  if (complete) return { credentials, source: 'painel' };

  // Nada no banco: cai para o .env, se o gateway souber ler de la.
  const fromEnv = gateway.envCredentials();
  if (fromEnv) return { credentials: fromEnv, source: 'ambiente' };

  return null;
}

/** Credenciais do gateway ATIVO — usado pelo checkout. */
export async function getActiveGateway() {
  const gatewayId = await getActiveGatewayId();
  const gateway = getGateway(gatewayId);
  const resolved = await getCredentials(gatewayId);

  if (!resolved) {
    const erro = new Error(
      `O gateway ${gateway.label} está selecionado mas não tem credenciais configuradas. ` +
        'Cadastre-as no painel, aba Configurações.'
    );
    erro.status = 503;
    throw erro;
  }

  return { gateway, credentials: resolved.credentials, source: resolved.source };
}

/** Gateway de um pedido já criado — pode não ser o ativo hoje. */
export async function getGatewayForOrder(order) {
  const gatewayId = order.gateway || DEFAULT_GATEWAY;
  const gateway = getGateway(gatewayId);
  if (!gateway) return null;

  const resolved = await getCredentials(gatewayId);
  if (!resolved) return null;

  return { gateway, credentials: resolved.credentials };
}

export async function saveCredentials(gatewayId, values, adminId) {
  const gateway = getGateway(gatewayId);
  if (!gateway) throw new Error('Gateway desconhecido.');

  if (!hasEncryptionKey()) {
    throw new Error(
      'APP_ENCRYPTION_KEY não configurada no servidor. Sem ela os segredos seriam ' +
        'gravados em texto claro no banco, então a gravação foi recusada.'
    );
  }

  const now = new Date().toISOString();

  const rows = gateway.credentialFields.map((field) => ({
    key: credKey(gatewayId, field.key),
    value: field.secret ? null : String(values[field.key]).trim(),
    secret: field.secret ? encryptSecret(String(values[field.key]).trim()) : null,
    updated_at: now,
    updated_by: adminId,
  }));

  await dbUpsert('settings', rows, { onConflict: 'key' });
  invalidateSettingsCache();
}

export async function clearCredentials(gatewayId) {
  const gateway = getGateway(gatewayId);
  if (!gateway) throw new Error('Gateway desconhecido.');

  for (const field of gateway.credentialFields) {
    await dbDelete('settings', { key: `eq.${credKey(gatewayId, field.key)}` });
  }
  invalidateSettingsCache();
}

/* ============================================================
   Visao para o painel — nunca devolve segredo
   ============================================================ */

export async function getGatewaysStatus() {
  const { byKey, schemaReady } = await loadAll();
  const activeId = await getActiveGatewayId();

  const gateways = listGateways().map((info) => {
    const resolved = byKey;
    const fields = info.credentialFields.map((field) => {
      const row = rowFor(resolved, info.id, field.key);
      return {
        key: field.key,
        label: field.label,
        hint: field.hint || null,
        secret: field.secret,
        // Campo nao sensivel volta preenchido; o segredo so informa se existe.
        value: field.secret ? null : row?.value || null,
        configured: field.secret ? Boolean(row?.secret) : Boolean(row?.value),
      };
    });

    const updatedAt = info.credentialFields
      .map((f) => rowFor(resolved, info.id, f.key)?.updated_at)
      .filter(Boolean)
      .sort()
      .pop();

    return {
      id: info.id,
      label: info.label,
      docsUrl: info.docsUrl,
      active: info.id === activeId,
      fields,
      configured: fields.every((f) => f.configured),
      updatedAt: updatedAt || null,
    };
  });

  return {
    activeGateway: activeId,
    gateways,
    encryptionReady: hasEncryptionKey(),
    schemaReady,
  };
}
