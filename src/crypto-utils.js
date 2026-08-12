// Este modulo le APP_ENCRYPTION_KEY direto de process.env e pode ser
// importado antes do config.js. Carregar o .env aqui tambem evita depender
// da ordem dos imports (dotenv e idempotente).
import 'dotenv/config';

import crypto from 'node:crypto';

/* ============================================================
   Comparacao em tempo constante
   ============================================================ */

/** Evita que o tempo de resposta revele quantos caracteres bateram. */
export function safeEqual(a, b) {
  const bufA = Buffer.from(String(a ?? ''), 'utf8');
  const bufB = Buffer.from(String(b ?? ''), 'utf8');

  // Comprimentos diferentes: ainda assim faz um compare para nao vazar tempo.
  if (bufA.length !== bufB.length) {
    crypto.timingSafeEqual(bufA, bufA);
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

export const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');

/* ============================================================
   Senha — scrypt
   ============================================================ */

const SCRYPT = { N: 2 ** 15, r: 8, p: 1, keylen: 64 };

export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const derived = crypto.scryptSync(password.normalize('NFKC'), salt, SCRYPT.keylen, {
    N: SCRYPT.N,
    r: SCRYPT.r,
    p: SCRYPT.p,
    maxmem: 256 * 1024 * 1024,
  });

  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('hex')}$${derived.toString('hex')}`;
}

export function verifyPassword(password, stored) {
  try {
    const [scheme, N, r, p, saltHex, hashHex] = String(stored || '').split('$');
    if (scheme !== 'scrypt') return false;

    const salt = Buffer.from(saltHex, 'hex');
    const expected = Buffer.from(hashHex, 'hex');

    const derived = crypto.scryptSync(password.normalize('NFKC'), salt, expected.length, {
      N: Number(N),
      r: Number(r),
      p: Number(p),
      maxmem: 256 * 1024 * 1024,
    });

    return crypto.timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
}

/* ============================================================
   Criptografia de segredos guardados no banco — AES-256-GCM
   ============================================================ */

/**
 * Cifra credenciais antes de gravar (client secret do gateway, por exemplo).
 *
 * A chave vive em APP_ENCRYPTION_KEY, fora do banco. Assim um dump do
 * Postgres — vazamento, backup mal guardado, acesso indevido ao Supabase —
 * nao entrega as credenciais de pagamento sozinho.
 *
 * GCM e autenticado: se o texto cifrado for adulterado, decrypt lanca em
 * vez de devolver lixo.
 */
function encryptionKey() {
  const raw = process.env.APP_ENCRYPTION_KEY;
  if (!raw) {
    throw new Error(
      'APP_ENCRYPTION_KEY não configurada. Gere uma com: npm run gen:key ' +
        '(e cadastre também nas variáveis de ambiente da Vercel).'
    );
  }

  const key = Buffer.from(raw, 'base64');
  if (key.length !== 32) {
    throw new Error('APP_ENCRYPTION_KEY deve ter 32 bytes em base64. Gere: npm run gen:key');
  }
  return key;
}

export const hasEncryptionKey = () => {
  try {
    encryptionKey();
    return true;
  } catch {
    return false;
  }
};

export function encryptSecret(plaintext) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(), iv);

  const ciphertext = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return `v1.${iv.toString('base64url')}.${tag.toString('base64url')}.${ciphertext.toString('base64url')}`;
}

export function decryptSecret(payload) {
  const [version, ivPart, tagPart, dataPart] = String(payload || '').split('.');
  if (version !== 'v1' || !ivPart || !tagPart || !dataPart) {
    throw new Error('Valor cifrado em formato inesperado.');
  }

  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    encryptionKey(),
    Buffer.from(ivPart, 'base64url')
  );
  decipher.setAuthTag(Buffer.from(tagPart, 'base64url'));

  return Buffer.concat([
    decipher.update(Buffer.from(dataPart, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
}

/** Mostra so os ultimos caracteres — o resto nunca volta para o browser. */
export function maskSecret(value, visible = 4) {
  const text = String(value || '');
  if (text.length <= visible) return '•'.repeat(8);
  return `${'•'.repeat(Math.min(16, text.length - visible))}${text.slice(-visible)}`;
}

/* ============================================================
   TOTP (RFC 6238) — segundo fator
   ============================================================ */

const B32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buffer) {
  let bits = 0;
  let value = 0;
  let output = '';

  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += B32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += B32_ALPHABET[(value << (5 - bits)) & 31];

  return output;
}

export function base32Decode(input) {
  const clean = String(input).toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0;
  let value = 0;
  const bytes = [];

  for (const char of clean) {
    const index = B32_ALPHABET.indexOf(char);
    if (index === -1) continue;
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

export const generateTotpSecret = () => base32Encode(crypto.randomBytes(20));

function totpCode(secret, counter) {
  const key = base32Decode(secret);
  const buf = Buffer.alloc(8);
  buf.writeBigInt64BE(BigInt(counter));

  const hmac = crypto.createHmac('sha1', key).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const binary =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);

  return String(binary % 1_000_000).padStart(6, '0');
}

/**
 * Valida o codigo de 6 digitos.
 * A janela de +/-1 passo (30s) absorve relogio levemente dessincronizado.
 * Devolve o contador usado para que o chamador possa bloquear replay.
 */
export function verifyTotp(secret, token, { window = 1 } = {}) {
  const code = String(token || '').replace(/\D/g, '');
  if (code.length !== 6) return null;

  const counter = Math.floor(Date.now() / 30000);
  for (let drift = -window; drift <= window; drift++) {
    if (safeEqual(totpCode(secret, counter + drift), code)) return counter + drift;
  }
  return null;
}

export function totpUri({ secret, account, issuer = 'Checkout' }) {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const params = new URLSearchParams({
    secret,
    issuer,
    algorithm: 'SHA1',
    digits: '6',
    period: '30',
  });
  return `otpauth://totp/${label}?${params}`;
}
