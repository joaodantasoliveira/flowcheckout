export const onlyDigits = (value = '') => String(value).replace(/\D+/g, '');

export function isValidCPF(cpf) {
  const d = onlyDigits(cpf);
  if (d.length !== 11 || /^(\d)\1{10}$/.test(d)) return false;

  const digit = (slice) => {
    let sum = 0;
    const factorStart = slice + 1;
    for (let i = 0; i < slice; i++) sum += Number(d[i]) * (factorStart - i);
    const rest = (sum * 10) % 11;
    return rest === 10 ? 0 : rest;
  };

  return digit(9) === Number(d[9]) && digit(10) === Number(d[10]);
}

export function isValidCNPJ(cnpj) {
  const d = onlyDigits(cnpj);
  if (d.length !== 14 || /^(\d)\1{13}$/.test(d)) return false;

  const digit = (length) => {
    let sum = 0;
    let factor = length - 7;
    for (let i = 0; i < length; i++) {
      sum += Number(d[i]) * factor;
      factor = factor === 2 ? 9 : factor - 1;
    }
    const rest = sum % 11;
    return rest < 2 ? 0 : 11 - rest;
  };

  return digit(12) === Number(d[12]) && digit(13) === Number(d[13]);
}

export function isValidDocument(doc) {
  const d = onlyDigits(doc);
  if (d.length === 11) return isValidCPF(d);
  if (d.length === 14) return isValidCNPJ(d);
  return false;
}

export function isValidEmail(email) {
  const value = String(email || '').trim();
  return value.length <= 254 && /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(value);
}

/** Aceita telefone brasileiro com DDD, com ou sem o 55 na frente. */
export function isValidPhone(phone) {
  let d = onlyDigits(phone);
  if (d.startsWith('55') && d.length > 11) d = d.slice(2);
  return d.length === 10 || d.length === 11;
}

export function isValidName(name) {
  const value = String(name || '').trim().replace(/\s+/g, ' ');
  if (value.length < 5 || value.length > 100) return false;
  // Precisa de pelo menos nome + sobrenome, apenas letras/acentos/apostrofos.
  return /^[A-Za-zÀ-ÿ'´`^~]{2,}(\s[A-Za-zÀ-ÿ'´`^~.]{1,}){1,}$/.test(value);
}

export const normalizeName = (name) => String(name || '').trim().replace(/\s+/g, ' ');

export function normalizePhone(phone) {
  const d = onlyDigits(phone);
  return d.startsWith('55') && d.length > 11 ? d : `55${d}`;
}

/**
 * Valida o payload do checkout e devolve { errors, data }.
 * `errors` e um objeto campo -> mensagem, vazio quando tudo ok.
 */
export function validateCheckoutPayload(body = {}) {
  const errors = {};

  const name = normalizeName(body.name);
  const email = String(body.email || '').trim().toLowerCase();
  const document = onlyDigits(body.document);
  const phone = onlyDigits(body.phone);

  if (!isValidName(name)) errors.name = 'Informe seu nome completo (nome e sobrenome).';
  if (!isValidEmail(email)) errors.email = 'Informe um e-mail válido.';
  if (!isValidDocument(document)) errors.document = 'CPF/CNPJ inválido.';
  if (!isValidPhone(phone)) errors.phone = 'Informe um telefone válido com DDD.';

  return {
    errors,
    data: { name, email, document, phone: normalizePhone(phone) },
  };
}
