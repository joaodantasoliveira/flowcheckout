import { config } from '../config.js';
import { buildQrCode } from '../qrcode.js';
import { GatewayError } from './errors.js';

/**
 * Gateway MisticPay — https://api.misticpay.com
 *
 * Autenticacao por headers ci/cs em cada requisicao. Devolve QR Code pronto
 * (base64 e URL), entao nao precisamos gerar imagem.
 */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const BASE_URL = config.misticpay.baseUrl;

async function request(credentials, method, path, { body, timeoutMs = 15000, retries = 1 } = {}) {
  let lastError;

  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await fetch(`${BASE_URL}${path}`, {
        method,
        headers: {
          ci: credentials.ci,
          cs: credentials.cs,
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

      if (!res.ok) {
        if ((res.status >= 500 || res.status === 429) && attempt < retries) {
          lastError = new GatewayError(`Gateway respondeu ${res.status}`, {
            status: res.status,
            body: json,
          });
          await sleep(400 * 2 ** attempt);
          continue;
        }
        throw new GatewayError(json?.message || json?.error || `Gateway respondeu ${res.status}`, {
          status: res.status,
          body: json,
        });
      }

      return json;
    } catch (err) {
      if (err instanceof GatewayError) throw err;

      lastError = new GatewayError(
        err.name === 'AbortError'
          ? 'Tempo esgotado ao falar com o gateway.'
          : `Falha de rede ao falar com o gateway: ${err.message}`,
        { status: 504 }
      );
      if (attempt < retries) {
        await sleep(400 * 2 ** attempt);
        continue;
      }
      throw lastError;
    } finally {
      clearTimeout(timer);
    }
  }

  throw lastError;
}

/** PENDENTE | COMPLETO | FALHA | CANCELADO já é o vocabulário nativo daqui. */
const VALID = new Set(['PENDENTE', 'COMPLETO', 'FALHA', 'CANCELADO']);
const normalizeStatus = (raw) => {
  const value = String(raw || '').toUpperCase();
  return VALID.has(value) ? value : null;
};

export const misticpay = {
  id: 'misticpay',
  label: 'MisticPay',
  docsUrl: 'https://api.misticpay.com',

  credentialFields: [
    { key: 'ci', label: 'Client ID', hint: 'header ci', secret: false },
    { key: 'cs', label: 'Client Secret', hint: 'header cs', secret: true },
  ],

  /** Credenciais herdadas do .env, para o primeiro deploy. */
  envCredentials() {
    if (!config.misticpay.ci || !config.misticpay.cs) return null;
    return { ci: config.misticpay.ci, cs: config.misticpay.cs };
  },

  async testCredentials(credentials) {
    const response = await request(credentials, 'GET', '/users/info', { retries: 0, timeoutMs: 12000 });
    const data = response?.data || {};

    return {
      name: data.name || null,
      email: data.email || null,
      accountVerified: Boolean(data.accountVerified),
      documentVerified: Boolean(data.documentVerified),
      withdrawBlocked: Boolean(data.withdrawBlocked),
      availableBalance: data.availableBalance ?? null,
    };
  },

  async createPixCharge(credentials, { amountCents, customer, reference, description, webhookUrl }) {
    const payload = {
      amount: Number((amountCents / 100).toFixed(2)),
      payerName: customer.name,
      payerDocument: customer.document,
      transactionId: reference,
      description,
    };

    if (webhookUrl) payload.projectWebhook = webhookUrl;
    if (config.split.user && config.split.tax) {
      payload.splitUser = config.split.user;
      payload.splitTax = config.split.tax;
    }

    // Orcamento apertado: a funcao da Vercel e cortada em 30s.
    const response = await request(credentials, 'POST', '/transactions/create', {
      body: payload,
      timeoutMs: 12000,
      retries: 1,
    });

    const tx = response?.data;
    if (!tx?.transactionId || !(tx.copyPaste || tx.qrCodeBase64)) {
      throw new GatewayError('Resposta inesperada do gateway ao gerar o PIX.', {
        status: 502,
        body: response,
      });
    }

    // A MisticPay costuma mandar a imagem pronta. Quando não manda, montamos
    // a partir do copia e cola — o cliente não fica sem QR por isso.
    const temImagem = tx.qrCodeBase64 || tx.qrcodeUrl;
    const qr = temImagem
      ? { qrCodeBase64: tx.qrCodeBase64 || null, qrcodeUrl: tx.qrcodeUrl || null }
      : await buildQrCode(tx.copyPaste);

    return {
      gatewayTransactionId: String(tx.transactionId),
      copyPaste: tx.copyPaste || null,
      ...qr,
    };
  },

  async checkTransaction(credentials, gatewayTransactionId) {
    const response = await request(credentials, 'POST', '/transactions/check', {
      body: { transactionId: String(gatewayTransactionId) },
      retries: 1,
    });

    const tx = response?.transaction;
    if (!tx) return null;

    return {
      status: normalizeStatus(tx.transactionState),
      amount: tx.value ?? null,
      endToEndId: tx.endToEndId || null,
    };
  },

  async getBalance(credentials) {
    const response = await request(credentials, 'GET', '/users/balance');
    return response?.data?.balance ?? null;
  },

  /**
   * Webhook de deposito. Devolve null para eventos que nao interessam ao
   * checkout (saques, por exemplo).
   */
  parseWebhook(body = {}) {
    if (body.event === 'INFRACTION') {
      return {
        kind: 'infraction',
        gatewayTransactionId: String(body.transaction?.transactionId || ''),
        infraction: {
          id: body.infraction?.id,
          status: body.infraction?.status,
          type: body.infraction?.type,
          amount: body.infraction?.amount,
          analysisResult: body.infraction?.analysisResult || null,
        },
      };
    }

    if (!body.transactionId) return null;

    const type = String(body.transactionType || '').toUpperCase();
    if (type && type !== 'DEPOSITO') return null;

    return {
      kind: 'payment',
      gatewayTransactionId: String(body.transactionId),
      status: normalizeStatus(body.status),
      endToEndId: body.e2e || null,
    };
  },
};
