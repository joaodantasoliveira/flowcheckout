import crypto from 'node:crypto';

import { config } from './config.js';
import { lookupCep } from './cep.js';
import { buildUserData, matchSignals, sendEvent } from './meta-capi.js';
import { getPixelWithToken, markPixelEvent } from './pixels.js';

/**
 * Rastreamento de conversao.
 *
 * O identificador de clique do Meta vive num cookie de PRIMEIRA parte, que
 * nao atravessa dominio. Como a landing fica num dominio e o checkout em
 * outro, o snippet gerado carimba os identificadores na URL do checkout, e
 * aqui a gente le da URL. Sem isso o `fbc` — o sinal que liga a venda ao
 * anuncio — simplesmente nao existe do lado de ca.
 */

/** Aceita fbp/fbc no formato do Meta; ignora lixo. */
const FBP_RE = /^fb\.\d\.\d{10,}\.\d+$/;
const FBC_RE = /^fb\.\d\.\d{10,}\..+$/;

/**
 * Extrai os identificadores de atribuicao do que veio do browser.
 * Guarda so o que reconhece, com tamanho limitado — isso vai para o banco
 * e depois para o Meta.
 */
export function extractTracking(body = {}, req) {
  const t = body.tracking || {};
  const limite = (v, max = 300) => (v ? String(v).slice(0, max) : null);

  let fbc = limite(t.fbc);
  if (fbc && !FBC_RE.test(fbc)) fbc = null;

  // Sem _fbc pronto, monta a partir do fbclid — que e o que a landing
  // consegue capturar quando o visitante chega do anuncio.
  const fbclid = limite(t.fbclid, 500);
  if (!fbc && fbclid) fbc = `fb.1.${Date.now()}.${fbclid}`;

  let fbp = limite(t.fbp);
  if (fbp && !FBP_RE.test(fbp)) fbp = null;

  return {
    fbp,
    fbc,
    // Cliques de outros formatos: anuncio que abre WhatsApp e Lead Ads.
    ctwaClid: limite(t.ctwaClid, 200),
    leadId: limite(t.leadId, 100),
    externalId: limite(t.externalId, 100),
    eventSourceUrl: limite(t.pageUrl, 500) || `${config.publicUrl}/`,
    utm: {
      source: limite(t.utmSource, 120),
      medium: limite(t.utmMedium, 120),
      campaign: limite(t.utmCampaign, 200),
      content: limite(t.utmContent, 200),
      term: limite(t.utmTerm, 200),
    },
    ip: normalizeIp(req?.ip),
    userAgent: limite(req?.get?.('user-agent'), 400),
  };
}

const normalizeIp = (ip) => (ip ? String(ip).replace(/^::ffff:/, '') : null);

/** IDs de evento derivados do pedido: o browser gera o mesmo e o Meta deduplica. */
export const eventIdFor = (orderId, eventName) => `${eventName}.${orderId}`;

/**
 * Dispara um evento para o pixel do produto.
 * Nunca lanca — rastreamento nao pode derrubar venda.
 */
export async function trackEvent({ order, product, eventName, eventTime }) {
  try {
    if (!product?.pixelId) return { ok: false, skipped: 'produto sem pixel' };

    const pixel = await getPixelWithToken(product.pixelId);
    if (!pixel) return { ok: false, skipped: 'pixel inativo ou inexistente' };
    if (!pixel.accessToken) {
      await markPixelEvent(pixel.id, 'sem token da Conversions API');
      return { ok: false, skipped: 'pixel sem token' };
    }

    const tracking = order.tracking || {};

    // Cidade e estado saem da consulta de CEP, nao do que o comprador
    // digitou. Feito aqui e nao na criacao do pedido para nao somar
    // latencia ao momento em que o cliente esta esperando o QR Code.
    const address = order.customerZip ? await lookupCep(order.customerZip) : null;

    const userData = buildUserData({
      customer: order.customer,
      tracking: { ...tracking, ip: tracking.ip, userAgent: tracking.userAgent },
      address,
      orderId: order.id,
    });

    const result = await sendEvent({
      pixelId: pixel.pixelId,
      accessToken: pixel.accessToken,
      testEventCode: pixel.testEventCode,
      eventName,
      eventId: eventIdFor(order.id, eventName),
      eventTime: eventTime ? Math.floor(eventTime / 1000) : undefined,
      eventSourceUrl: tracking.eventSourceUrl || `${config.publicUrl}/`,
      userData,
      customData: {
        currency: 'BRL',
        value: Number((order.amountCents / 100).toFixed(2)),
        content_ids: [order.productId],
        content_name: order.productName,
        content_type: 'product',
        order_id: order.id,
        ...(tracking.utm?.source ? { utm_source: tracking.utm.source } : {}),
        ...(tracking.utm?.campaign ? { utm_campaign: tracking.utm.campaign } : {}),
      },
    });

    await markPixelEvent(
      pixel.id,
      result.ok ? `${eventName} ok · ${matchSignals(userData).total} sinais` : `${eventName}: ${result.error}`
    );

    return { ...result, signals: matchSignals(userData) };
  } catch (err) {
    console.error(`[tracking] falha em ${eventName}:`, err.message);
    return { ok: false, error: err.message };
  }
}

/* ============================================================
   Snippet para a landing page
   ============================================================ */

/**
 * Gera o codigo que substitui o pixel do Meta na landing.
 *
 * Alem de inicializar o pixel, ele resolve o problema que o pixel puro nao
 * resolve: leva `_fbp`, `_fbc` e um `external_id` estavel ate o checkout,
 * que esta em outro dominio. E o `external_id` e o que costura o visitante
 * da landing com o comprador do checkout.
 */
export function buildLandingSnippet({ pixel, checkoutUrl, product = null }) {
  const base = checkoutUrl || config.publicUrl;
  const host = new URL(base).host;

  const cabecalho = product
    ? `<!-- GoCheckout · rastreamento (${pixel.name} · ${product.name}) -->`
    : `<!-- GoCheckout · rastreamento Meta (${pixel.name}) -->`;

  const avisoProduto = product
    ? ''
    : `<!-- Gerado sem produto: a visita na página de vendas NÃO será contada.
     Para contar, pegue o código em Produtos → UTM do anúncio. -->\n`;

  return `${cabecalho}
${avisoProduto}<!-- Substitui o pixel padrão do Meta. Cole antes de </head> -->
<script>
(function (w, d) {
  var PIXEL_ID = '${pixel.pixelId}';
  var CHECKOUT_HOST = '${host}';
  var CHECKOUT_URL = '${base}';
  var PRODUTO = ${product ? `'${product.id}'` : 'null'};
  var ANO = 60 * 60 * 24 * 365;

  /* ---- pixel padrão do Meta ---- */
  !function(f,b,e,v,n,t,s){if(f.fbq)return;n=f.fbq=function(){n.callMethod?
  n.callMethod.apply(n,arguments):n.queue.push(arguments)};if(!f._fbq)f._fbq=n;
  n.push=n;n.loaded=!0;n.version='2.0';n.queue=[];t=b.createElement(e);t.async=!0;
  t.src=v;s=b.getElementsByTagName(e)[0];s.parentNode.insertBefore(t,s)}
  (w,d,'script','https://connect.facebook.net/en_US/fbevents.js');

  /* ---- utilidades de cookie (primeira parte) ---- */
  function ler(nome) {
    var m = d.cookie.match('(^|; )' + nome + '=([^;]*)');
    return m ? decodeURIComponent(m[2]) : null;
  }
  function gravar(nome, valor) {
    d.cookie = nome + '=' + encodeURIComponent(valor) +
      ';path=/;max-age=' + ANO + ';SameSite=Lax' +
      (location.protocol === 'https:' ? ';Secure' : '');
  }

  var params = new URLSearchParams(location.search);

  /* ---- _fbc: nasce do fbclid do anúncio ----
     Redirect e encurtador costumam comer o fbclid antes do pixel ler.
     Por isso gravamos assim que aparece. */
  var fbclid = params.get('fbclid');
  if (fbclid && !ler('_fbc')) gravar('_fbc', 'fb.1.' + Date.now() + '.' + fbclid);

  /* ---- _fbp: identificador do navegador ---- */
  if (!ler('_fbp')) {
    gravar('_fbp', 'fb.1.' + Date.now() + '.' + Math.floor(Math.random() * 1e10));
  }

  /* ---- external_id: costura landing e checkout ----
     É o mesmo valor nos dois lados, então o Meta entende que o visitante
     de lá e o comprador de cá são a mesma pessoa. */
  var extId = ler('_fc_ext');
  if (!extId) {
    extId = 'fc.' + Date.now().toString(36) + '.' +
      Math.random().toString(36).slice(2, 12);
    gravar('_fc_ext', extId);
  }

  fbq('init', PIXEL_ID, { external_id: extId });
  fbq('track', 'PageView');

  /* ---- conta a visita nesta página de vendas ----
     sendBeacon envia como text/plain, que não dispara preflight de CORS —
     por isso funciona de um domínio para o outro sem configuração.
     O mesmo extId identifica a pessoa lá no checkout, então dá para ver
     quantos dos que viram a oferta chegaram a abrir o checkout. */
  if (PRODUTO) {
    try {
      var visita = JSON.stringify({
        productId: PRODUTO,
        sessionId: extId,
        source: 'landing',
        tracking: {
          fbp: ler('_fbp'), fbc: ler('_fbc'), externalId: extId,
          pageUrl: location.href,
          utmSource: params.get('utm_source'),
          utmMedium: params.get('utm_medium'),
          utmCampaign: params.get('utm_campaign'),
          utmContent: params.get('utm_content'),
          utmTerm: params.get('utm_term')
        }
      });

      var alvo = CHECKOUT_URL + '/api/checkout/view';

      if (navigator.sendBeacon) {
        navigator.sendBeacon(alvo, new Blob([visita], { type: 'text/plain' }));
      } else {
        fetch(alvo, {
          method: 'POST', mode: 'no-cors', keepalive: true,
          headers: { 'Content-Type': 'text/plain' }, body: visita
        }).catch(function () {});
      }
    } catch (e) {}
  }

  /* ---- carimba os links do checkout ----
     Cookie não atravessa domínio: os identificadores viajam na URL. */
  function decorar(url) {
    try {
      var u = new URL(url, location.href);
      if (u.host !== CHECKOUT_HOST) return url;

      var fbp = ler('_fbp'), fbc = ler('_fbc');
      if (fbp) u.searchParams.set('_fbp', fbp);
      if (fbc) u.searchParams.set('_fbc', fbc);
      u.searchParams.set('_eid', extId);

      // Preserva as UTMs da origem.
      ['utm_source','utm_medium','utm_campaign','utm_content','utm_term']
        .forEach(function (k) {
          var v = params.get(k);
          if (v && !u.searchParams.get(k)) u.searchParams.set(k, v);
        });

      return u.toString();
    } catch (e) { return url; }
  }

  function aplicar() {
    var links = d.querySelectorAll('a[href*="' + CHECKOUT_HOST + '"]');
    for (var i = 0; i < links.length; i++) links[i].href = decorar(links[i].href);
  }

  if (d.readyState === 'loading') d.addEventListener('DOMContentLoaded', aplicar);
  else aplicar();

  // Botões criados depois (pop-up, carrossel) também são cobertos.
  d.addEventListener('click', function (e) {
    var a = e.target && e.target.closest && e.target.closest('a[href]');
    if (a && a.href.indexOf(CHECKOUT_HOST) !== -1) a.href = decorar(a.href);
  }, true);

  w.goCheckoutDecorate = decorar;
})(window, document);
</script>
<noscript><img height="1" width="1" style="display:none"
  src="https://www.facebook.com/tr?id=${pixel.pixelId}&ev=PageView&noscript=1"/></noscript>
<!-- /GoCheckout -->`;
}
