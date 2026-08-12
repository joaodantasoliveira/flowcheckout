import { dbDelete, dbInsert, dbSelect, dbSelectOne, dbUpdate } from './supabase.js';

/**
 * Catalogo de produtos, na tabela public.products.
 *
 * O preco vive no BANCO, em centavos, e o checkout so aceita o `productId`
 * vindo do browser — nunca o valor. Isso impede que alguem adultere o preco
 * pelo devtools e gere um PIX de R$ 1,00 para um produto de R$ 6.993,00.
 */

const slugify = (text) =>
  String(text)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'produto';

/** Converte a linha do Postgres (snake_case) para o formato da aplicacao. */
const fromRow = (row) =>
  row && {
    id: row.id,
    name: row.name,
    subtitle: row.subtitle,
    image: row.image,
    priceCents: Number(row.price_cents),
    maxInstallments: row.max_installments,
    active: row.active,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };

async function uniqueId(base) {
  const existing = await dbSelect('products', { select: 'id', filters: { id: `like.${base}*` } });
  const taken = new Set(existing.map((r) => r.id));

  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}

export async function listProducts() {
  const rows = await dbSelect('products', { order: 'created_at.asc' });
  return rows.map(fromRow);
}

export async function getProduct(productId) {
  if (!productId) return null;
  return fromRow(await dbSelectOne('products', { filters: { id: `eq.${productId}` } }));
}

/** Produto desativado no painel para de vender na hora. */
export async function getActiveProduct(productId) {
  if (!productId) return null;
  return fromRow(
    await dbSelectOne('products', { filters: { id: `eq.${productId}`, active: 'eq.true' } })
  );
}

/** Produto padrao quando a URL do checkout nao traz `?produto=`. */
export async function defaultProductId() {
  const row = await dbSelectOne('products', {
    select: 'id',
    filters: { active: 'eq.true' },
    order: 'created_at.asc',
  });
  return row?.id || null;
}

export async function createProduct({ name, subtitle, priceCents, image, maxInstallments, active }) {
  const row = await dbInsert('products', {
    id: await uniqueId(slugify(name)),
    name: String(name).trim(),
    subtitle: String(subtitle || '').trim(),
    image: String(image || '').trim() || '/img/produto.svg',
    price_cents: Math.round(Number(priceCents)),
    max_installments: Math.min(12, Math.max(1, Number(maxInstallments) || 1)),
    active: active !== false,
  });
  return fromRow(row);
}

export async function updateProduct(productId, patch) {
  const row = {};
  if (patch.name !== undefined) row.name = String(patch.name).trim();
  if (patch.subtitle !== undefined) row.subtitle = String(patch.subtitle).trim();
  if (patch.image !== undefined) row.image = String(patch.image).trim() || '/img/produto.svg';
  if (patch.priceCents !== undefined) row.price_cents = Math.round(Number(patch.priceCents));
  if (patch.maxInstallments !== undefined) {
    row.max_installments = Math.min(12, Math.max(1, Number(patch.maxInstallments) || 1));
  }
  if (patch.active !== undefined) row.active = Boolean(patch.active);

  row.updated_at = new Date().toISOString();

  return fromRow(await dbUpdate('products', { id: `eq.${productId}` }, row));
}

/**
 * Produto com venda registrada nunca e apagado — so desativado.
 * Apagar quebraria o historico financeiro e os pedidos ja emitidos.
 */
export async function deleteProduct(productId) {
  const sales = await dbSelect('orders', {
    select: 'id',
    filters: { product_id: `eq.${productId}` },
    limit: 1,
  });

  if (sales.length) {
    await updateProduct(productId, { active: false });
    return { deleted: false, deactivated: true };
  }

  await dbDelete('products', { id: `eq.${productId}` });
  return { deleted: true, deactivated: false };
}

/** Validacao usada na criacao e na edicao pelo painel. */
export function validateProductInput(body = {}, { partial = false } = {}) {
  const errors = {};
  const has = (field) => body[field] !== undefined && body[field] !== null;

  if (!partial || has('name')) {
    const name = String(body.name || '').trim();
    if (name.length < 2 || name.length > 120) errors.name = 'Nome deve ter entre 2 e 120 caracteres.';
  }

  if (!partial || has('subtitle')) {
    if (String(body.subtitle || '').length > 120) errors.subtitle = 'Descrição muito longa.';
  }

  if (!partial || has('priceCents')) {
    const cents = Number(body.priceCents);
    if (!Number.isFinite(cents) || !Number.isInteger(cents)) {
      errors.priceCents = 'Preço inválido.';
    } else if (cents < 100) {
      errors.priceCents = 'Preço mínimo de R$ 1,00.';
    } else if (cents > 100_000_000) {
      errors.priceCents = 'Preço acima do limite permitido.';
    }
  }

  if (has('image')) {
    const image = String(body.image).trim();
    // Caminho local ou https. Bloqueia javascript:, data: e http em texto claro.
    if (image && !/^\/[\w\-./]*$/.test(image) && !/^https:\/\/[\w\-.]+\/\S*$/.test(image)) {
      errors.image = 'Use um caminho local (/img/...) ou uma URL https.';
    }
  }

  return errors;
}

export function formatBRL(cents) {
  return (cents / 100).toLocaleString('pt-BR', {
    style: 'currency',
    currency: 'BRL',
  });
}
