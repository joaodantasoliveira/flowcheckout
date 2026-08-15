import { formatBRL } from './products.js';

/**
 * Relatorio de origem das vendas.
 *
 * A pergunta que o Gerenciador do Meta nao responde: de cada 10 pessoas que
 * a campanha X mandou para o checkout, quantas pagaram? La voce ve compras;
 * aqui voce ve o funil inteiro por campanha, e descobre a diferenca entre
 * "campanha que traz pouca gente boa" e "campanha que traz muita gente ruim".
 */

const SEM_ORIGEM = '(direto / sem origem)';

/**
 * Duas leituras diferentes, de proposito:
 *
 * - `veioDoMeta`: qualquer trafego das plataformas do Meta, inclusive link
 *   na bio e organico.
 * - `veioDeAnuncio`: SO clique de anuncio pago, provado pelo fbc.
 *
 * Misturar os dois inflaria a receita atribuida ao anuncio e faria voce
 * calcular ROI para cima.
 */
const META_SOURCES = ['facebook', 'instagram', 'fb', 'ig', 'meta', 'facebook.com', 'instagram.com'];

const veioDoMeta = (order) =>
  Boolean(order.tracking?.fbc) ||
  META_SOURCES.includes(String(order.tracking?.utm?.source || '').toLowerCase());

const veioDeAnuncio = (order) => Boolean(order.tracking?.fbc);

const rotulo = (valor) => {
  const texto = String(valor ?? '').trim();
  return texto || SEM_ORIGEM;
};

/** Agrupa pedidos por uma chave e calcula o funil de cada grupo. */
function agrupar(orders, chave) {
  const mapa = new Map();

  for (const order of orders) {
    const nome = chave(order);
    const grupo = mapa.get(nome) || {
      nome,
      iniciados: 0,
      pagos: 0,
      receitaCents: 0,
      perdidoCents: 0,
    };

    grupo.iniciados += 1;
    if (order.paid) {
      grupo.pagos += 1;
      grupo.receitaCents += order.amountCents;
    } else {
      // Quanto ficou na mesa nessa origem — o alvo da recuperação.
      grupo.perdidoCents += order.amountCents;
    }

    mapa.set(nome, grupo);
  }

  return [...mapa.values()]
    .map((g) => ({
      ...g,
      receitaFormatada: formatBRL(g.receitaCents),
      perdidoFormatado: formatBRL(g.perdidoCents),
      conversao: g.iniciados ? Number(((g.pagos / g.iniciados) * 100).toFixed(1)) : 0,
      ticketCents: g.pagos ? Math.round(g.receitaCents / g.pagos) : 0,
      ticketFormatado: formatBRL(g.pagos ? Math.round(g.receitaCents / g.pagos) : 0),
    }))
    // Receita primeiro; empate desempata por volume, para nao esconder
    // campanha que traz gente mas ainda nao converteu.
    .sort((a, b) => b.receitaCents - a.receitaCents || b.iniciados - a.iniciados);
}

export function buildCampaignReport(orders, { days }) {
  const desde = Date.now() - days * 24 * 60 * 60 * 1000;
  const janela = orders.filter((o) => (o.paidAt || o.createdAt) >= desde);

  const comOrigem = janela.filter(
    (o) => o.tracking?.utm?.source || o.tracking?.utm?.campaign || o.tracking?.fbc
  );
  const semOrigem = janela.filter((o) => !comOrigem.includes(o));
  const doMeta = janela.filter(veioDoMeta);

  const totais = (lista) => {
    const pagos = lista.filter((o) => o.paid);
    const receita = pagos.reduce((t, o) => t + o.amountCents, 0);
    return {
      iniciados: lista.length,
      pagos: pagos.length,
      receitaCents: receita,
      receitaFormatada: formatBRL(receita),
      conversao: lista.length ? Number(((pagos.length / lista.length) * 100).toFixed(1)) : 0,
    };
  };

  return {
    days,
    resumo: {
      total: totais(janela),
      meta: totais(doMeta),
      anuncio: totais(janela.filter(veioDeAnuncio)),
      comOrigem: totais(comOrigem),
      semOrigem: totais(semOrigem),
      // Quantos pedidos carregam o clique do anúncio: se estiver baixo, o
      // snippet não está na landing e a atribuição está furada.
      comFbc: janela.filter((o) => o.tracking?.fbc).length,
    },
    porOrigem: agrupar(janela, (o) => rotulo(o.tracking?.utm?.source)),
    porCampanha: agrupar(
      janela.filter((o) => o.tracking?.utm?.campaign),
      (o) => rotulo(o.tracking?.utm?.campaign)
    ),
    porConjunto: agrupar(
      janela.filter((o) => o.tracking?.utm?.medium),
      (o) => rotulo(o.tracking?.utm?.medium)
    ),
    porAnuncio: agrupar(
      janela.filter((o) => o.tracking?.utm?.content),
      (o) => rotulo(o.tracking?.utm?.content)
    ),
  };
}

/**
 * Parametros de URL para colar no anuncio do Meta.
 *
 * O Meta substitui as chaves duplas pelo nome real na hora do clique. Sem
 * isso as UTMs nao chegam, e o relatorio fica vazio por mais que o pixel
 * esteja certo.
 */
export const META_URL_PARAMS =
  'utm_source=facebook' +
  '&utm_medium={{adset.name}}' +
  '&utm_campaign={{campaign.name}}' +
  '&utm_content={{ad.name}}' +
  '&utm_term={{placement}}';
