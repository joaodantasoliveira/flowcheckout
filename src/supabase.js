import { config } from './config.js';

/**
 * Cliente PostgREST do Supabase.
 *
 * Escrito com fetch puro de proposito: zero dependencia, cold start menor
 * na Vercel e nenhuma surpresa de versao. A API cobre exatamente o que
 * a aplicacao usa.
 *
 * Usa SEMPRE a chave secreta (service_role), que ignora o RLS. Ela so
 * existe no servidor — nunca e enviada ao browser.
 */

export class DbError extends Error {
  constructor(message, { status = 500, body = null } = {}) {
    super(message);
    this.name = 'DbError';
    this.status = status;
    this.body = body;
  }
}

const REST = `${config.supabase.url}/rest/v1`;

const baseHeaders = () => ({
  apikey: config.supabase.secretKey,
  Authorization: `Bearer ${config.supabase.secretKey}`,
  'Content-Type': 'application/json',
});

async function request(path, { method = 'GET', body, prefer, timeoutMs = 15000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(`${REST}${path}`, {
      method,
      headers: { ...baseHeaders(), ...(prefer ? { Prefer: prefer } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });

    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }

    if (!res.ok) {
      throw new DbError(json?.message || `Banco respondeu ${res.status}`, {
        status: res.status,
        body: json,
      });
    }

    return json;
  } catch (err) {
    if (err instanceof DbError) throw err;
    throw new DbError(
      err.name === 'AbortError' ? 'Tempo esgotado ao falar com o banco.' : `Falha no banco: ${err.message}`,
      { status: 504 }
    );
  } finally {
    clearTimeout(timer);
  }
}

/** Monta a query string do PostgREST a partir de filtros simples. */
function buildQuery({ select = '*', filters = {}, order, limit, offset } = {}) {
  const params = new URLSearchParams();
  params.set('select', select);

  for (const [column, condition] of Object.entries(filters)) {
    if (condition === undefined) continue;
    // condition e "eq.valor", "gte.123", "in.(a,b)" etc.
    params.append(column, condition);
  }

  if (order) params.set('order', order);
  if (limit !== undefined) params.set('limit', String(limit));
  if (offset !== undefined) params.set('offset', String(offset));

  return params.toString();
}

export const dbSelect = (table, options) => request(`/${table}?${buildQuery(options)}`);

export async function dbSelectOne(table, options) {
  const rows = await dbSelect(table, { ...options, limit: 1 });
  return rows?.[0] || null;
}

/** SELECT com contagem total — usado na paginacao das vendas. */
export async function dbSelectWithCount(table, options) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);

  try {
    const res = await fetch(`${REST}/${table}?${buildQuery(options)}`, {
      headers: { ...baseHeaders(), Prefer: 'count=exact' },
      signal: controller.signal,
    });

    if (!res.ok) {
      throw new DbError(`Banco respondeu ${res.status}`, { status: res.status });
    }

    const rows = await res.json();
    // Content-Range vem como "0-24/137".
    const total = Number(String(res.headers.get('content-range') || '').split('/')[1]) || 0;
    return { rows, total };
  } finally {
    clearTimeout(timer);
  }
}

export async function dbInsert(table, row) {
  const rows = await request(`/${table}`, {
    method: 'POST',
    body: Array.isArray(row) ? row : [row],
    prefer: 'return=representation',
  });
  return Array.isArray(row) ? rows : rows?.[0] || null;
}

export async function dbUpsert(table, row, { onConflict } = {}) {
  const query = onConflict ? `?on_conflict=${encodeURIComponent(onConflict)}` : '';
  const rows = await request(`/${table}${query}`, {
    method: 'POST',
    body: Array.isArray(row) ? row : [row],
    prefer: 'return=representation,resolution=merge-duplicates',
  });
  return Array.isArray(row) ? rows : rows?.[0] || null;
}

export async function dbUpdate(table, filters, patch) {
  const rows = await request(`/${table}?${buildQuery({ select: '*', filters })}`, {
    method: 'PATCH',
    body: patch,
    prefer: 'return=representation',
  });
  return rows?.[0] || null;
}

export async function dbDelete(table, filters) {
  await request(`/${table}?${buildQuery({ select: 'id', filters })}`, {
    method: 'DELETE',
    prefer: 'return=minimal',
  });
}

/** Chama uma funcao SQL (as operacoes atomicas do schema). */
export const dbRpc = (fn, args = {}) =>
  request(`/rpc/${fn}`, { method: 'POST', body: args });

/** Verifica se o banco responde e se o schema foi aplicado. */
export async function checkDatabase() {
  try {
    await dbSelect('products', { select: 'id', limit: 1 });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message, status: err.status };
  }
}
