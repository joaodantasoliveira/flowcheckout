import { dbInsert, dbSelect } from './supabase.js';

/**
 * Registro de auditoria das acoes administrativas.
 *
 * Gravar auditoria nunca pode derrubar a operacao principal: se o insert
 * falhar, logamos e seguimos. Perder uma linha de log e ruim; recusar uma
 * venda ou travar um login por causa dela seria pior.
 */
export async function audit(action, { adminId = null, ip = null, detail = null } = {}) {
  try {
    await dbInsert('audit_log', {
      action,
      admin_id: adminId,
      ip,
      detail,
    });
  } catch (err) {
    console.error(`[auditoria] falha ao registrar "${action}":`, err.message);
  }
}

export async function listAudit(limit = 200) {
  const rows = await dbSelect('audit_log', { order: 'at.desc', limit });
  return rows.map((row) => ({
    at: row.at,
    action: row.action,
    adminId: row.admin_id,
    ip: row.ip,
    detail: row.detail,
  }));
}
