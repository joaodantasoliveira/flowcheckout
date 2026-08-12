/**
 * Geracao do QR Code a partir do codigo Pix copia e cola.
 *
 * Alguns gateways (SyncPay) devolvem so o texto do Pix, sem imagem. Aqui
 * montamos a URL de um servico externo que desenha o QR — o mesmo caminho
 * que a MisticPay usa no campo `qrcodeUrl` dela.
 *
 * Consequencia a ter em mente: quem baixa a imagem e o NAVEGADOR DO CLIENTE,
 * entao o codigo Pix passa pelo servico de QR. O codigo nao move dinheiro
 * sozinho — ele so identifica a cobranca — mas e um dado da transacao saindo
 * para um terceiro. Se um dia isso incomodar, troque QRCODE_PROVIDER para
 * "local" e a imagem passa a ser gerada aqui no servidor.
 */

const PROVIDER = (process.env.QRCODE_PROVIDER || 'externo').toLowerCase();
const SIZE = 320;

/** URL publica da imagem do QR Code para um codigo Pix. */
export function qrCodeUrlFor(pixCode) {
  if (!pixCode) return null;

  const params = new URLSearchParams({
    size: `${SIZE}x${SIZE}`,
    margin: '0',
    ecc: 'M',
    data: pixCode,
  });

  return `https://api.qrserver.com/v1/create-qr-code/?${params}`;
}

/**
 * Imagem em data URI, gerada no servidor. Usada quando QRCODE_PROVIDER=local.
 * Import dinamico: quem usa o provedor externo nao carrega a biblioteca.
 */
async function qrCodeDataUrl(pixCode) {
  const QRCode = (await import('qrcode')).default;
  return QRCode.toDataURL(pixCode, { errorCorrectionLevel: 'M', margin: 1, width: SIZE });
}

/**
 * Resolve o QR para um codigo Pix, no formato que o checkout espera.
 * Nunca lanca: sem imagem o cliente ainda paga pelo copia e cola.
 */
export async function buildQrCode(pixCode) {
  if (!pixCode) return { qrCodeBase64: null, qrcodeUrl: null };

  if (PROVIDER === 'local') {
    try {
      return { qrCodeBase64: await qrCodeDataUrl(pixCode), qrcodeUrl: null };
    } catch (err) {
      console.error('[qrcode] falha ao gerar localmente, caindo para o serviço externo:', err.message);
    }
  }

  return { qrCodeBase64: null, qrcodeUrl: qrCodeUrlFor(pixCode) };
}
