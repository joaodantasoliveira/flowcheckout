import crypto from 'node:crypto';

/**
 * Conversions API do Meta.
 *
 * Por que servidor e nao so o pixel do navegador:
 * o Event Match Quality (0 a 10) mede quantos parametros de identificacao o
 * Meta consegue casar com um perfil. O navegador sozinho manda praticamente
 * fbp/fbc — o que trava a nota em 6-7. E-mail, telefone e nome com hash so
 * existem aqui no servidor, e sao justamente os que mais pesam: adicionar o
 * e-mail sozinho costuma valer varios pontos.
 *
 * Purchase precisa sair daqui de qualquer forma: o comprador pode fechar a
 * aba depois de pagar, e nesse caso o navegador nunca dispara o evento.
 */

const API_VERSION = 'v21.0';

/* ============================================================
   Normalizacao e hash
   ============================================================ */

/**
 * O Meta exige SHA-256 sobre o valor NORMALIZADO. Hash de "Joao@Email.com "
 * e de "joao@email.com" sao diferentes — normalizar errado significa mandar
 * um identificador que nunca casa, o que derruba a nota em vez de subir.
 */
const sha256 = (value) => crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');

const clean = (value) => String(value ?? '').trim().toLowerCase();

/** Remove acentos: o Meta espera nomes sem diacriticos. */
const semAcento = (value) =>
  clean(value).normalize('NFD').replace(/[̀-ͯ]/g, '');

export function hashEmail(email) {
  const value = clean(email);
  return value.includes('@') ? sha256(value) : null;
}

/** Telefone: so digitos, com codigo do pais, sem + nem zeros a esquerda. */
export function hashPhone(phone) {
  let digits = String(phone ?? '').replace(/\D/g, '');
  if (!digits) return null;

  // Numero brasileiro sem o 55 na frente.
  if (digits.length <= 11) digits = `55${digits.replace(/^0+/, '')}`;

  return digits.length >= 10 ? sha256(digits) : null;
}

export function hashName(name) {
  const value = semAcento(name).replace(/[^a-z\s]/g, '').trim();
  return value ? sha256(value) : null;
}

export const hashDocument = (doc) => {
  const digits = String(doc ?? '').replace(/\D/g, '');
  return digits ? sha256(digits) : null;
};

/**
 * Monta user_data com o maximo de sinais disponiveis.
 *
 * fbp e fbc NAO levam hash: ja sao opacos, e aplicar hash neles quebra o
 * casamento. IP e user-agent tambem vao em texto puro, por exigencia da API.
 */
export function buildUserData({ customer = {}, tracking = {}, address = null, orderId }) {
  const [primeiro, ...resto] = String(customer.name || '').trim().split(/\s+/);

  const data = {
    em: [hashEmail(customer.email)],
    ph: [hashPhone(customer.phone)],
    fn: [hashName(primeiro)],
    ln: [hashName(resto.join(' '))],
    country: [sha256('br')],
    /**
     * external_id aceita VÁRIOS valores, e cada um é uma chance a mais de
     * casar. Mandamos dois:
     *   1. o id gerado na landing — costura o visitante com o comprador
     *   2. o CPF — identifica a MESMA pessoa em compras futuras, mesmo que
     *      ela troque de navegador, de aparelho ou de e-mail
     * O CPF não sai daqui em texto claro: vai com hash, como todo o resto.
     */
    external_id: [
      tracking.externalId ? sha256(clean(tracking.externalId)) : null,
      hashDocument(customer.document),
      orderId ? sha256(clean(orderId)) : null,
    ],
    client_ip_address: tracking.ip || undefined,
    client_user_agent: tracking.userAgent || undefined,
    fbp: tracking.fbp || undefined,
    fbc: tracking.fbc || undefined,

    // Endereco: so entra quando veio de consulta de CEP. Cidade e estado
    // digitados errado casam errado e derrubam a nota.
    zp: address?.zip ? [sha256(String(address.zip).replace(/\D/g, ''))] : undefined,
    ct: address?.city ? [sha256(semAcento(address.city).replace(/\s/g, ''))] : undefined,
    st: address?.state ? [sha256(clean(address.state))] : undefined,

    // Identificadores de clique de outros formatos de anuncio. Vao sem hash.
    ctwa_clid: tracking.ctwaClid || undefined,
    lead_id: tracking.leadId || undefined,
  };

  // Campo vazio conta contra a nota: melhor omitir do que mandar nulo.
  for (const [key, value] of Object.entries(data)) {
    if (Array.isArray(value)) {
      const limpos = value.filter(Boolean);
      if (limpos.length) data[key] = limpos;
      else delete data[key];
    } else if (!value) {
      delete data[key];
    }
  }

  return data;
}

/** Quantos sinais fortes estao presentes — usado para diagnostico no painel. */
export function matchSignals(userData) {
  const pesos = {
    em: 'E-mail',
    ph: 'Telefone',
    fn: 'Nome',
    ln: 'Sobrenome',
    external_id: 'ID externo',
    fbp: 'Cookie _fbp',
    fbc: 'Clique do anúncio (_fbc)',
    client_ip_address: 'IP',
    client_user_agent: 'Navegador',
    country: 'País',
    zp: 'CEP',
    ct: 'Cidade',
    st: 'Estado',
    ctwa_clid: 'Clique do WhatsApp',
    lead_id: 'Lead Ads',
  };

  const presentes = Object.keys(pesos).filter((k) => userData[k]);
  return { presentes: presentes.map((k) => pesos[k]), total: presentes.length };
}

/* ============================================================
   Envio
   ============================================================ */

/**
 * Envia um evento. Nunca lanca: rastreamento com problema nao pode derrubar
 * uma venda que ja foi paga.
 */
export async function sendEvent({
  pixelId,
  accessToken,
  testEventCode = null,
  eventName,
  eventId,
  eventTime = Math.floor(Date.now() / 1000),
  eventSourceUrl,
  userData,
  customData = {},
}) {
  if (!pixelId || !accessToken) {
    return { ok: false, error: 'Pixel sem token da Conversions API.' };
  }

  const payload = {
    data: [
      {
        event_name: eventName,
        event_time: eventTime,
        // Mesmo event_id do pixel do navegador: e assim que o Meta
        // deduplica e nao conta a venda duas vezes.
        event_id: eventId,
        event_source_url: eventSourceUrl,
        action_source: 'website',
        user_data: userData,
        custom_data: customData,
      },
    ],
  };

  if (testEventCode) payload.test_event_code = testEventCode;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);

  try {
    const res = await fetch(
      `https://graph.facebook.com/${API_VERSION}/${pixelId}/events?access_token=${encodeURIComponent(accessToken)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal,
      }
    );

    const json = await res.json().catch(() => null);

    if (!res.ok) {
      const motivo = json?.error?.message || `HTTP ${res.status}`;
      console.error(`[capi] ${eventName} recusado pelo Meta: ${motivo}`);
      return { ok: false, error: motivo, body: json };
    }

    console.log(
      `[capi] ${eventName} enviado (pixel ${pixelId}, evento ${eventId}) — ` +
        `${json?.events_received ?? 0} recebido(s)`
    );

    return { ok: true, received: json?.events_received ?? 0, body: json };
  } catch (err) {
    const motivo = err.name === 'AbortError' ? 'tempo esgotado' : err.message;
    console.error(`[capi] falha ao enviar ${eventName}: ${motivo}`);
    return { ok: false, error: motivo };
  } finally {
    clearTimeout(timer);
  }
}

/** Valida o par pixel + token sem gravar nada de verdade. */
export async function testCredentials({ pixelId, accessToken, testEventCode }) {
  const userData = buildUserData({
    customer: { name: 'Teste Silva', email: 'teste@exemplo.com', phone: '11999999999' },
    tracking: { ip: '127.0.0.1', userAgent: 'gocheckout-teste' },
    orderId: `teste-${Date.now()}`,
  });

  const result = await sendEvent({
    pixelId,
    accessToken,
    testEventCode: testEventCode || undefined,
    eventName: 'PageView',
    eventId: `teste-${crypto.randomUUID()}`,
    eventSourceUrl: 'https://exemplo.com/teste',
    userData,
  });

  if (!result.ok) {
    const erro = new Error(result.error);
    erro.status = 400;
    throw erro;
  }

  return { received: result.received, signals: matchSignals(userData) };
}
