import { decryptSecret, encryptSecret, hasEncryptionKey } from './crypto-utils.js';
import { dbDelete, dbInsert, dbSelect, dbSelectOne, dbUpdate } from './supabase.js';

/**
 * Biblioteca de pixels do Meta.
 *
 * O mesmo pixel pode servir varios produtos, e um produto novo pode ter o
 * seu. O `pixel_id` nao e segredo (aparece no HTML da landing); o token da
 * Conversions API e, e vai cifrado no banco.
 */

const isMissingSchema = (err) =>
  /schema cache|does not exist|PGRST205|PGRST204|pixels/i.test(err?.message || '');

const fromRow = (row) =>
  row && {
    id: row.id,
    name: row.name,
    pixelId: row.pixel_id,
    testEventCode: row.test_event_code || '',
    hasToken: Boolean(row.access_token),
    active: row.active,
    lastEventAt: row.last_event_at,
    lastEventStatus: row.last_event_status,
    createdAt: row.created_at,
  };

export async function listPixels() {
  try {
    const rows = await dbSelect('pixels', { order: 'created_at.asc' });
    return { pixels: rows.map(fromRow), schemaReady: true };
  } catch (err) {
    if (!isMissingSchema(err)) throw err;
    return { pixels: [], schemaReady: false };
  }
}

export async function getPixel(id) {
  if (!id) return null;
  return fromRow(await dbSelectOne('pixels', { filters: { id: `eq.${id}` } }));
}

/** Pixel pronto para uso, já com o token decifrado. Só para uso interno. */
export async function getPixelWithToken(id) {
  if (!id) return null;

  const row = await dbSelectOne('pixels', { filters: { id: `eq.${id}` } });
  if (!row || !row.active) return null;

  let accessToken = null;
  if (row.access_token && hasEncryptionKey()) {
    try {
      accessToken = decryptSecret(row.access_token);
    } catch (err) {
      console.error(`[pixel] falha ao decifrar o token de ${row.name}:`, err.message);
    }
  }

  return {
    id: row.id,
    name: row.name,
    pixelId: row.pixel_id,
    accessToken,
    testEventCode: row.test_event_code || null,
  };
}

function requireEncryption() {
  if (!hasEncryptionKey()) {
    const erro = new Error(
      'APP_ENCRYPTION_KEY não configurada. Sem ela o token da Conversions API ' +
        'seria gravado em texto claro no banco, então a gravação foi recusada.'
    );
    erro.status = 500;
    throw erro;
  }
}

export async function createPixel({ name, pixelId, accessToken, testEventCode }) {
  requireEncryption();

  const row = await dbInsert('pixels', {
    name: String(name).trim(),
    pixel_id: String(pixelId).trim(),
    access_token: accessToken ? encryptSecret(String(accessToken).trim()) : null,
    test_event_code: String(testEventCode || '').trim() || null,
    active: true,
  });

  return fromRow(row);
}

export async function updatePixel(id, patch) {
  const row = {};

  if (patch.name !== undefined) row.name = String(patch.name).trim();
  if (patch.pixelId !== undefined) row.pixel_id = String(patch.pixelId).trim();
  if (patch.testEventCode !== undefined) {
    row.test_event_code = String(patch.testEventCode).trim() || null;
  }
  if (patch.active !== undefined) row.active = Boolean(patch.active);

  // Token em branco significa "mantenha o atual".
  if (patch.accessToken) {
    requireEncryption();
    row.access_token = encryptSecret(String(patch.accessToken).trim());
  }

  row.updated_at = new Date().toISOString();

  return fromRow(await dbUpdate('pixels', { id: `eq.${id}` }, row));
}

export async function deletePixel(id) {
  await dbDelete('pixels', { id: `eq.${id}` });
}

/** Registra o resultado do último envio, para o painel mostrar saúde. */
export async function markPixelEvent(id, status) {
  try {
    await dbUpdate(
      'pixels',
      { id: `eq.${id}` },
      { last_event_at: new Date().toISOString(), last_event_status: String(status).slice(0, 120) }
    );
  } catch {
    // Diagnóstico não pode atrapalhar a venda.
  }
}

export function validatePixelInput(body = {}, { partial = false } = {}) {
  const errors = {};
  const has = (f) => body[f] !== undefined && body[f] !== null;

  if (!partial || has('name')) {
    const name = String(body.name || '').trim();
    if (name.length < 2 || name.length > 60) errors.name = 'Nome deve ter entre 2 e 60 caracteres.';
  }

  if (!partial || has('pixelId')) {
    const id = String(body.pixelId || '').replace(/\D/g, '');
    if (!/^[0-9]{8,20}$/.test(id)) {
      errors.pixelId = 'O ID do pixel é numérico, com 8 a 20 dígitos.';
    }
  }

  if (has('accessToken') && String(body.accessToken).trim()) {
    const token = String(body.accessToken).trim();
    // Token do Meta é longo; um ID de pixel colado aqui por engano seria curto.
    if (token.length < 40) {
      errors.accessToken =
        'Isso não parece um token da Conversions API. Ele é longo (100+ caracteres) e ' +
        'sai em Eventos Manager → Configurações → Gerar token de acesso.';
    }
  }

  if (has('testEventCode') && String(body.testEventCode).trim()) {
    if (!/^TEST\d+$/i.test(String(body.testEventCode).trim())) {
      errors.testEventCode = 'O código de teste tem o formato TEST12345.';
    }
  }

  return errors;
}
