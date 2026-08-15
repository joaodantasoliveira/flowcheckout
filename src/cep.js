/**
 * Consulta de CEP (ViaCEP).
 *
 * Cidade e estado sao DERIVADOS do CEP, nao digitados. Isso importa: o Meta
 * penaliza parametro incorreto — mandar "Sao Paulo" para quem mora em Santo
 * Andre casa errado e derruba a nota em vez de subir. O CEP resolve os tres
 * de uma vez, e com precisao.
 */

const cache = new Map();
const CACHE_MAX = 500;

/** Estado em sigla minuscula, como o Meta espera. */
export async function lookupCep(cep) {
  const digits = String(cep || '').replace(/\D/g, '');
  if (digits.length !== 8) return null;

  if (cache.has(digits)) return cache.get(digits);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4000);

  try {
    const res = await fetch(`https://viacep.com.br/ws/${digits}/json/`, {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    });

    if (!res.ok) return null;

    const json = await res.json();
    if (json?.erro) return null;

    const resultado = {
      zip: digits,
      city: String(json.localidade || '').trim() || null,
      state: String(json.uf || '').trim().toLowerCase() || null,
    };

    if (cache.size >= CACHE_MAX) cache.clear();
    cache.set(digits, resultado);

    return resultado;
  } catch {
    // Sem consulta, ainda mandamos o zp: um sinal em vez de tres.
    return { zip: digits, city: null, state: null };
  } finally {
    clearTimeout(timer);
  }
}

export const isValidCep = (cep) => /^[0-9]{8}$/.test(String(cep || '').replace(/\D/g, ''));
