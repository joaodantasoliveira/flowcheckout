import { config } from './config.js';

export class MisticPayError extends Error {
  constructor(message, { status = 502, body = null } = {}) {
    super(message);
    this.name = 'MisticPayError';
    this.status = status;
    this.body = body;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Wrapper HTTP da MisticPay.
 * As credenciais (ci/cs) so existem aqui, no servidor — nunca vao para o browser.
 */
async function request(method, path, { body, timeoutMs = 20000, retries = 2 } = {}) {
  const url = `${config.misticpay.baseUrl}${path}`;

  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await fetch(url, {
        method,
        headers: {
          ci: config.misticpay.ci,
          cs: config.misticpay.cs,
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
        // 5xx e 429 valem retry; 4xx e erro definitivo do nosso lado.
        if ((res.status >= 500 || res.status === 429) && attempt < retries) {
          lastError = new MisticPayError(`Gateway respondeu ${res.status}`, {
            status: res.status,
            body: json,
          });
          await sleep(400 * 2 ** attempt);
          continue;
        }
        throw new MisticPayError(
          json?.message || json?.error || `Gateway respondeu ${res.status}`,
          { status: res.status, body: json }
        );
      }

      return json;
    } catch (err) {
      if (err instanceof MisticPayError) throw err;

      // Timeout / falha de rede
      lastError = new MisticPayError(
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

/** POST /transactions/create — gera o QR Code PIX (cash-in). */
export function createPixTransaction({
  amount,
  payerName,
  payerDocument,
  transactionId,
  description,
  projectWebhook,
}) {
  const payload = {
    amount,
    payerName,
    payerDocument,
    transactionId,
    description,
  };

  if (projectWebhook) payload.projectWebhook = projectWebhook;
  if (config.split.user && config.split.tax) {
    payload.splitUser = config.split.user;
    payload.splitTax = config.split.tax;
  }

  return request('POST', '/transactions/create', { body: payload });
}

/** POST /transactions/check — fonte da verdade sobre o status. */
export function checkTransaction(transactionId) {
  return request('POST', '/transactions/check', {
    body: { transactionId: String(transactionId) },
    retries: 1,
  });
}

/** GET /users/balance */
export function getBalance() {
  return request('GET', '/users/balance');
}

/** GET /users/info */
export function getAccountInfo() {
  return request('GET', '/users/info');
}
