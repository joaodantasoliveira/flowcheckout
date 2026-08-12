import QRCode from 'qrcode';

import { GatewayError } from './errors.js';

/**
 * Gateway SyncPay — https://api.syncpayments.com.br
 *
 * Diferencas relevantes em relacao a MisticPay:
 *
 * 1. Autenticacao em duas etapas: client_id/client_secret trocados por um
 *    Bearer token de 1 hora. Cacheamos o token por instancia.
 * 2. Devolve apenas o `pix_code` (copia e cola) — sem imagem. Geramos o QR
 *    localmente, para nao mandar o codigo Pix do cliente a um servico de
 *    terceiros so para desenhar um quadrado.
 * 3. Status em ingles e minusculo (pending/completed/failed/refunded/med),
 *    traduzidos aqui para o vocabulario interno.
 */

const BASE_URL = 'https://api.syncpayments.com.br';

/* ============================================================
   Token — cache por instancia
   ============================================================ */

const tokenCache = new Map();

const cacheKey = (credentials) => credentials.client_id || '';

async function getToken(credentials) {
  const key = cacheKey(credentials);
  const cached = tokenCache.get(key);

  // Renova 60s antes de expirar, para nao usar um token que morre no meio
  // da requisicao seguinte.
  if (cached && cached.expiresAt - 60_000 > Date.now()) return cached.token;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);

  try {
    const res = await fetch(`${BASE_URL}/api/partner/v1/auth-token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        client_id: credentials.client_id,
        client_secret: credentials.client_secret,
      }),
      signal: controller.signal,
    });

    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }

    if (!res.ok || !json?.access_token) {
      throw new GatewayError(
        json?.error_description || json?.message || `Falha ao autenticar (${res.status}).`,
        { status: res.status === 200 ? 502 : res.status, body: json }
      );
    }

    const ttlMs = Number(json.expires_in || 3600) * 1000;
    tokenCache.set(key, { token: json.access_token, expiresAt: Date.now() + ttlMs });

    return json.access_token;
  } catch (err) {
    if (err instanceof GatewayError) throw err;
    throw new GatewayError(
      err.name === 'AbortError'
        ? 'Tempo esgotado ao autenticar no gateway.'
        : `Falha de rede ao autenticar: ${err.message}`,
      { status: 504 }
    );
  } finally {
    clearTimeout(timer);
  }
}

async function request(credentials, method, path, { body, timeoutMs = 15000, retryAuth = true } = {}) {
  const token = await getToken(credentials);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(`${BASE_URL}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });

    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = { raw: text };
    }

    // Token invalidado antes da hora: descarta o cache e tenta uma vez.
    if (res.status === 401 && retryAuth) {
      tokenCache.delete(cacheKey(credentials));
      return request(credentials, method, path, { body, timeoutMs, retryAuth: false });
    }

    if (!res.ok) {
      throw new GatewayError(
        json?.message || json?.error_description || json?.error || `Gateway respondeu ${res.status}`,
        { status: res.status, body: json }
      );
    }

    return json;
  } catch (err) {
    if (err instanceof GatewayError) throw err;
    throw new GatewayError(
      err.name === 'AbortError'
        ? 'Tempo esgotado ao falar com o gateway.'
        : `Falha de rede ao falar com o gateway: ${err.message}`,
      { status: 504 }
    );
  } finally {
    clearTimeout(timer);
  }
}

/** pending | completed | failed | refunded | med -> vocabulario interno. */
function normalizeStatus(raw) {
  switch (String(raw || '').toLowerCase()) {
    case 'completed':
      return 'COMPLETO';
    case 'pending':
      return 'PENDENTE';
    case 'failed':
      return 'FALHA';
    case 'refunded':
    case 'med':
      // Estorno e MED significam dinheiro devolvido: o pedido nao vale mais.
      return 'CANCELADO';
    default:
      return null;
  }
}

/** O telefone da SyncPay precisa ter 10 ou 11 digitos, sem o 55. */
function localPhone(phone) {
  let d = String(phone || '').replace(/\D/g, '');
  if (d.startsWith('55') && d.length > 11) d = d.slice(2);
  return d;
}

export const syncpay = {
  id: 'syncpay',
  label: 'SyncPay',
  docsUrl: 'https://syncpay.apidog.io',

  credentialFields: [
    { key: 'client_id', label: 'Client ID', hint: 'UUID', secret: false },
    { key: 'client_secret', label: 'Client Secret', hint: 'UUID', secret: true },
  ],

  envCredentials() {
    return null;
  },

  async testCredentials(credentials) {
    const response = await request(credentials, 'GET', '/api/partner/v1/profile', {
      timeoutMs: 12000,
    });
    const data = response?.data || {};

    let balance = null;
    try {
      balance = await this.getBalance(credentials);
    } catch {
      // Saldo é informativo: não invalida a credencial.
    }

    return {
      name: data.name || null,
      email: data.email || null,
      accountVerified: String(data.status || '').toLowerCase() === 'approved',
      documentVerified: String(data.status || '').toLowerCase() === 'approved',
      withdrawBlocked: false,
      availableBalance: balance,
    };
  },

  async createPixCharge(credentials, { amountCents, customer, description, webhookUrl }) {
    const response = await request(credentials, 'POST', '/api/partner/v1/cash-in', {
      body: {
        amount: Number((amountCents / 100).toFixed(2)),
        description,
        // webhook_url é obrigatório na SyncPay.
        webhook_url: webhookUrl,
        client: {
          name: customer.name,
          cpf: customer.document,
          email: customer.email,
          phone: localPhone(customer.phone),
        },
      },
      timeoutMs: 12000,
    });

    const pixCode = response?.pix_code;
    const identifier = response?.identifier;

    if (!identifier || !pixCode) {
      throw new GatewayError('Resposta inesperada do gateway ao gerar o PIX.', {
        status: 502,
        body: response,
      });
    }

    // A SyncPay não devolve imagem: desenhamos o QR aqui mesmo.
    let qrCodeBase64 = null;
    try {
      qrCodeBase64 = await QRCode.toDataURL(pixCode, {
        errorCorrectionLevel: 'M',
        margin: 1,
        width: 320,
      });
    } catch (err) {
      // Sem imagem o cliente ainda paga pelo copia e cola.
      console.error('[syncpay] falha ao gerar QR Code:', err.message);
    }

    return {
      gatewayTransactionId: String(identifier),
      copyPaste: pixCode,
      qrCodeBase64,
      qrcodeUrl: null,
    };
  },

  async checkTransaction(credentials, gatewayTransactionId) {
    const response = await request(
      credentials,
      'GET',
      `/api/partner/v1/transaction/${encodeURIComponent(gatewayTransactionId)}`
    );

    const data = response?.data;
    if (!data) return null;

    return {
      status: normalizeStatus(data.status),
      amount: data.amount ?? null,
      endToEndId: data.end_to_end || null,
    };
  },

  async getBalance(credentials) {
    const response = await request(credentials, 'GET', '/api/partner/v1/balance');
    const raw = response?.balance;
    return raw === undefined || raw === null ? null : Number(raw);
  },

  parseWebhook(body = {}) {
    const data = body?.data || body;
    const id = data?.id;
    if (!id) return null;

    return {
      kind: 'payment',
      gatewayTransactionId: String(id),
      status: normalizeStatus(data.status),
      endToEndId: data.end_to_end || null,
    };
  },
};
