import crypto from 'node:crypto';

import { dbInsert, dbSelect, dbSelectOne, dbSelectWithCount, dbUpdate } from './supabase.js';

/**
 * Pedidos, na tabela public.orders.
 *
 * Pedido pago nunca e removido — e o historico financeiro do negocio.
 * A limpeza de rascunhos abandonados vive na funcao SQL cleanup_expired(),
 * chamada pelo cron.
 */

/** Linha do Postgres -> objeto da aplicacao. */
export const fromRow = (row) =>
  row && {
    id: row.id,
    reference: row.reference,
    // Qual gateway processou ESTE pedido. Pode não ser o ativo hoje: trocar
    // de gateway não pode quebrar a conferência das cobranças já emitidas.
    gateway: row.gateway || 'misticpay',
    gatewayTransactionId: row.gateway_transaction_id,

    productId: row.product_id,
    productName: row.product_name,
    amountCents: Number(row.amount_cents),

    customer: {
      name: row.customer_name,
      email: row.customer_email,
      document: row.customer_document,
      phone: row.customer_phone,
    },

    status: row.status,
    paid: row.paid,
    paidAt: row.paid_at ? new Date(row.paid_at).getTime() : null,
    endToEndId: row.end_to_end_id,
    fulfilled: row.fulfilled,

    pix: row.pix,
    infraction: row.infraction,
    meta: row.meta,

    lastGatewayPollAt: row.last_gateway_poll_at ? new Date(row.last_gateway_poll_at).getTime() : 0,
    createdAt: new Date(row.created_at).getTime(),
    updatedAt: new Date(row.updated_at).getTime(),
  };

/** Patch da aplicacao -> colunas do Postgres. */
function toRow(patch) {
  const row = {};
  const map = {
    gatewayTransactionId: 'gateway_transaction_id',
    status: 'status',
    paid: 'paid',
    endToEndId: 'end_to_end_id',
    fulfilled: 'fulfilled',
    pix: 'pix',
    infraction: 'infraction',
  };

  for (const [key, column] of Object.entries(map)) {
    if (patch[key] !== undefined) row[column] = patch[key];
  }

  if (patch.paidAt !== undefined) {
    row.paid_at = patch.paidAt ? new Date(patch.paidAt).toISOString() : null;
  }
  if (patch.lastGatewayPollAt !== undefined) {
    row.last_gateway_poll_at = new Date(patch.lastGatewayPollAt).toISOString();
  }

  row.updated_at = new Date().toISOString();
  return row;
}

export async function createOrder({ product, customer, amountCents, gateway, ip, userAgent }) {
  const id = `${Date.now().toString(36)}-${crypto.randomBytes(6).toString('hex')}`;

  const row = await dbInsert('orders', {
    id,
    reference: `chk-${id}`,
    gateway,
    product_id: product.id,
    product_name: product.name,
    amount_cents: amountCents,
    customer_name: customer.name,
    customer_email: customer.email,
    customer_document: customer.document,
    customer_phone: customer.phone,
    status: 'PENDENTE',
    paid: false,
    fulfilled: false,
    meta: { ip, userAgent },
  });

  return fromRow(row);
}

export async function getOrder(id) {
  if (!id) return null;
  return fromRow(await dbSelectOne('orders', { filters: { id: `eq.${id}` } }));
}

export async function getOrderByGatewayId(gatewayId) {
  if (!gatewayId) return null;
  return fromRow(
    await dbSelectOne('orders', { filters: { gateway_transaction_id: `eq.${String(gatewayId)}` } })
  );
}

export async function linkGatewayId(order, gatewayTransactionId) {
  const updated = await dbUpdate(
    'orders',
    { id: `eq.${order.id}` },
    { gateway_transaction_id: String(gatewayTransactionId), updated_at: new Date().toISOString() }
  );
  return fromRow(updated);
}

export async function updateOrder(order, patch) {
  const updated = await dbUpdate('orders', { id: `eq.${order.id}` }, toRow(patch));
  return fromRow(updated);
}

/**
 * Marca como pago apenas se ainda NAO estiver pago.
 * O filtro paid=false faz o Postgres decidir quem ganha a corrida entre o
 * webhook e o polling: o segundo recebe zero linhas e nao entrega de novo.
 */
export async function markOrderPaidOnce(orderId, { endToEndId = null } = {}) {
  const updated = await dbUpdate(
    'orders',
    { id: `eq.${orderId}`, paid: 'eq.false' },
    {
      paid: true,
      status: 'COMPLETO',
      paid_at: new Date().toISOString(),
      ...(endToEndId ? { end_to_end_id: endToEndId } : {}),
      updated_at: new Date().toISOString(),
    }
  );
  return updated ? fromRow(updated) : null;
}

/** Marca a entrega como feita, tambem uma unica vez. */
export async function markFulfilledOnce(orderId) {
  const updated = await dbUpdate(
    'orders',
    { id: `eq.${orderId}`, fulfilled: 'eq.false' },
    { fulfilled: true, updated_at: new Date().toISOString() }
  );
  return Boolean(updated);
}

export async function listOrders({ status, query, page = 1, perPage = 25 } = {}) {
  const filters = {};
  if (status && status !== 'TODOS') filters.status = `eq.${status}`;

  if (query) {
    // Escapa virgula e parenteses, que sao separadores na sintaxe do PostgREST.
    const safe = String(query).replace(/[(),*]/g, ' ').trim();
    if (safe) {
      filters.or = `(id.ilike.*${safe}*,customer_name.ilike.*${safe}*,customer_email.ilike.*${safe}*,customer_document.ilike.*${safe}*,product_name.ilike.*${safe}*,gateway_transaction_id.ilike.*${safe}*)`;
    }
  }

  const { rows, total } = await dbSelectWithCount('orders', {
    filters,
    order: 'created_at.desc',
    limit: perPage,
    offset: (page - 1) * perPage,
  });

  return {
    orders: rows.map(fromRow),
    pagination: { page, perPage, total, totalPages: Math.max(1, Math.ceil(total / perPage)) },
  };
}

/** Todos os pedidos pagos — usado pelos indicadores e pela exportacao. */
export async function listPaidOrders({ since = null, limit = 10000 } = {}) {
  const filters = { paid: 'eq.true' };
  if (since) filters.paid_at = `gte.${new Date(since).toISOString()}`;

  const rows = await dbSelect('orders', { filters, order: 'paid_at.desc', limit });
  return rows.map(fromRow);
}

export async function countOrders() {
  const { total } = await dbSelectWithCount('orders', { select: 'id', limit: 1 });
  return total;
}

export async function countOrdersByStatus(status) {
  const { total } = await dbSelectWithCount('orders', {
    select: 'id',
    filters: { status: `eq.${status}` },
    limit: 1,
  });
  return total;
}

export async function listRecentOrders(limit = 8) {
  const rows = await dbSelect('orders', { order: 'created_at.desc', limit });
  return rows.map(fromRow);
}

export async function listInfractionOrders() {
  const rows = await dbSelect('orders', { filters: { infraction: 'not.is.null' }, limit: 200 });
  return rows.map(fromRow);
}
